/**
 * [MACH] — heads-up display.
 *
 * Two numbers dominate everything else, because they are the game: SPEED and
 * the DAMAGE that speed would deal. The reticle is the third: it draws your
 * actual blade arc, which narrows as you accelerate. When the wedge gets thin,
 * that is the game telling you the 240-damage hit is about to be a whiff.
 */

import { CFG, speedT, damageForSpeed } from '../core/Config.js';
import { clamp01, lerp, formatNum } from '../core/Util.js';
import { attackArc } from '../shared/Combat.js';
import { DISTRICTS } from '../shared/WorldData.js';

const EL = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
};

export class HUD {
  constructor(root) {
    this.root = EL('div', 'hud', root);
    this.shownSpeed = 0;
    this.shownDamage = 0;
    this.shownHp = CFG.MAX_HEALTH;
    this.hitFlash = 0;
    this.killFeed = [];
    this.district = '';

    /* ------------------------------------------------------- speed block */
    const sb = EL('div', 'hud-speed', this.root);
    EL('div', 'hud-label', sb, 'SPEED');
    this.speedVal = EL('div', 'hud-speed-val', sb, '0');
    const bar = EL('div', 'hud-bar', sb);
    this.speedFill = EL('div', 'hud-bar-fill', bar);
    this.speedMark = EL('div', 'hud-bar-max', bar, '');
    const foot = EL('div', 'hud-speed-foot', sb);
    EL('span', 'dim', foot, 'MAX');
    EL('span', 'hud-max', foot, String(CFG.MAX_SPEED));

    /* ------------------------------------------------------ damage block */
    const db = EL('div', 'hud-damage', this.root);
    EL('div', 'hud-label', db, 'DAMAGE ON HIT');
    this.dmgVal = EL('div', 'hud-dmg-val', db, '0');
    EL('div', 'hud-formula', db, `SPEED &times; ${CFG.DAMAGE_MULTIPLIER}`);

    /* ------------------------------------------------------------ health */
    const hb = EL('div', 'hud-health', this.root);
    const hrow = EL('div', 'hud-health-row', hb);
    this.hpVal = EL('div', 'hud-hp-val', hrow, String(CFG.MAX_HEALTH));
    EL('div', 'hud-hp-max', hrow, `/ ${CFG.MAX_HEALTH}`);
    const hbar = EL('div', 'hud-bar tall', hb);
    this.hpGhost = EL('div', 'hud-bar-ghost', hbar);
    this.hpFill = EL('div', 'hud-bar-fill hp', hbar);
    this.hpLabel = EL('div', 'hud-label right', hb, 'HEALTH');

    /* ---------------------------------------------------------- reticle */
    this.retWrap = EL('div', 'hud-reticle', this.root);
    this.ret = document.createElement('canvas');
    this.ret.width = this.ret.height = 220;
    this.retWrap.appendChild(this.ret);
    this.retCtx = this.ret.getContext('2d');
    this.hitMark = EL('div', 'hitmark', this.retWrap, '<i></i><i></i><i></i><i></i>');

    /* -------------------------------------------------------- kill feed */
    this.feed = EL('div', 'hud-feed', this.root);

    /* ------------------------------------------------------------ status */
    this.status = EL('div', 'hud-status', this.root);
    this.banner = EL('div', 'hud-banner', this.root);
    this.credits = EL('div', 'hud-credits', this.root, '<span class="dim">CR</span><b>0</b>');
    this.creditsVal = this.credits.querySelector('b');
    this.districtEl = EL('div', 'hud-district', this.root, '');
    this.score = EL('div', 'hud-score', this.root, '');
    this.netEl = EL('div', 'hud-net', this.root, '');

    this.respawn = EL('div', 'respawn hidden', this.root);
    this.respawnTitle = EL('div', 'respawn-title', this.respawn, 'DOWN');
    this.respawnBy = EL('div', 'respawn-by', this.respawn, '');
    this.respawnTimer = EL('div', 'respawn-timer', this.respawn, '');
  }

  setVisible(v) { this.root.style.display = v ? '' : 'none'; }

  hit(dmg) {
    this.hitFlash = 1;
    this.hitMark.classList.remove('go');
    void this.hitMark.offsetWidth;
    this.hitMark.classList.add('go');
    this.hitMark.style.setProperty('--h', String(clamp01(dmg / 250)));
  }

  pushFeed(text, cls) {
    const el = EL('div', 'feed-line ' + (cls || ''), null, text);
    this.feed.insertBefore(el, this.feed.firstChild);
    this.killFeed.push({ el, t: 6 });
    while (this.feed.children.length > 6) this.feed.removeChild(this.feed.lastChild);
  }

  showBanner(text, cls, time = 1.6) {
    this.banner.textContent = text;
    this.banner.className = 'hud-banner show ' + (cls || '');
    this._bannerT = time;
  }

  setStatus(text, cls) {
    this.status.textContent = text || '';
    this.status.className = 'hud-status' + (text ? ' show ' : ' ') + (cls || '');
  }

  setRespawn(active, killer, seconds) {
    this.respawn.classList.toggle('hidden', !active);
    if (active) {
      this.respawnBy.textContent = killer ? `CUT DOWN BY ${killer}` : 'ELIMINATED';
      this.respawnTimer.textContent = seconds > 0 ? seconds.toFixed(1) : 'RESPAWNING';
    }
  }

  setNet(text) { this.netEl.textContent = text; }

  setScore(rows, selfId) {
    const top = rows.slice(0, 5).map((r) => {
      const me = r.id === selfId ? ' me' : '';
      return `<div class="score-row${me}"><span class="n">${r.name}</span><span class="k">${r.kills}</span><span class="d">${r.deaths}</span></div>`;
    }).join('');
    this.score.innerHTML = `<div class="score-head"><span class="n">RUNNER</span><span class="k">K</span><span class="d">D</span></div>${top}`;
  }

  update(dt, st) {
    /* -------- numbers: smoothed so they read as motion, not as flicker */
    const k = 1 - Math.exp(-16 * dt);
    this.shownSpeed += (st.speed - this.shownSpeed) * k;
    const dmg = damageForSpeed(st.speed);
    this.shownDamage += (dmg - this.shownDamage) * k;
    this.shownHp += (st.hp - this.shownHp) * (1 - Math.exp(-9 * dt));

    const t = speedT(this.shownSpeed);
    this.speedVal.textContent = Math.round(this.shownSpeed);
    this.speedVal.style.setProperty('--t', t.toFixed(3));
    this.speedFill.style.width = (t * 100).toFixed(1) + '%';
    this.dmgVal.textContent = Math.round(this.shownDamage);
    this.dmgVal.style.setProperty('--t', t.toFixed(3));

    const hpT = clamp01(st.hp / CFG.MAX_HEALTH);
    this.hpVal.textContent = Math.max(0, Math.round(st.hp));
    this.hpFill.style.width = (hpT * 100).toFixed(1) + '%';
    this.hpGhost.style.width = (clamp01(this.shownHp / CFG.MAX_HEALTH) * 100).toFixed(1) + '%';
    this.root.classList.toggle('critical', hpT < 0.35);

    this.creditsVal.textContent = formatNum(st.credits || 0);

    /* -------- district callout */
    let best = null, bestD = Infinity;
    for (const d of DISTRICTS) {
      const dd = Math.hypot(d.x - st.x, d.z - st.z) - d.r;
      if (dd < bestD) { bestD = dd; best = d; }
    }
    if (best && best.name !== this.district) {
      this.district = best.name;
      this.districtEl.innerHTML = `<b>${best.name}</b><span>${best.tag}</span>`;
      this.districtEl.classList.remove('go');
      void this.districtEl.offsetWidth;
      this.districtEl.classList.add('go');
    }

    if (this._bannerT > 0) {
      this._bannerT -= dt;
      if (this._bannerT <= 0) this.banner.className = 'hud-banner';
    }
    for (let i = this.killFeed.length - 1; i >= 0; i--) {
      const f = this.killFeed[i];
      f.t -= dt;
      if (f.t <= 0) { f.el.classList.add('gone'); this.killFeed.splice(i, 1); }
    }

    this.hitFlash = Math.max(0, this.hitFlash - dt * 3);
    this._drawReticle(st);
  }

  /** The reticle IS the hit arc. Watch it close as you accelerate. */
  _drawReticle(st) {
    const g = this.retCtx;
    const S = this.ret.width;
    const cx = S / 2, cy = S / 2;
    g.clearRect(0, 0, S, S);

    const arc = attackArc(st.speed);
    const t = speedT(st.speed);
    const half = arc.halfAngle;
    const R = 26 + (arc.reach - CFG.REACH_HIGH) * 0.9 + 44;

    const danger = st.vulnerable;
    const winding = st.attacking;

    // Wedge.
    const col = danger ? '226,58,46' : winding ? '242,197,17' : '243,244,246';
    g.save();
    g.translate(cx, cy);
    g.rotate(-Math.PI / 2);

    g.beginPath();
    g.moveTo(0, 0);
    g.arc(0, 0, R, -half, half);
    g.closePath();
    g.fillStyle = `rgba(${col},${0.05 + t * 0.07})`;
    g.fill();

    g.lineWidth = 2;
    g.strokeStyle = `rgba(${col},${0.55 + this.hitFlash * 0.45})`;
    g.beginPath();
    g.moveTo(Math.cos(-half) * 12, Math.sin(-half) * 12);
    g.lineTo(Math.cos(-half) * R, Math.sin(-half) * R);
    g.moveTo(Math.cos(half) * 12, Math.sin(half) * 12);
    g.lineTo(Math.cos(half) * R, Math.sin(half) * R);
    g.stroke();

    g.lineWidth = 3;
    g.beginPath();
    g.arc(0, 0, R, -half, half);
    g.strokeStyle = `rgba(${col},${0.75 + this.hitFlash * 0.25})`;
    g.stroke();

    // Reach ticks.
    g.lineWidth = 1;
    g.strokeStyle = `rgba(${col},0.35)`;
    for (const a of [-half, half]) {
      g.beginPath();
      g.moveTo(Math.cos(a) * (R - 6), Math.sin(a) * (R - 6));
      g.lineTo(Math.cos(a) * (R + 6), Math.sin(a) * (R + 6));
      g.stroke();
    }
    g.restore();

    // Centre dot.
    g.fillStyle = `rgba(${col},0.95)`;
    g.fillRect(cx - 1.5, cy - 1.5, 3, 3);
    g.fillStyle = `rgba(${col},0.5)`;
    g.fillRect(cx - 7, cy - 0.5, 4, 1);
    g.fillRect(cx + 3, cy - 0.5, 4, 1);
  }
}

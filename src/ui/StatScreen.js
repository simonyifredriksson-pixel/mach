/**
 * [MACH] — stat screen (hold TAB).
 *
 * Layout borrows the reference's discipline: hard black slabs, one accent,
 * ruthless hierarchy. SPEED and DAMAGE are set at display size because they are
 * the mechanic; everything else is support.
 */

import { CFG, speedT, damageForSpeed } from '../core/Config.js';
import { clamp01, formatNum, formatTime } from '../core/Util.js';

const EL = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
};

function statCell(parent, label, id) {
  const c = EL('div', 'st-cell', parent);
  EL('div', 'st-cell-label', c, label);
  const v = EL('div', 'st-cell-val', c, '0');
  v.dataset.id = id;
  return v;
}

export class StatScreen {
  constructor(root, profile) {
    this.profile = profile;
    this.el = EL('div', 'statscreen hidden', root);
    this.visible = false;

    const wrap = EL('div', 'st-wrap', this.el);

    /* --------------------------------------------------------- headline */
    const head = EL('div', 'st-head', wrap);
    EL('div', 'st-title', head, 'VELOCITY RONIN');
    EL('div', 'st-sub', head, 'MERIDIAN DISTRICT &middot; LIVE TELEMETRY');
    this.headName = EL('div', 'st-name', head, 'RUNNER');

    /* ------------------------------------------------------ core numbers */
    const core = EL('div', 'st-core', wrap);

    const sp = EL('div', 'st-big speed', core);
    EL('div', 'st-big-label', sp, 'SPEED');
    this.speed = EL('div', 'st-big-val', sp, '0');
    const spBar = EL('div', 'st-bar', sp);
    this.speedFill = EL('div', 'st-bar-fill', spBar);
    EL('div', 'st-big-foot', sp, `MAX SPEED <b>${CFG.MAX_SPEED}</b>`);

    const dm = EL('div', 'st-big damage', core);
    EL('div', 'st-big-label', dm, 'DAMAGE');
    this.damage = EL('div', 'st-big-val', dm, '0');
    const dmBar = EL('div', 'st-bar', dm);
    this.damageFill = EL('div', 'st-bar-fill dmg', dmBar);
    EL('div', 'st-big-foot', dm, `FORMULA <b>SPEED &times; ${CFG.DAMAGE_MULTIPLIER}</b>`);

    const hp = EL('div', 'st-big health', core);
    EL('div', 'st-big-label', hp, 'HEALTH');
    this.health = EL('div', 'st-big-val', hp, String(CFG.MAX_HEALTH));
    const hpBar = EL('div', 'st-bar', hp);
    this.healthFill = EL('div', 'st-bar-fill hp', hpBar);
    this.healthFoot = EL('div', 'st-big-foot', hp, `OF <b>${CFG.MAX_HEALTH}</b>`);

    /* ------------------------------------------------------- match stats */
    const cols = EL('div', 'st-cols', wrap);

    const matchBox = EL('div', 'st-box', cols);
    EL('div', 'st-box-head', matchBox, 'THIS MATCH');
    const mg = EL('div', 'st-grid', matchBox);
    this.m = {
      kills: statCell(mg, 'KILLS', 'kills'),
      deaths: statCell(mg, 'DEATHS', 'deaths'),
      kd: statCell(mg, 'K / D', 'kd'),
      streak: statCell(mg, 'STREAK', 'streak'),
      top: statCell(mg, 'TOP SPEED', 'top'),
      best: statCell(mg, 'BEST HIT', 'best'),
      dmg: statCell(mg, 'TOTAL DAMAGE', 'dmg'),
      acc: statCell(mg, 'ACCURACY', 'acc'),
    };

    const careerBox = EL('div', 'st-box', cols);
    EL('div', 'st-box-head', careerBox, 'CAREER');
    const cg = EL('div', 'st-grid', careerBox);
    this.c = {
      kills: statCell(cg, 'TOTAL KILLS', 'ckills'),
      kd: statCell(cg, 'LIFETIME K/D', 'ckd'),
      matches: statCell(cg, 'MATCHES', 'cmatches'),
      time: statCell(cg, 'PLAY TIME', 'ctime'),
      top: statCell(cg, 'HIGHEST SPEED', 'ctop'),
      best: statCell(cg, 'BIGGEST HIT', 'cbest'),
      dmg: statCell(cg, 'DAMAGE DEALT', 'cdmg'),
      crates: statCell(cg, 'CRATES OPENED', 'ccrates'),
    };

    const boardBox = EL('div', 'st-box wide', cols);
    EL('div', 'st-box-head', boardBox, 'SCOREBOARD');
    this.board = EL('div', 'st-board', boardBox);

    EL('div', 'st-footer', wrap,
      '<b>SHIFT</b> SPRINT &nbsp;&middot;&nbsp; <b>SPACE</b> JUMP / WALL KICK &nbsp;&middot;&nbsp; <b>CTRL</b> SLIDE &nbsp;&middot;&nbsp; <b>G</b> GRAPPLE / RELEASE &nbsp;&middot;&nbsp; <b>LMB</b> SLASH &nbsp;&middot;&nbsp; <b>R</b> DRAW / SHEATHE');
    EL('div', 'st-footer', wrap,
      'JUMP ALONGSIDE A WALL TO <b>WALL-RUN</b> &nbsp;&middot;&nbsp; INTO ONE HEAD-ON TO <b>CLIMB</b> &nbsp;&middot;&nbsp; LOW LEDGES <b>VAULT</b> AUTOMATICALLY');
  }

  show(v) {
    this.visible = v;
    this.el.classList.toggle('hidden', !v);
  }

  update(st, board, selfId) {
    if (!this.visible) return;
    const t = speedT(st.speed);
    this.headName.textContent = this.profile.name;
    this.speed.textContent = Math.round(st.speed);
    this.speedFill.style.width = (t * 100).toFixed(1) + '%';
    const dmg = damageForSpeed(st.speed);
    this.damage.textContent = Math.round(dmg);
    this.damageFill.style.width = (t * 100).toFixed(1) + '%';
    this.health.textContent = Math.max(0, Math.round(st.hp));
    this.healthFill.style.width = (clamp01(st.hp / CFG.MAX_HEALTH) * 100).toFixed(1) + '%';

    const m = st.match || {};
    this.m.kills.textContent = m.kills || 0;
    this.m.deaths.textContent = m.deaths || 0;
    this.m.kd.textContent = (m.deaths ? (m.kills / m.deaths) : (m.kills || 0)).toFixed(2);
    this.m.streak.textContent = m.streak || 0;
    this.m.top.textContent = Math.round(m.topSpeed || 0);
    this.m.best.textContent = Math.round(m.bestHit || 0);
    this.m.dmg.textContent = formatNum(m.damageDealt || 0);
    this.m.acc.textContent = ((m.swings ? (m.hits / m.swings) : 0) * 100).toFixed(0) + '%';

    const p = this.profile.stats;
    this.c.kills.textContent = formatNum(p.kills);
    this.c.kd.textContent = this.profile.kd.toFixed(2);
    this.c.matches.textContent = formatNum(p.matches);
    this.c.time.textContent = formatTime(p.playTime);
    this.c.top.textContent = Math.round(p.topSpeed);
    this.c.best.textContent = Math.round(p.bestHit);
    this.c.dmg.textContent = formatNum(p.damageDealt);
    this.c.crates.textContent = formatNum(p.cratesOpened);

    if (board) {
      this.board.innerHTML = `<div class="stb-row head"><span>#</span><span>RUNNER</span><span>K</span><span>D</span><span>DMG</span><span>TOP</span><span>BEST</span></div>` +
        board.map((r, i) => `<div class="stb-row${r.id === selfId ? ' me' : ''}${r.alive ? '' : ' down'}">
          <span>${i + 1}</span><span class="nm">${r.name}${r.bot ? '<i>BOT</i>' : ''}</span>
          <span>${r.kills}</span><span>${r.deaths}</span><span>${formatNum(r.damage)}</span>
          <span>${r.topSpeed}</span><span>${r.bestHit}</span></div>`).join('');
    }
  }
}

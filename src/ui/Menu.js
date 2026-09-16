/**
 * [MACH] — front end: main menu, locker, settings.
 *
 * Visual language lifted from hard-edged comic key art: black slabs, condensed
 * caps, one hot accent, halftone. The left third is intentionally empty — the
 * live 3D runner stands there.
 */

import { Emitter, formatNum, formatTime, clamp } from '../core/Util.js';
import { CATALOG, TYPE_LABEL, getItem } from '../economy/Cosmetics.js';
import { RARITY } from '../economy/Rarity.js';
import { CRATES } from '../economy/Crates.js';
import { iconFor } from './Icons.js';

const EL = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
};

const TYPE_ORDER = ['katana', 'skin', 'trail', 'slash', 'kill', 'spawn', 'sheath'];

export class Menu extends Emitter {
  constructor(root, profile, audio) {
    super();
    this.profile = profile;
    this.audio = audio;
    this.el = EL('div', 'menu', root);
    this.panel = null;

    EL('div', 'menu-bg', this.el);
    EL('div', 'menu-halftone', this.el);

    const main = EL('div', 'menu-main', this.el);

    const titleWrap = EL('div', 'menu-title-wrap', main);
    EL('div', 'menu-title', titleWrap, 'VELOCITY<br><span>RONIN</span>');
    EL('div', 'menu-tagline', titleWrap, 'SPEED IS DAMAGE');
    EL('div', 'menu-formula', titleWrap, 'DAMAGE = SPEED &times; 0.5 &nbsp;&middot;&nbsp; MAX 500 &nbsp;&middot;&nbsp; <b>G</b> TO GRAPPLE');

    this.nav = EL('div', 'menu-nav', main);
    this.items = [];
    this._navItem('PLAY', 'play', true);
    this._navItem('LOADOUT', 'locker');
    this._navItem('SUPPLY CASES', 'crates');
    this._navItem('CAREER', 'stats');
    this._navItem('SETTINGS', 'openSettings');

    const foot = EL('div', 'menu-foot', this.el);
    this.footCredits = EL('div', 'menu-cr', foot, '');
    EL('div', 'menu-version', foot, 'BUILD 1.0 &middot; MERIDIAN DISTRICT');
    this.footTip = EL('div', 'menu-tip', foot, '');

    this.panelHost = EL('div', 'panel-host hidden', root);

    profile.on('credits', () => this.refresh());
    this.refresh();
  }

  _navItem(label, action, primary) {
    const b = EL('button', 'nav-item' + (primary ? ' primary' : ''), this.nav);
    EL('span', 'nav-label', b, label);
    EL('span', 'nav-key', b, '');
    b.onmouseenter = () => this.audio.ui('hover');
    b.onclick = () => { this.audio.ui('click'); this.emit(action); };
    this.items.push(b);
    return b;
  }

  refresh() {
    const p = this.profile;
    const col = p.collectionProgress();
    this.footCredits.innerHTML = `<span class="dim">CREDITS</span> <b>${formatNum(p.credits)}</b>
      &nbsp;&nbsp;<span class="dim">COLLECTION</span> <b>${col.owned}/${col.total}</b>`;
    this.footTip.textContent = TIPS[Math.floor(Math.random() * TIPS.length)];
  }

  show() { this.el.classList.remove('hidden'); this.refresh(); }
  hide() { this.el.classList.add('hidden'); this.closePanel(); }

  /* ------------------------------------------------------------- panels */

  openPanel(builder) {
    this.panelHost.classList.remove('hidden');
    this.panelHost.innerHTML = '';
    builder(this.panelHost);
  }

  closePanel() {
    this.panelHost.classList.add('hidden');
    this.panelHost.innerHTML = '';
  }

  /* ------------------------------------------------------------- locker */

  showLocker() {
    this.openPanel((host) => {
      const p = EL('div', 'panel locker', host);
      const head = EL('div', 'panel-head', p);
      EL('div', 'panel-title', head, 'LOADOUT');
      const close = EL('button', 'btn ghost', head, 'BACK');
      close.onclick = () => { this.audio.ui('back'); this.closePanel(); };

      const tabs = EL('div', 'lk-tabs', p);
      const grid = EL('div', 'lk-grid', p);
      const detail = EL('div', 'lk-detail', p);

      let active = 'katana';
      const renderDetail = (item) => {
        const r = RARITY[item.rarity];
        const owned = this.profile.owns(item.type, item.id);
        const src = item.crate ? CRATES[item.crate] : null;
        detail.style.setProperty('--rc', r.color);
        detail.innerHTML = `
          <img class="lkd-icon" src="${iconFor(item)}">
          <div class="lkd-body">
            <div class="lkd-rar">${r.name}</div>
            <div class="lkd-name">${item.name}</div>
            <div class="lkd-type">${TYPE_LABEL[item.type]}</div>
            <div class="lkd-lore">${item.lore}</div>
            <div class="lkd-src">${owned ? 'OWNED' : src ? `FOUND IN ${src.name}` : 'NOT OBTAINABLE FROM CASES'}</div>
          </div>`;
        const btn = EL('button', 'btn primary lkd-equip', detail, owned ? 'EQUIP' : 'LOCKED');
        btn.disabled = !owned;
        if (this.profile.loadout[item.type] === item.id) { btn.textContent = 'EQUIPPED'; btn.disabled = true; }
        btn.onclick = () => {
          if (this.profile.equip(item.type, item.id)) {
            this.audio.ui('equip');
            this.emit('loadout', this.profile.loadout);
            renderGrid();
            renderDetail(item);
          }
        };
      };

      const renderGrid = () => {
        grid.innerHTML = '';
        const table = CATALOG[active];
        for (const item of Object.values(table)) {
          const owned = this.profile.owns(item.type, item.id);
          const eq = this.profile.loadout[item.type] === item.id;
          const r = RARITY[item.rarity];
          const cell = EL('div', 'lk-item' + (owned ? '' : ' locked') + (eq ? ' equipped' : ''), grid);
          cell.style.setProperty('--rc', r.color);
          cell.innerHTML = `<img src="${iconFor(item)}" alt="">
            <div class="lki-name">${owned ? item.name : '???'}</div>
            <div class="lki-rar">${r.name}</div>
            ${eq ? '<div class="lki-eq">EQUIPPED</div>' : ''}`;
          cell.onclick = () => { this.audio.ui('click'); renderDetail(item); };
          cell.onmouseenter = () => this.audio.ui('hover');
        }
      };

      for (const t of TYPE_ORDER) {
        const b = EL('button', 'lk-tab' + (t === active ? ' on' : ''), tabs, TYPE_LABEL[t]);
        b.onclick = () => {
          active = t;
          this.audio.ui('click');
          [...tabs.children].forEach((c) => c.classList.toggle('on', c === b));
          renderGrid();
          renderDetail(getItem(t, this.profile.loadout[t]));
        };
      }
      renderGrid();
      renderDetail(getItem(active, this.profile.loadout[active]));
    });
  }

  /* ----------------------------------------------------------- settings */

  showSettings() {
    this.openPanel((host) => {
      const s = this.profile.settings;
      const p = EL('div', 'panel settings', host);
      const head = EL('div', 'panel-head', p);
      EL('div', 'panel-title', head, 'SETTINGS');
      const close = EL('button', 'btn ghost', head, 'BACK');
      close.onclick = () => { this.audio.ui('back'); this.profile.save(); this.closePanel(); };

      const body = EL('div', 'set-body', p);
      const group = (title) => { EL('div', 'set-group', body, title); return body; };

      const slider = (label, key, min, max, step, fmt) => {
        const row = EL('div', 'set-row', body);
        EL('label', '', row, label);
        const input = EL('input', '', row);
        input.type = 'range'; input.min = min; input.max = max; input.step = step;
        input.value = s[key];
        const out = EL('span', 'set-val', row, fmt ? fmt(s[key]) : s[key]);
        input.oninput = () => {
          s[key] = parseFloat(input.value);
          out.textContent = fmt ? fmt(s[key]) : s[key];
          this.emit('settings', s);
        };
        input.onchange = () => { this.profile.save(); this.audio.ui('click'); };
      };

      const toggle = (label, key) => {
        const row = EL('div', 'set-row', body);
        EL('label', '', row, label);
        const b = EL('button', 'set-toggle' + (s[key] ? ' on' : ''), row, s[key] ? 'ON' : 'OFF');
        b.onclick = () => {
          s[key] = !s[key];
          b.classList.toggle('on', s[key]);
          b.textContent = s[key] ? 'ON' : 'OFF';
          this.audio.ui('click');
          this.emit('settings', s);
          this.profile.save();
        };
      };

      group('INPUT');
      slider('MOUSE SENSITIVITY', 'sensitivity', 0.2, 3, 0.05, (v) => v.toFixed(2));
      toggle('INVERT VERTICAL', 'invertY');

      group('CAMERA');
      slider('EXTRA FOV', 'fov', -10, 25, 1, (v) => (v > 0 ? '+' : '') + v);
      slider('CAMERA SHAKE', 'shake', 0, 1.5, 0.05, (v) => Math.round(v * 100) + '%');

      group('SPEED EFFECTS');
      slider('MOTION BLUR', 'motionBlur', 0, 1.5, 0.05, (v) => Math.round(v * 100) + '%');
      slider('SPEED LINES', 'speedLines', 0, 1.5, 0.05, (v) => Math.round(v * 100) + '%');
      toggle('DAMAGE NUMBERS', 'showDamage');

      group('AUDIO');
      slider('MASTER', 'master', 0, 1, 0.02, (v) => Math.round(v * 100) + '%');
      slider('EFFECTS', 'sfx', 0, 1, 0.02, (v) => Math.round(v * 100) + '%');
      slider('MUSIC', 'music', 0, 1, 0.02, (v) => Math.round(v * 100) + '%');

      group('PROFILE');
      const nameRow = EL('div', 'set-row', body);
      EL('label', '', nameRow, 'CALLSIGN');
      const nameInput = EL('input', 'set-text', nameRow);
      nameInput.type = 'text'; nameInput.maxLength = 12; nameInput.value = this.profile.name;
      nameInput.oninput = () => {
        this.profile.name = nameInput.value.toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 12) || 'RUNNER';
        nameInput.value = this.profile.name;
        this.profile.save();
      };

      const dangerRow = EL('div', 'set-row danger', body);
      EL('label', '', dangerRow, 'RESET EVERYTHING');
      const rb = EL('button', 'btn ghost danger', dangerRow, 'WIPE PROFILE');
      let armed = false;
      rb.onclick = () => {
        if (!armed) { armed = true; rb.textContent = 'ARE YOU SURE?'; this.audio.ui('error'); setTimeout(() => { armed = false; rb.textContent = 'WIPE PROFILE'; }, 3000); return; }
        this.profile.reset();
        this.audio.ui('back');
        this.closePanel();
        this.emit('loadout', this.profile.loadout);
        this.refresh();
      };
    });
  }

  /* ------------------------------------------------------------- career */

  showCareer() {
    this.openPanel((host) => {
      const st = this.profile.stats;
      const p = EL('div', 'panel career', host);
      const head = EL('div', 'panel-head', p);
      EL('div', 'panel-title', head, 'CAREER');
      const close = EL('button', 'btn ghost', head, 'BACK');
      close.onclick = () => { this.audio.ui('back'); this.closePanel(); };

      const cell = (label, value, big) =>
        `<div class="cr-stat${big ? ' big' : ''}"><div class="cs-label">${label}</div><div class="cs-val">${value}</div></div>`;

      const col = this.profile.collectionProgress();
      EL('div', 'career-grid', p,
        cell('HIGHEST SPEED', Math.round(st.topSpeed), true) +
        cell('BIGGEST HIT', Math.round(st.bestHit), true) +
        cell('AT SPEED', Math.round(st.bestHitSpeed)) +
        cell('TOTAL KILLS', formatNum(st.kills)) +
        cell('DEATHS', formatNum(st.deaths)) +
        cell('K / D', this.profile.kd.toFixed(2)) +
        cell('BEST STREAK', st.bestStreak) +
        cell('ACCURACY', Math.round(this.profile.accuracy * 100) + '%') +
        cell('TOTAL DAMAGE', formatNum(st.damageDealt)) +
        cell('DAMAGE TAKEN', formatNum(st.damageTaken)) +
        cell('MATCHES', formatNum(st.matches)) +
        cell('PLAY TIME', formatTime(st.playTime)) +
        cell('DISTANCE RUN', formatNum(st.distance / 10) + ' m') +
        cell('CREDITS EARNED', formatNum(st.creditsEarned)) +
        cell('CASES OPENED', formatNum(st.cratesOpened)) +
        cell('??? FOUND', st.secrets));

      EL('div', 'career-coll', p,
        `<div class="cc-head">COLLECTION <b>${col.owned} / ${col.total}</b></div>
         <div class="cc-bar"><i style="width:${(col.pct * 100).toFixed(1)}%"></i></div>`);

      const hist = EL('div', 'career-hist', p);
      EL('div', 'ch-head', hist, 'RECENT UNBOXES');
      if (!this.profile.history.length) EL('div', 'ch-empty', hist, 'Nothing yet. Go earn some credits.');
      for (const h of this.profile.history.slice(0, 12)) {
        const item = getItem(h.type, h.id);
        const r = RARITY[h.rarity];
        const row = EL('div', 'ch-row', hist);
        row.style.setProperty('--rc', r.color);
        row.innerHTML = `<img src="${iconFor(item)}"><span class="chr">${r.name}</span>
          <span class="chn">${item.name}</span><span class="cht">${TYPE_LABEL[item.type]}</span>
          ${h.dupe ? '<span class="chd">DUPLICATE</span>' : ''}`;
      }
    });
  }
}

const TIPS = [
  'TIP: Jump alongside a wall to wall-run. Jump again to kick off it — you keep the whole run.',
  'TIP: Run straight at a wall in the air and hold forward: you will climb it. Height costs speed.',
  'TIP: CTRL slides. Downhill it accelerates, flat it coasts, and hopping out of one loses nothing.',
  'TIP: Low ledges vault automatically. You are never meant to stop moving.',
  'TIP: Sprint, jump, wall-run, kick, grapple, release. One line, one unbroken velocity.',
  'TIP: Press G to grapple. Release with G again — you keep every unit of momentum you built.',
  'TIP: Sprint, jump, grapple a roof, release at the top of the arc. That is the whole game.',
  'TIP: The G on your reticle lights up when something in front of you can be hooked.',
  'TIP: Hit someone above 350 speed and you will feel it. So will they.',
  'TIP: A grapple swing is a pendulum. Let it carry you instead of fighting it.',
  'TIP: Missing a swing costs you half a second of steering. At 400 that is 200 units of nothing.',
  'TIP: The reticle wedge is your real hit arc. If it is thin, you need to be right.',
  'TIP: Ramps and the hill road feed gravity into your speed. Downhill is free damage.',
  'TIP: A skilled runner at 200 beats a careless one at 450. Control is the stat.',
  'TIP: Sheathed? Your first swing is an iai draw — slower to start, longer reach into the cut.',
  'TIP: Slow down before the alleys. Downtown will kill you faster than anybody in it.',
  'TIP: Speed carries through jumps. Airborne, you barely steer at all.',
  'TIP: Hit for 250 and it is a one-shot. That requires exactly 500 speed. Good luck.',
];

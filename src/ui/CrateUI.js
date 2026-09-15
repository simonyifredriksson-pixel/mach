/**
 * [MACH] — crate interface.
 *
 * Earned credits only. Cosmetics only. Odds printed on the tin.
 *
 * The reel is deliberately honest: `roll()` decides the reward BEFORE the
 * animation starts, and the strip is then built around that result. Nothing you
 * do during the spin changes anything — the drama is presentation, not a
 * near-miss engine.
 *
 * Reveal escalates by tier. ??? does not escalate: it stops the show.
 */

import { RARITY, RARITY_ORDER, oneIn } from '../economy/Rarity.js';
import { CRATES, CRATE_ORDER, cratePool, crateContents, roll, buildReel, itemValue } from '../economy/Crates.js';
import { TYPE_LABEL } from '../economy/Cosmetics.js';
import { iconFor, crateArt } from './Icons.js';
import { formatNum, clamp01, Emitter } from '../core/Util.js';

const EL = (tag, cls, parent, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html !== undefined) e.innerHTML = html;
  if (parent) parent.appendChild(e);
  return e;
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TILE = 148;   // tile width + gap, must match CSS

export class CrateUI extends Emitter {
  constructor(root, profile, audio) {
    super();
    this.profile = profile;
    this.audio = audio;
    this.el = EL('div', 'crates hidden', root);
    this.busy = false;

    const head = EL('div', 'cr-head', this.el);
    EL('div', 'cr-title', head, 'SUPPLY CASES');
    const wallet = EL('div', 'cr-wallet', head);
    EL('span', 'dim', wallet, 'CREDITS');
    this.walletVal = EL('b', '', wallet, '0');
    this.backBtn = EL('button', 'btn ghost', head, 'BACK');
    this.backBtn.onclick = () => { this.audio.ui('back'); this.emit('exit'); };

    EL('div', 'cr-note', this.el,
      'Cosmetic rewards only. Nothing in a case changes speed, damage, reach or health. Credits are earned by playing.');

    this.grid = EL('div', 'cr-grid', this.el);
    this._buildGrid();

    /* ---------------------------------------------------- inspect panel */
    this.inspect = EL('div', 'cr-inspect hidden', this.el);

    /* -------------------------------------------------------- open view */
    this.stage = EL('div', 'cr-stage hidden', root);
    this.stageInner = EL('div', 'cr-stage-inner', this.stage);
    this.crateArt = EL('div', 'cr-bigcrate', this.stageInner);
    this.reelWrap = EL('div', 'cr-reel-wrap', this.stageInner);
    this.reel = EL('div', 'cr-reel', this.reelWrap);
    EL('div', 'cr-marker', this.reelWrap);
    this.revealCard = EL('div', 'cr-reveal hidden', this.stageInner);
    this.stageHint = EL('div', 'cr-hint', this.stageInner, '');
    this.secretLayer = EL('div', 'cr-secret hidden', this.stage);
  }

  /* --------------------------------------------------------------- grid */

  _buildGrid() {
    this.grid.innerHTML = '';
    for (const id of CRATE_ORDER) {
      const c = CRATES[id];
      const card = EL('div', 'cr-card', this.grid);
      card.style.setProperty('--accent', c.accent);
      const art = EL('div', 'cr-art', card);
      art.style.backgroundImage = `url(${crateArt(c)})`;
      EL('div', 'cr-district', card, c.district);
      EL('div', 'cr-name', card, c.name);
      EL('div', 'cr-blurb', card, c.blurb);

      const odds = EL('div', 'cr-odds', card);
      for (const r of RARITY_ORDER) {
        const n = cratePool(id)[r].length;
        odds.innerHTML += `<div class="cr-odd${n ? '' : ' empty'}"><i style="background:${RARITY[r].color}"></i>
          <span>${RARITY[r].name}</span><b>${RARITY[r].odds}%</b></div>`;
      }

      const row = EL('div', 'cr-actions', card);
      const openBtn = EL('button', 'btn primary', row, `OPEN &nbsp;<b>${formatNum(c.price)}</b>`);
      const inspectBtn = EL('button', 'btn ghost', row, 'INSPECT');
      openBtn.onclick = () => this.tryOpen(id);
      inspectBtn.onclick = () => { this.audio.ui('click'); this.showInspect(id); };
      card.dataset.crate = id;
    }
    this._refreshWallet();
  }

  _refreshWallet() {
    this.walletVal.textContent = formatNum(this.profile.credits);
    for (const card of this.grid.children) {
      const c = CRATES[card.dataset.crate];
      card.classList.toggle('poor', this.profile.credits < c.price);
    }
  }

  /* ------------------------------------------------------------ inspect */

  showInspect(crateId) {
    const c = CRATES[crateId];
    const items = crateContents(crateId);
    this.inspect.classList.remove('hidden');
    this.inspect.style.setProperty('--accent', c.accent);
    this.inspect.innerHTML = `
      <div class="ins-head">
        <div>
          <div class="ins-name">${c.name}</div>
          <div class="ins-sub">${c.district} &middot; ${items.length} POSSIBLE REWARDS &middot; ALL COSMETIC</div>
        </div>
        <button class="btn ghost ins-close">CLOSE</button>
      </div>
      <div class="ins-odds">${RARITY_ORDER.map((r) => `
        <div class="ins-odd"><i style="background:${RARITY[r].color}"></i>
          <span>${RARITY[r].name}</span><b>${RARITY[r].odds}%</b><em>1 in ${formatNum(oneIn(r))}</em></div>`).join('')}
      </div>
      <div class="ins-list"></div>`;
    this.inspect.querySelector('.ins-close').onclick = () => {
      this.audio.ui('back');
      this.inspect.classList.add('hidden');
    };
    const list = this.inspect.querySelector('.ins-list');
    for (const it of items) {
      const r = RARITY[it.rarity];
      const owned = this.profile.owns(it.type, it.id);
      const card = EL('div', 'ins-item' + (owned ? ' owned' : ''), list);
      card.style.setProperty('--rc', r.color);
      card.innerHTML = `
        <img src="${iconFor(it)}" alt="">
        <div class="ii-body">
          <div class="ii-rar">${r.name}</div>
          <div class="ii-name">${it.name}</div>
          <div class="ii-type">${TYPE_LABEL[it.type]}</div>
          <div class="ii-lore">${it.lore}</div>
        </div>
        ${owned ? '<div class="ii-owned">OWNED</div>' : ''}`;
    }
  }

  /* --------------------------------------------------------------- open */

  async tryOpen(crateId) {
    if (this.busy) return;
    const c = CRATES[crateId];
    if (this.profile.credits < c.price) {
      this.audio.ui('error');
      this._refreshWallet();
      const card = [...this.grid.children].find((x) => x.dataset.crate === crateId);
      card.classList.remove('shake'); void card.offsetWidth; card.classList.add('shake');
      return;
    }
    this.busy = true;
    this.profile.spend(c.price);
    this.audio.ui('buy');
    this._refreshWallet();

    const result = roll(crateId);
    await this.playOpen(c, result);
    this.busy = false;
  }

  async playOpen(crate, result) {
    const { item, rarity } = result;
    const R = RARITY[rarity];
    const secret = rarity === 'SECRET';
    const tier = R.tier;

    this.stage.classList.remove('hidden');
    this.stage.className = 'cr-stage tier' + tier;
    this.stage.style.setProperty('--rc', R.color);
    this.stage.style.setProperty('--accent', crate.accent);
    this.revealCard.classList.add('hidden');
    this.secretLayer.classList.add('hidden');
    this.reelWrap.classList.remove('hidden');
    this.crateArt.style.backgroundImage = `url(${crateArt(crate)})`;
    this.crateArt.className = 'cr-bigcrate';
    this.stageHint.textContent = '';

    // --- crate lands and cracks open
    await sleep(60);
    this.crateArt.classList.add('drop');
    this.audio.crateOpen();
    await sleep(900);
    this.crateArt.classList.add('burst');
    await sleep(320);
    this.crateArt.classList.add('gone');

    // --- build the strip
    const winIndex = 52;
    const strip = buildReel(crate.id, item, 62, winIndex);
    this.reel.innerHTML = '';
    for (const it of strip) {
      const r = RARITY[it.rarity];
      const t = EL('div', 'cr-tile', this.reel);
      t.style.setProperty('--rc', r.color);
      t.innerHTML = `<img src="${iconFor(it)}" alt=""><div class="ct-name">${it.name}</div><div class="ct-rar">${r.short}</div>`;
    }

    // --- spin
    const wrapW = this.reelWrap.clientWidth;
    const jitter = (Math.random() - 0.5) * (TILE * 0.42);
    const finalX = -(winIndex * TILE + TILE / 2 - wrapW / 2 + jitter);
    const duration = secret ? 7200 : tier >= 5 ? 6600 : tier >= 4 ? 6000 : 5200;

    await this._spin(finalX, duration, { secret, tier });

    // --- reveal
    if (secret) await this._secretReveal(item);
    else await this._normalReveal(item, R, tier);

    // --- bank it
    const dupe = this.profile.grant(item);
    this.profile.stats.cratesOpened++;
    if (dupe) {
      const value = itemValue(item);
      this.profile.addCredits(value);
      this.stageHint.innerHTML = `DUPLICATE &middot; CONVERTED TO <b>${formatNum(value)}</b> CREDITS`;
    } else {
      this.stageHint.innerHTML = 'ADDED TO YOUR LOCKER &middot; CLICK TO CONTINUE';
    }
    this.profile.save();
    this._refreshWallet();
    this.emit('unboxed', { item, rarity, dupe });

    await this._waitForClick();
    this.stage.classList.add('hidden');
    this.audio.duck(1);
    this.secretLayer.classList.add('hidden');
  }

  _spin(finalX, duration, opts) {
    return new Promise((resolve) => {
      const start = performance.now();
      const startX = 0;
      let lastIndex = -1;
      const wrapW = this.reelWrap.clientWidth;
      const stallAt = opts.secret ? 0.86 : -1;
      let stalled = false;
      let stallTime = 0;

      const frame = (now) => {
        let e = (now - start) / duration;
        if (e >= 1) e = 1;
        // Quintic ease-out: fast, then a long crawl into the marker.
        let p = 1 - Math.pow(1 - e, 5);

        if (opts.secret && e > stallAt) {
          // The ??? spin does not finish cleanly. It hesitates.
          if (!stalled) {
            stalled = true;
            stallTime = now;
            this.audio.duck(0.12, 0.8);
            this.stage.classList.add('stall');
          }
          const held = (now - stallTime) / 1000;
          p = 1 - Math.pow(1 - stallAt, 5) + (1 - (1 - Math.pow(1 - stallAt, 5))) * clamp01(held / 2.6);
          if (Math.floor(held * 2) !== this._lastTick) {
            this._lastTick = Math.floor(held * 2);
            this.audio.secretTick(this._lastTick);
          }
          if (held < 2.6) { this.reel.style.transform = `translateX(${startX + (finalX - startX) * p}px)`; requestAnimationFrame(frame); return; }
        }

        const x = startX + (finalX - startX) * p;
        this.reel.style.transform = `translateX(${x}px)`;

        const centerIndex = Math.round((-x + wrapW / 2 - TILE / 2) / TILE);
        if (centerIndex !== lastIndex) {
          lastIndex = centerIndex;
          if (e < 0.999) this.audio.crateTick(0.85 + Math.min(0.6, (1 - e) * 0.9));
        }
        if (e < 1) requestAnimationFrame(frame);
        else resolve();
      };
      requestAnimationFrame(frame);
    });
  }

  async _normalReveal(item, R, tier) {
    this.audio.reveal(R.id);
    if (tier >= 3) this.stage.classList.add('flash');
    await sleep(tier >= 4 ? 460 : 220);
    this.reelWrap.classList.add('fade');

    this.revealCard.className = 'cr-reveal show tier' + tier;
    this.revealCard.innerHTML = `
      <div class="rv-beam"></div>
      <div class="rv-rar">${R.name}</div>
      <img class="rv-icon" src="${iconFor(item)}" alt="">
      <div class="rv-name">${item.name}</div>
      <div class="rv-type">${TYPE_LABEL[item.type]}</div>
      <div class="rv-lore">${item.lore}</div>`;
    await sleep(tier >= 5 ? 1400 : 700);
    this.reelWrap.classList.remove('fade');
    this.reelWrap.classList.add('hidden');
    this.stage.classList.remove('flash');
  }

  /**
   * ??? — 1 in 2,000. It does not get a bigger fanfare; it gets a different
   * film. Everything drains out, the reel goes blank, the room goes quiet, and
   * one glyph arrives before the item does.
   */
  async _secretReveal(item) {
    const S = this.secretLayer;
    S.classList.remove('hidden');
    S.className = 'cr-secret drain';
    this.stage.classList.add('secret');
    this.audio.duck(0.0, 1.2);

    // 1. Colour leaves the room.
    S.innerHTML = '<div class="sc-static"></div>';
    await sleep(1100);

    // 2. The tiles forget what they were.
    for (const t of this.reel.children) t.classList.add('blank');
    await sleep(700);

    // 3. Black. Nothing. Long enough to be uncomfortable.
    S.classList.add('black');
    await sleep(1400);

    // 4. One glyph.
    S.innerHTML = '<div class="sc-glyph">?</div>';
    S.classList.add('glyph');
    this.audio.reveal('SECRET');
    await sleep(2600);

    // 5. The name arrives before the object.
    S.innerHTML = `<div class="sc-glyph small">?</div><div class="sc-label">CLASSIFICATION FAILED</div>`;
    await sleep(1600);

    // 6. Reveal.
    this.reelWrap.classList.add('hidden');
    S.classList.remove('black');
    S.classList.add('reveal');
    S.innerHTML = `
      <div class="sc-card">
        <div class="sc-rar">???</div>
        <img class="sc-icon" src="${iconFor(item)}" alt="">
        <div class="sc-name">${item.name}</div>
        <div class="sc-type">${TYPE_LABEL[item.type]}</div>
        <div class="sc-lore">${item.lore}</div>
        <div class="sc-odds">0.05% &middot; 1 IN 2,000</div>
      </div>`;
    await sleep(2000);
    this.audio.duck(0.6, 2.0);
  }

  _waitForClick() {
    return new Promise((resolve) => {
      const done = () => { this.stage.removeEventListener('click', done); window.removeEventListener('keydown', key); resolve(); };
      const key = (e) => { if (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape') done(); };
      setTimeout(() => {
        this.stage.addEventListener('click', done);
        window.addEventListener('keydown', key);
      }, 350);
    });
  }

  show() {
    this.el.classList.remove('hidden');
    this.inspect.classList.add('hidden');
    this._refreshWallet();
  }

  hide() { this.el.classList.add('hidden'); }
}

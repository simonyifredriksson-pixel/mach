/**
 * Local player profile: credits, inventory, equipped loadout, lifetime stats
 * and settings. Persisted to localStorage.
 *
 * Match-critical values (health, damage, kills) are never read from here — the
 * authority owns those. This is the meta layer only.
 */

import { Emitter } from '../core/Util.js';
import { DEFAULT_LOADOUT, getItem, CATALOG } from './Cosmetics.js';

const KEY = 'mach.profile.v1';

function blankStats() {
  return {
    kills: 0, deaths: 0, matches: 0, playTime: 0,
    damageDealt: 0, damageTaken: 0,
    hits: 0, swings: 0,
    topSpeed: 0, bestHit: 0, bestHitSpeed: 0,
    bestStreak: 0, distance: 0,
    cratesOpened: 0, creditsEarned: 0,
    secrets: 0,
  };
}

export class Profile extends Emitter {
  constructor() {
    super();
    this.name = 'RUNNER';
    this.credits = 1500;              // enough for one case out of the gate
    this.inventory = new Set();
    this.loadout = { ...DEFAULT_LOADOUT };
    this.stats = blankStats();
    this.history = [];                // recent unboxes
    this.settings = {
      sensitivity: 1.0, invertY: false, fov: 0, shake: 1.0,
      motionBlur: 1.0, speedLines: 1.0, master: 0.8, music: 0.5, sfx: 0.9,
      showDamage: true, quality: 'high',
    };
    this.load();
    // Defaults are always owned.
    for (const [type, id] of Object.entries(DEFAULT_LOADOUT)) this.inventory.add(type + ':' + id);
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return;
      const d = JSON.parse(raw);
      this.name = d.name || this.name;
      this.credits = typeof d.credits === 'number' ? d.credits : this.credits;
      this.inventory = new Set(d.inventory || []);
      this.loadout = { ...DEFAULT_LOADOUT, ...(d.loadout || {}) };
      this.stats = { ...blankStats(), ...(d.stats || {}) };
      this.history = d.history || [];
      this.settings = { ...this.settings, ...(d.settings || {}) };
    } catch (e) { /* corrupt save: start clean */ }
  }

  save() {
    try {
      localStorage.setItem(KEY, JSON.stringify({
        name: this.name,
        credits: this.credits,
        inventory: [...this.inventory],
        loadout: this.loadout,
        stats: this.stats,
        history: this.history.slice(0, 40),
        settings: this.settings,
      }));
    } catch (e) { /* storage blocked — play on, just don't persist */ }
  }

  /* ------------------------------------------------------------ economy */

  addCredits(n) {
    this.credits += n;
    this.stats.creditsEarned += Math.max(0, n);
    this.emit('credits', this.credits);
    this.save();
  }

  spend(n) {
    if (this.credits < n) return false;
    this.credits -= n;
    this.emit('credits', this.credits);
    this.save();
    return true;
  }

  owns(type, id) { return this.inventory.has(type + ':' + id); }

  grant(item) {
    const key = item.type + ':' + item.id;
    const dupe = this.inventory.has(key);
    if (!dupe) this.inventory.add(key);
    if (item.rarity === 'SECRET' && !dupe) this.stats.secrets++;
    this.history.unshift({ t: Date.now(), type: item.type, id: item.id, rarity: item.rarity, dupe });
    this.save();
    return dupe;
  }

  equip(type, id) {
    if (!this.owns(type, id)) return false;
    this.loadout[type] = id;
    this.emit('loadout', this.loadout);
    this.save();
    return true;
  }

  equipped(type) { return getItem(type, this.loadout[type]); }

  /** Everything owned, grouped by type, for the locker screen. */
  ownedByType() {
    const out = {};
    for (const [type, table] of Object.entries(CATALOG)) {
      out[type] = Object.values(table).filter((i) => this.owns(type, i.id));
    }
    return out;
  }

  collectionProgress() {
    let owned = 0, total = 0;
    for (const table of Object.values(CATALOG)) {
      for (const item of Object.values(table)) { total++; if (this.owns(item.type, item.id)) owned++; }
    }
    return { owned, total, pct: total ? owned / total : 0 };
  }

  /* -------------------------------------------------------------- stats */

  /** Fold one finished match into the lifetime record. */
  recordMatch(m) {
    const s = this.stats;
    s.matches++;
    s.kills += m.kills || 0;
    s.deaths += m.deaths || 0;
    s.playTime += m.time || 0;
    s.damageDealt += m.damageDealt || 0;
    s.damageTaken += m.damageTaken || 0;
    s.hits += m.hits || 0;
    s.swings += m.swings || 0;
    s.distance += m.distance || 0;
    s.topSpeed = Math.max(s.topSpeed, m.topSpeed || 0);
    if ((m.bestHit || 0) > s.bestHit) { s.bestHit = m.bestHit; s.bestHitSpeed = m.bestHitSpeed || 0; }
    s.bestStreak = Math.max(s.bestStreak, m.bestStreak || 0);
    this.save();
    this.emit('stats', s);
  }

  get kd() {
    const s = this.stats;
    return s.deaths === 0 ? s.kills : s.kills / s.deaths;
  }

  get accuracy() {
    const s = this.stats;
    return s.swings ? s.hits / s.swings : 0;
  }

  reset() {
    localStorage.removeItem(KEY);
    this.credits = 1500;
    this.inventory = new Set();
    this.loadout = { ...DEFAULT_LOADOUT };
    this.stats = blankStats();
    this.history = [];
    for (const [type, id] of Object.entries(DEFAULT_LOADOUT)) this.inventory.add(type + ':' + id);
    this.save();
    this.emit('credits', this.credits);
    this.emit('loadout', this.loadout);
  }
}

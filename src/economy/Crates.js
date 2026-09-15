/**
 * [MACH] — crates.
 *
 * Earned currency only. Credits come from damage dealt, kills and time spent
 * alive; there is no purchase path and nothing in a crate affects play.
 *
 * The published odds ARE the odds: `roll()` walks the same table the UI prints.
 */

import { RARITY, RARITY_ORDER, rollRarity } from './Rarity.js';
import { ALL_ITEMS, getItem } from './Cosmetics.js';

export const CRATES = {
  street: {
    id: 'street',
    name: 'SIGNAL CASE',
    district: 'GRAND BOULEVARD',
    price: 900,
    accent: '#f2c511',
    ink: '#101318',
    motif: 'chevron',
    blurb: 'Recovered from the boulevard maintenance depot. Traffic yellow, mostly.',
  },
  yards: {
    id: 'yards',
    name: 'INDUSTRIAL CASE',
    district: 'THE YARDS',
    price: 1200,
    accent: '#22c6e8',
    ink: '#0e161c',
    motif: 'grid',
    blurb: 'Container manifest says MACHINE PARTS. The weight is wrong.',
  },
  hill: {
    id: 'hill',
    name: 'RELIQUARY CASE',
    district: 'TERRACE HILL',
    price: 1500,
    accent: '#c63fa0',
    ink: '#14101a',
    motif: 'seal',
    blurb: 'Sealed at the citadel. The seal is older than the district charter.',
  },
};

export const CRATE_ORDER = ['street', 'yards', 'hill'];

/** Dupe conversion value, by rarity tier. */
export const DUPE_VALUE = {
  COMMON: 60, UNCOMMON: 110, RARE: 220, EPIC: 480, LEGENDARY: 1100, MYTHIC: 2600, SECRET: 20000,
};

const poolCache = new Map();

/** {RARITY -> item[]} for a crate. ??? items are shared across all crates. */
export function cratePool(crateId) {
  if (poolCache.has(crateId)) return poolCache.get(crateId);
  const pool = {};
  for (const r of RARITY_ORDER) pool[r] = [];
  for (const item of ALL_ITEMS) {
    if (item.rarity === 'SECRET') { if (item.crate === null) pool.SECRET.push(item); continue; }
    if (item.crate === crateId) pool[item.rarity].push(item);
  }
  poolCache.set(crateId, pool);
  return pool;
}

/** Flat, display-ordered contents list for the crate inspector. */
export function crateContents(crateId) {
  const pool = cratePool(crateId);
  const out = [];
  for (const r of [...RARITY_ORDER].reverse()) for (const it of pool[r]) out.push(it);
  return out;
}

/**
 * Open one crate.
 * @returns {{item, rarity, crate}} — rarity is always the rolled tier; if that
 * tier is somehow empty the roll walks DOWN, never up.
 */
export function roll(crateId, rng = Math.random) {
  const pool = cratePool(crateId);
  let rarity = rollRarity(rng);
  let idx = RARITY_ORDER.indexOf(rarity);
  while (idx >= 0 && pool[RARITY_ORDER[idx]].length === 0) idx--;
  if (idx < 0) idx = 0;
  rarity = RARITY_ORDER[idx];
  const list = pool[rarity];
  const item = list[Math.floor(rng() * list.length) % list.length];
  return { item, rarity, crate: crateId };
}

/**
 * Reel contents for the spin animation: a long strip of plausible items with
 * the real reward slotted at a fixed index. The strip is cosmetic — the result
 * was decided by `roll()` before the animation started.
 */
export function buildReel(crateId, winner, length = 60, winIndex = 52, rng = Math.random) {
  const pool = cratePool(crateId);
  const weighted = [];
  for (const r of RARITY_ORDER) {
    const n = Math.max(1, Math.round(RARITY[r].odds / 2));
    for (const it of pool[r]) for (let i = 0; i < n; i++) weighted.push(it);
  }
  const strip = [];
  for (let i = 0; i < length; i++) {
    strip.push(i === winIndex ? winner : weighted[Math.floor(rng() * weighted.length) % weighted.length]);
  }
  return strip;
}

export function itemValue(item) { return DUPE_VALUE[item.rarity] ?? 60; }

export { getItem };

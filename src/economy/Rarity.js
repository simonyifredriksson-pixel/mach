/**
 * Rarity ladder. Odds are published in the crate UI exactly as written here —
 * the table below is the single source of truth for both the roll and the
 * displayed percentages.
 */

export const RARITY = {
  COMMON: {
    id: 'COMMON', name: 'COMMON', short: 'CMN', odds: 35.05,
    color: '#7fcf6a', dim: '#2c4426', glow: 0x7fcf6a, tier: 0, mark: '●',
  },
  UNCOMMON: {
    id: 'UNCOMMON', name: 'UNCOMMON', short: 'UNC', odds: 27.0,
    color: '#4aa3e8', dim: '#1d3550', glow: 0x4aa3e8, tier: 1, mark: '●',
  },
  RARE: {
    id: 'RARE', name: 'RARE', short: 'RAR', odds: 20.0,
    color: '#a668e8', dim: '#35224f', glow: 0xa668e8, tier: 2, mark: '●',
  },
  EPIC: {
    id: 'EPIC', name: 'EPIC', short: 'EPC', odds: 10.0,
    color: '#f2903a', dim: '#4a2d13', glow: 0xf2903a, tier: 3, mark: '◆',
  },
  LEGENDARY: {
    id: 'LEGENDARY', name: 'LEGENDARY', short: 'LEG', odds: 5.0,
    color: '#e8453a', dim: '#4d1a17', glow: 0xe8453a, tier: 4, mark: '◆',
  },
  MYTHIC: {
    id: 'MYTHIC', name: 'MYTHIC', short: 'MYT', odds: 2.9,
    color: '#ffd84a', dim: '#4f411a', glow: 0xffd84a, tier: 5, mark: '★',
  },
  SECRET: {
    id: 'SECRET', name: '???', short: '???', odds: 0.05,
    color: '#f4f4f4', dim: '#141414', glow: 0xffffff, tier: 6, mark: '?',
  },
};

export const RARITY_ORDER = ['COMMON', 'UNCOMMON', 'RARE', 'EPIC', 'LEGENDARY', 'MYTHIC', 'SECRET'];

/** Sanity: the table must total 100. */
export const ODDS_TOTAL = RARITY_ORDER.reduce((a, k) => a + RARITY[k].odds, 0);

/** 1 in N, for display. */
export function oneIn(rarityId) {
  return Math.round(100 / RARITY[rarityId].odds);
}

/**
 * Roll a rarity from the published table.
 * @param {() => number} rng
 */
export function rollRarity(rng = Math.random) {
  let r = rng() * 100;
  for (const key of RARITY_ORDER) {
    r -= RARITY[key].odds;
    if (r <= 0) return key;
  }
  return 'COMMON';
}

/**
 * [MACH] — MERIDIAN DISTRICT
 *
 * The map is generated deterministically from a seed so the authority and every
 * client agree on collision down to the float. Nothing here touches three.js;
 * the renderer consumes the same structures the physics does.
 *
 * Layout (5200 x 5200 units = 520 x 520 m):
 *
 *        -X  <------------------ 0 ------------------>  +X
 *   -Z   +------------------+---------+------------------+
 *    ^   |   DOWNTOWN       |         |   THE YARDS      |
 *    |   |   towers, alleys | AVENUE  |   warehouses     |
 *    |   |   skybridges     |         |   open apron     |
 *    0   +===== GRAND BOULEVARD (5.2 km straight) ======+
 *    |   |   TERRACE HILL   |         |   THE OVERPASS   |
 *    |   |   hill + tunnel  | AVENUE  |   elevated deck  |
 *   +Z   |   mountain road  |         |   sunken cut     |
 *        +------------------+---------+------------------+
 *
 * plus a ring road at |x| or |z| ~ 1800 that rides over the hill shoulder,
 * and a sunken expressway running N-S at x = 1250 crossed by three bridges.
 */

import { clamp, clamp01, smoothstep, invLerp, lerp, mulberry32, randRange } from '../core/Util.js';

export const HALF = 2600;
export const WORLD_SIZE = HALF * 2;
export const TERRAIN_CELLS = 52;
export const TERRAIN_STEP = WORLD_SIZE / TERRAIN_CELLS; // 100 units

export const SHAPE = { BOX: 0, RAMP: 1, CYL: 2 };

export const SURF = {
  ASPHALT: 0, ROAD_LINE: 1, PLAZA: 2, CONCRETE: 3, DIRT: 4, GRASS: 5, CUT: 6,
};

/* ------------------------------------------------------------------ terrain */

function authoredHeight(x, z) {
  let h = 0;

  // Terrace Hill — SW. Plateau with a long smooth falloff.
  {
    const d = Math.hypot(x + 1450, z - 1480);
    if (d < 1020) h = Math.max(h, 215 * smoothstep(1 - invLerp(300, 1020, d)));
  }
  // Park mound — SE.
  {
    const d = Math.hypot(x - 600, z - 2050);
    if (d < 450) h = Math.max(h, 92 * smoothstep(1 - d / 450));
  }
  // Rolling ground at the map edges so the horizon isn't a dead flat line.
  {
    const edge = smoothstep(invLerp(1900, 2600, Math.max(Math.abs(x), Math.abs(z))));
    h += edge * (Math.sin(x * 0.0021) * Math.cos(z * 0.0017) * 34 + Math.sin(z * 0.0033) * 12);
  }
  // Sunken expressway — a banked N-S trench at x = 1250. Half-pipe for carving.
  {
    const d = Math.abs(x - 1250);
    if (d < 320) h -= 88 * (1 - smoothstep(invLerp(120, 320, d)));
  }
  // Tunnel cut through Terrace Hill (x from -2150 to -900 at z = 1460).
  {
    const dz = Math.abs(z - 1460);
    if (dz < 190 && x > -2260 && x < -820) {
      const across = 1 - smoothstep(invLerp(115, 190, dz));
      const along = smoothstep(invLerp(-2260, -2110, x)) * (1 - smoothstep(invLerp(-960, -820, x)));
      h = lerp(h, 0, across * along);
    }
  }
  return h;
}

function surfaceKind(x, z, h) {
  const ax = Math.abs(x), az = Math.abs(z);
  if (az < 150 || ax < 150) return SURF.ASPHALT;                      // boulevard / avenue
  if (Math.abs(Math.max(ax, az) - 1800) < 110) return SURF.ASPHALT;   // ring road
  if (ax < 520 && az < 520) return SURF.PLAZA;
  if (Math.abs(x - 1250) < 150) return SURF.ASPHALT;                  // sunken expressway floor
  if (Math.abs(z - 1460) < 130 && x > -2200 && x < -880) return SURF.CUT;
  if (x < -200 && z < -200) return SURF.CONCRETE;                     // downtown
  if (x > 200 && z < -200) return SURF.CONCRETE;                      // yards
  if (x < -200 && z > 200) return h > 60 ? SURF.GRASS : SURF.DIRT;    // hill
  if (x > 200 && z > 200) return h > 30 ? SURF.GRASS : SURF.CONCRETE;
  return SURF.CONCRETE;
}

function buildTerrain() {
  const n = TERRAIN_CELLS + 1;
  const heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const x = -HALF + i * TERRAIN_STEP;
      const z = -HALF + j * TERRAIN_STEP;
      heights[j * n + i] = authoredHeight(x, z);
    }
  }
  const kinds = new Uint8Array(TERRAIN_CELLS * TERRAIN_CELLS);
  for (let j = 0; j < TERRAIN_CELLS; j++) {
    for (let i = 0; i < TERRAIN_CELLS; i++) {
      const x = -HALF + (i + 0.5) * TERRAIN_STEP;
      const z = -HALF + (j + 0.5) * TERRAIN_STEP;
      const h = 0.25 * (heights[j * n + i] + heights[j * n + i + 1] +
        heights[(j + 1) * n + i] + heights[(j + 1) * n + i + 1]);
      kinds[j * TERRAIN_CELLS + i] = surfaceKind(x, z, h);
    }
  }
  return { cells: TERRAIN_CELLS, step: TERRAIN_STEP, n, heights, kinds };
}

/** Bilinear terrain height. Cheap and exact-matched by the render mesh. */
export function terrainHeight(world, x, z) {
  const t = world.terrain;
  const fx = clamp((x + HALF) / t.step, 0, t.cells - 1e-4);
  const fz = clamp((z + HALF) / t.step, 0, t.cells - 1e-4);
  const i = fx | 0, j = fz | 0;
  const u = fx - i, v = fz - j;
  const h = t.heights, n = t.n;
  const h00 = h[j * n + i], h10 = h[j * n + i + 1];
  const h01 = h[(j + 1) * n + i], h11 = h[(j + 1) * n + i + 1];
  return lerp(lerp(h00, h10, u), lerp(h01, h11, u), v);
}

/** Terrain slope as a unit-ish gradient (dy/dx, dy/dz). */
export function terrainGradient(world, x, z, out) {
  const e = 12;
  out.x = (terrainHeight(world, x + e, z) - terrainHeight(world, x - e, z)) / (2 * e);
  out.z = (terrainHeight(world, x, z + e) - terrainHeight(world, x, z - e)) / (2 * e);
  return out;
}

/* ------------------------------------------------------------------- solids */

function box(x0, z0, w, d, y0, h, kind) {
  return { t: SHAPE.BOX, x0, x1: x0 + w, z0, z1: z0 + d, y0, y1: y0 + h, k: kind };
}
function ramp(x0, z0, w, d, yLow, yHigh, axis, dir, kind) {
  // axis 0 = slope runs along X, 1 = along Z. dir +1 means high at the max edge.
  return { t: SHAPE.RAMP, x0, x1: x0 + w, z0, z1: z0 + d, y0: yLow, y1: yHigh, ax: axis, dir, k: kind };
}
function cyl(cx, cz, r, y0, h, kind) {
  return { t: SHAPE.CYL, cx, cz, r, y0, y1: y0 + h, x0: cx - r, x1: cx + r, z0: cz - r, z1: cz + r, k: kind };
}

/* ------------------------------------------------------------- generators */

function genDowntown(S, P, rng, terrainAt) {
  // Dense tower grid with 90u streets and tight interior alleys. This is where
  // 500 speed gets you killed: you cannot turn, and every corner is blind.
  const roofs = [];
  for (let bx = -2430; bx < -300; bx += 390) {
    for (let bz = -2430; bz < -300; bz += 390) {
      if (bx > -560 && bz > -560) continue; // keep the plaza mouth open
      const jitter = rng();
      const blockW = 300, blockD = 300;
      const split = jitter < 0.42 ? 2 : jitter < 0.78 ? 3 : 1;
      const base = terrainAt(bx + 150, bz + 150);
      if (split === 1) {
        const h = randRange(rng, 150, 520);
        S.push(box(bx, bz, blockW, blockD, base - 30, h + 30, 'tower'));
        roofs.push({ x: bx + 150, z: bz + 150, y: base + h, w: blockW, d: blockD });
      } else if (split === 2) {
        const cut = randRange(rng, 110, 190);
        const alley = randRange(rng, 30, 46);
        const h1 = randRange(rng, 130, 430), h2 = randRange(rng, 130, 430);
        S.push(box(bx, bz, cut, blockD, base - 30, h1 + 30, 'tower'));
        S.push(box(bx + cut + alley, bz, blockW - cut - alley, blockD, base - 30, h2 + 30, 'tower'));
        roofs.push({ x: bx + cut / 2, z: bz + 150, y: base + h1, w: cut, d: blockD });
        roofs.push({ x: bx + cut + alley + (blockW - cut - alley) / 2, z: bz + 150, y: base + h2, w: blockW - cut - alley, d: blockD });
      } else {
        const alley = randRange(rng, 30, 44);
        const cw = (blockW - alley) / 2, cd = (blockD - alley) / 2;
        for (let q = 0; q < 4; q++) {
          if (q === 3 && rng() < 0.35) continue; // leave a courtyard
          const ox = (q % 2) * (cw + alley), oz = (q >> 1) * (cd + alley);
          const h = randRange(rng, 110, 330);
          S.push(box(bx + ox, bz + oz, cw, cd, base - 30, h + 30, 'tower'));
          roofs.push({ x: bx + ox + cw / 2, z: bz + oz + cd / 2, y: base + h, w: cw, d: cd });
        }
      }
      // Occasional street-level awning you can run up onto.
      if (rng() < 0.3) {
        const side = rng() < 0.5;
        const rx = side ? bx - 60 : bx + blockW;
        S.push(ramp(rx, bz + 60, 60, 90, base, base + 70, 0, side ? 1 : -1, 'ramp'));
        S.push(box(side ? bx - 60 : bx + blockW, bz + 60, 60, 90, base + 62, 8, 'ledge'));
      }
    }
  }
  // Skybridges: stitch roofs of similar height into a rooftop network.
  roofs.sort((a, b) => a.x - b.x || a.z - b.z);
  let bridges = 0;
  for (let i = 0; i < roofs.length && bridges < 26; i++) {
    for (let j = i + 1; j < roofs.length && bridges < 26; j++) {
      const a = roofs[i], b = roofs[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      if (Math.abs(a.y - b.y) > 26) continue;
      if (Math.abs(dx) < 40 && Math.abs(dz) > 150 && Math.abs(dz) < 330) {
        const y = Math.min(a.y, b.y);
        S.push(box(a.x - 22, Math.min(a.z, b.z), 44, Math.abs(dz), y, 5, 'bridge'));
        S.push(box(a.x - 26, Math.min(a.z, b.z), 5, Math.abs(dz), y + 5, 13, 'rail'));
        S.push(box(a.x + 21, Math.min(a.z, b.z), 5, Math.abs(dz), y + 5, 13, 'rail'));
        bridges++;
      } else if (Math.abs(dz) < 40 && Math.abs(dx) > 150 && Math.abs(dx) < 330) {
        const y = Math.min(a.y, b.y);
        S.push(box(Math.min(a.x, b.x), a.z - 22, Math.abs(dx), 44, y, 5, 'bridge'));
        S.push(box(Math.min(a.x, b.x), a.z - 26, Math.abs(dx), 5, y + 5, 13, 'rail'));
        S.push(box(Math.min(a.x, b.x), a.z + 21, Math.abs(dx), 5, y + 5, 13, 'rail'));
        bridges++;
      }
    }
  }
  // Two long service ramps from the boulevard up to the low-roof network.
  S.push(ramp(-900, -430, 700, 110, 0, 165, 0, -1, 'ramp'));
  S.push(ramp(-2300, -300, 620, 110, 0, 150, 0, 1, 'ramp'));
  P.roofs = roofs;
}

function genYards(S, P, rng, terrainAt) {
  // Industrial: wide aprons for building speed, container mazes for ambushes.
  const warehouses = [
    [340, -2400, 620, 380], [1120, -2400, 560, 380],
    [340, -1880, 520, 300], [1900, -2350, 600, 460],
    [980, -1760, 700, 320], [1900, -1600, 560, 380],
    [420, -1200, 600, 340], [1850, -900, 640, 420],
  ];
  for (const [x, z, w, d] of warehouses) {
    const base = terrainAt(x + w / 2, z + d / 2);
    const h = randRange(rng, 95, 145);
    S.push(box(x, z, w, d, base - 20, h + 20, 'warehouse'));
    // Sawtooth roof ridges — cover and footing up top.
    for (let rx = x + 40; rx < x + w - 60; rx += 120) {
      S.push(ramp(rx, z, 60, d, base + h, base + h + 26, 0, 1, 'roofridge'));
      S.push(box(rx + 60, z, 8, d, base + h, 26, 'roofridge'));
    }
    // Loading ramp onto the roof.
    if (rng() < 0.75) {
      S.push(ramp(x - 240, z + d * 0.3, 240, 110, base, base + h, 0, 1, 'ramp'));
    }
  }
  // Container stacks — climbable staircases into the sky.
  for (let s = 0; s < 22; s++) {
    const cx = randRange(rng, 300, 2350), cz = randRange(rng, -2350, -320);
    if (Math.abs(cz) < 240) continue;
    const base = terrainAt(cx, cz);
    const along = rng() < 0.5;
    const steps = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < steps; i++) {
      const w = along ? 130 : 46, d = along ? 46 : 130;
      const ox = along ? i * 136 : 0, oz = along ? 0 : i * 136;
      const stack = steps - i;
      for (let k = 0; k < stack; k++) {
        S.push(box(cx + ox, cz + oz, w, d, base + k * 46, 44, 'container'));
      }
    }
  }
  // Silos + a raised gantry catwalk linking them.
  const siloY = terrainAt(700, -700);
  for (let i = 0; i < 4; i++) S.push(cyl(620 + i * 130, -700, 52, siloY - 10, 210, 'silo'));
  S.push(box(560, -716, 560, 32, siloY + 200, 6, 'bridge'));
  S.push(ramp(360, -716, 200, 32, siloY, siloY + 200, 0, 1, 'ramp'));
}

function genTerraceHill(S, P, rng, terrainAt) {
  // The hill itself is terrain. What we add: the tunnel, terraces, and a
  // hilltop citadel that rewards anyone brave enough to come down the far side.
  const tz = 1460;
  // Tunnel: walls hold the cut open, roof turns it into a true tunnel.
  for (let x = -2140; x < -900; x += 160) {
    const hL = Math.max(40, authoredHeight(x, tz - 230));
    const hR = Math.max(40, authoredHeight(x, tz + 230));
    S.push(box(x, tz - 125, 160, 40, 0, hL + 40, 'tunnelwall'));
    S.push(box(x, tz + 85, 160, 40, 0, hR + 40, 'tunnelwall'));
    S.push(box(x, tz - 130, 160, 260, 78, 26, 'tunnelroof'));
  }
  // Terraces stepping up the north face, each with a ramp.
  for (let i = 0; i < 4; i++) {
    const y = 55 + i * 45;
    const w = 700 - i * 120;
    S.push(box(-1800 + i * 60, 620 + i * 90, w, 46, y - 50, 50, 'terrace'));
    S.push(ramp(-1800 + i * 60 + w, 620 + i * 90, 190, 46, y - 50, y, 0, -1, 'ramp'));
  }
  // Hilltop citadel: a tight duelling ring with four entrances.
  const cy = terrainAt(-1450, 1480);
  const R = 230;
  for (let a = 0; a < 8; a++) {
    if (a % 2 === 1) continue; // gaps = the four gates
    const ang = (a / 8) * Math.PI * 2;
    const cx = -1450 + Math.cos(ang) * R, cz = 1480 + Math.sin(ang) * R;
    S.push(box(cx - 90, cz - 22, 180, 44, cy - 10, 90, 'citadel'));
  }
  S.push(box(-1520, 1410, 140, 140, cy, 14, 'citadel'));
  S.push(cyl(-1450, 1480, 26, cy + 14, 150, 'antenna'));
  // The mountain road guard rails (ring road crest over the hill shoulder).
  for (let z = 700; z < 2300; z += 200) {
    const y = terrainAt(-1690, z);
    S.push(box(-1700, z, 10, 180, y, 16, 'rail'));
    const y2 = terrainAt(-1910, z);
    S.push(box(-1920, z, 10, 180, y2, 16, 'rail'));
  }
}

function genOverpass(S, P, rng, terrainAt) {
  // Elevated deck: the single best place on the map to reach 500.
  const Y = 205;
  // East-west deck at z = 1520.
  S.push(box(260, 1420, 2190, 200, Y, 12, 'deck'));
  S.push(box(260, 1410, 2190, 12, Y + 12, 16, 'rail'));
  S.push(box(260, 1610, 2190, 12, Y + 12, 16, 'rail'));
  // North-south deck at x = 2100, joining at the corner.
  S.push(box(2000, 260, 200, 1360, Y, 12, 'deck'));
  S.push(box(1990, 260, 12, 1160, Y + 12, 16, 'rail'));
  S.push(box(2190, 260, 12, 1160, Y + 12, 16, 'rail'));
  // Pillars.
  for (let x = 320; x < 2400; x += 260) S.push(cyl(x, 1520, 26, terrainAt(x, 1520) - 20, Y - terrainAt(x, 1520) + 20, 'pillar'));
  for (let z = 320; z < 1400; z += 260) S.push(cyl(2100, z, 26, terrainAt(2100, z) - 20, Y - terrainAt(2100, z) + 20, 'pillar'));
  // On-ramps: 900u of straight downhill = free momentum.
  S.push(ramp(240, 1420, 900, 200, terrainAt(300, 1520), Y, 0, 1, 'ramp'));
  S.push(ramp(2000, 240, 200, 900, terrainAt(2100, 300), Y, 1, 1, 'ramp'));
  S.push(ramp(2450, 1420, 200, 200, terrainAt(2500, 1520), Y, 0, -1, 'ramp'));
  // Bridges over the sunken expressway (x = 1250).
  for (const [z, d] of [[-150, 300], [1700, 220], [-1910, 220]]) {
    S.push(box(1080, z, 340, d, -6, 10, 'bridge'));
    S.push(box(1080, z - 10, 340, 10, 4, 14, 'rail'));
    S.push(box(1080, z + d, 340, 10, 4, 14, 'rail'));
  }
  // Sunken expressway retaining walls where it passes under the bridges.
  // Low-rise blocks filling the district so it isn't an empty field.
  for (let i = 0; i < 12; i++) {
    const x = randRange(rng, 300, 1000), z = randRange(rng, 300, 2350);
    if (Math.abs(z - 1520) < 220) continue;
    const base = terrainAt(x, z);
    const w = randRange(rng, 150, 300), d = randRange(rng, 150, 300);
    S.push(box(x, z, w, d, base - 20, randRange(rng, 70, 190) + 20, 'lowrise'));
  }
}

function genPlaza(S, P, rng) {
  // Centre monument: a roundabout at the crossroads of the two long straights.
  // Deliberately narrow enough (260 across, in a 300-wide road) that you can
  // swerve past at speed — or commit to a ramp and take the high line over it.
  S.push(box(-130, -130, 260, 260, 0, 24, 'monument'));
  S.push(box(-90, -90, 180, 180, 24, 22, 'monument'));
  S.push(box(-55, -55, 110, 110, 46, 22, 'monument'));
  S.push(cyl(0, 0, 26, 68, 430, 'needle'));

  // Four approach ramps onto the first tier — one per cardinal.
  S.push(ramp(-55, -290, 110, 160, 0, 24, 1, 1, 'ramp'));   // from -Z
  S.push(ramp(-55, 130, 110, 160, 0, 24, 1, -1, 'ramp'));   // from +Z
  S.push(ramp(-290, -55, 160, 110, 0, 24, 0, 1, 'ramp'));   // from -X
  S.push(ramp(130, -55, 160, 110, 0, 24, 0, -1, 'ramp'));   // from +X

  // Perimeter planters, placed strictly off-axis so neither straight is fouled.
  for (let i = 0; i < 8; i++) {
    const a = ((i + 0.5) / 8) * Math.PI * 2;
    S.push(box(Math.cos(a) * 420 - 40, Math.sin(a) * 420 - 40, 80, 80, 0, 26, 'planter'));
  }
}

function genBoundary(S) {
  const H = 900;
  S.push(box(-HALF - 60, -HALF - 60, 60, WORLD_SIZE + 120, -200, H, 'bounds'));
  S.push(box(HALF, -HALF - 60, 60, WORLD_SIZE + 120, -200, H, 'bounds'));
  S.push(box(-HALF - 60, -HALF - 60, WORLD_SIZE + 120, 60, -200, H, 'bounds'));
  S.push(box(-HALF - 60, HALF, WORLD_SIZE + 120, 60, -200, H, 'bounds'));
}

/* -------------------------------------------------------------- props (vfx) */

function genProps(world, rng) {
  const props = [];
  const push = (type, x, z, opts = {}) =>
    props.push({ type, x, z, y: opts.y !== undefined ? opts.y : terrainHeight(world, x, z), rot: opts.rot || 0, s: opts.s || 1, c: opts.c || 0 });

  // Street lamps down the boulevard and avenue.
  for (let x = -2400; x <= 2400; x += 180) {
    push('lamp', x, -142, { rot: 0 });
    push('lamp', x, 142, { rot: Math.PI });
  }
  for (let z = -2400; z <= 2400; z += 220) {
    if (Math.abs(z) < 200) continue;
    push('lamp', -142, z, { rot: Math.PI / 2 });
    push('lamp', 142, z, { rot: -Math.PI / 2 });
  }
  // Ring road lamps.
  for (let i = 0; i < 4; i++) {
    for (let t = -1700; t <= 1700; t += 260) {
      const x = i === 0 ? t : i === 1 ? 1800 : i === 2 ? t : -1800;
      const z = i === 0 ? -1800 : i === 1 ? t : i === 2 ? 1800 : t;
      push('lamp', x, z, { rot: i * Math.PI / 2 });
    }
  }
  // Billboards on downtown faces.
  for (let i = 0; i < 26; i++) {
    const x = randRange(rng, -2400, -320), z = randRange(rng, -2400, -320);
    push('billboard', x, z, { y: randRange(rng, 90, 340), rot: Math.floor(rng() * 4) * Math.PI / 2, s: randRange(rng, 0.8, 1.6), c: Math.floor(rng() * 4) });
  }
  // Trees on the hill and in the park.
  for (let i = 0; i < 170; i++) {
    const a = rng() * Math.PI * 2, r = 320 + rng() * 900;
    const x = -1450 + Math.cos(a) * r, z = 1480 + Math.sin(a) * r;
    if (Math.abs(z - 1460) < 200 && x < -820) continue; // keep the cut clear
    if (Math.abs(Math.max(Math.abs(x), Math.abs(z)) - 1800) < 130) continue;
    if (x > -HALF + 60 && z < HALF - 60) push('tree', x, z, { s: randRange(rng, 0.8, 1.5), rot: rng() * 6.28 });
  }
  for (let i = 0; i < 70; i++) {
    const a = rng() * Math.PI * 2, r = rng() * 430;
    push('tree', 600 + Math.cos(a) * r, 2050 + Math.sin(a) * r, { s: randRange(rng, 0.7, 1.2), rot: rng() * 6.28 });
  }
  // Barriers along the sunken expressway lip.
  for (let z = -2300; z < 2300; z += 120) {
    if (Math.abs(z) < 220 || Math.abs(z - 1800) < 180 || Math.abs(z + 1800) < 180) continue;
    push('barrier', 1250 - 330, z, { rot: 0 });
    push('barrier', 1250 + 330, z, { rot: 0 });
  }
  // Rooftop clutter.
  for (const r of world.meta.roofs || []) {
    if (rng() < 0.55) push('acunit', r.x + randRange(rng, -40, 40), r.z + randRange(rng, -40, 40), { y: r.y, s: randRange(rng, 0.8, 1.4), rot: rng() * 6.28 });
    if (rng() < 0.25) push('antenna', r.x + randRange(rng, -60, 60), r.z + randRange(rng, -60, 60), { y: r.y, s: randRange(rng, 0.9, 1.8) });
  }
  // Banners hanging over the plaza — the visual signature of the arena.
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    push('banner', Math.cos(a) * 470, Math.sin(a) * 470, { y: 0, rot: a + Math.PI / 2, c: i % 3 });
  }
  return props;
}

/* ------------------------------------------------------------ spatial index */

function buildIndex(solids) {
  const CELL = 200;
  const map = new Map();
  const key = (i, j) => i * 100003 + j;
  for (let s = 0; s < solids.length; s++) {
    const o = solids[s];
    const i0 = Math.floor(o.x0 / CELL), i1 = Math.floor(o.x1 / CELL);
    const j0 = Math.floor(o.z0 / CELL), j1 = Math.floor(o.z1 / CELL);
    for (let i = i0; i <= i1; i++) {
      for (let j = j0; j <= j1; j++) {
        const k = key(i, j);
        let arr = map.get(k);
        if (!arr) map.set(k, (arr = []));
        arr.push(s);
      }
    }
  }
  return { CELL, map, key };
}

/** Indices of solids whose footprint may overlap the query AABB. */
export function querySolids(world, x0, z0, x1, z1, out) {
  out.length = 0;
  const idx = world.index, CELL = idx.CELL;
  const i0 = Math.floor(x0 / CELL), i1 = Math.floor(x1 / CELL);
  const j0 = Math.floor(z0 / CELL), j1 = Math.floor(z1 / CELL);
  const seen = world._seen;
  const stamp = ++world._stamp;
  for (let i = i0; i <= i1; i++) {
    for (let j = j0; j <= j1; j++) {
      const arr = idx.map.get(idx.key(i, j));
      if (!arr) continue;
      for (let n = 0; n < arr.length; n++) {
        const s = arr[n];
        if (seen[s] === stamp) continue;
        seen[s] = stamp;
        out.push(s);
      }
    }
  }
  return out;
}

/** Top surface height of a solid at (x,z), or null if outside its footprint. */
export function solidTop(o, x, z) {
  if (x < o.x0 || x > o.x1 || z < o.z0 || z > o.z1) return null;
  if (o.t === SHAPE.BOX) return o.y1;
  if (o.t === SHAPE.CYL) {
    const dx = x - o.cx, dz = z - o.cz;
    return dx * dx + dz * dz <= o.r * o.r ? o.y1 : null;
  }
  // Ramp: linear along its axis.
  const f = o.ax === 0 ? (x - o.x0) / (o.x1 - o.x0) : (z - o.z0) / (o.z1 - o.z0);
  const t = o.dir > 0 ? f : 1 - f;
  return lerp(o.y0, o.y1, clamp01(t));
}

/* ---------------------------------------------------------------- assembly */

export function buildWorld(seed = 1337) {
  const rng = mulberry32(seed);
  const terrain = buildTerrain();
  const world = { seed, half: HALF, terrain, meta: {} };
  const terrainAt = (x, z) => terrainHeight(world, x, z);

  const solids = [];
  const P = {};
  genPlaza(solids, P, rng);
  genDowntown(solids, P, rng, terrainAt);
  genYards(solids, P, rng, terrainAt);
  genTerraceHill(solids, P, rng, terrainAt);
  genOverpass(solids, P, rng, terrainAt);
  genBoundary(solids);

  world.solids = solids;
  world.meta = P;
  world._seen = new Int32Array(solids.length);
  world._stamp = 0;
  world.index = buildIndex(solids);
  world.props = genProps(world, rng);

  // Spawn points: spread wide, on flat ground, away from the monument.
  world.spawns = [
    { x: -2200, z: -60 }, { x: 2250, z: 60 }, { x: -60, z: -2250 }, { x: 60, z: 2250 },
    { x: -1800, z: -1800 }, { x: 1800, z: -1800 }, { x: -1800, z: 1750 }, { x: 1800, z: 1800 },
    { x: 700, z: -1400 }, { x: -700, z: 1200 }, { x: 1250, z: -900 }, { x: -1250, z: -420 },
  ].map((s) => ({ ...s, y: terrainAt(s.x, s.z) + 4 }));

  // Bot navigation targets — long sight-lines and speed lanes.
  world.waypoints = [
    { x: -2350, z: 0 }, { x: 2350, z: 0 }, { x: 0, z: -2350 }, { x: 0, z: 2350 },
    { x: 0, z: 0 }, { x: -1800, z: -1800 }, { x: 1800, z: -1800 }, { x: -1800, z: 1800 },
    { x: 1800, z: 1800 }, { x: 1250, z: -1200 }, { x: 1250, z: 900 }, { x: -1450, z: 1480 },
    { x: 1400, z: 1520 }, { x: -1500, z: 1460 }, { x: 900, z: -1900 }, { x: -900, z: -900 },
  ].map((w) => ({ ...w, y: terrainAt(w.x, w.z) }));

  return world;
}

export const DISTRICTS = [
  { name: 'GRAND BOULEVARD', x: 0, z: 0, r: 600, tag: 'OPEN // MAX VELOCITY' },
  { name: 'DOWNTOWN', x: -1400, z: -1400, r: 1200, tag: 'TIGHT // BLIND CORNERS' },
  { name: 'THE YARDS', x: 1400, z: -1400, r: 1200, tag: 'MIXED // VERTICAL' },
  { name: 'TERRACE HILL', x: -1450, z: 1480, r: 1100, tag: 'SLOPES // TUNNEL' },
  { name: 'THE OVERPASS', x: 1500, z: 1500, r: 1200, tag: 'ELEVATED // COMMIT' },
];

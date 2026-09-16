/**
 * Collision against the shared world: terrain heightfield + box / ramp /
 * cylinder solids. Used identically by the authority and by client prediction,
 * so a predicted step and an authoritative step produce the same numbers.
 */

import { clamp, clamp01, lerp } from '../core/Util.js';
import { SHAPE, terrainHeight, terrainGradient, querySolids, solidTop } from './WorldData.js';

const _scratch = [];
const _grad = { x: 0, z: 0 };

export const GROUND = { y: 0, nx: 0, ny: 1, nz: 0, kind: 'terrain', solid: -1 };

/**
 * Highest supporting surface under (x,z) that the player can stand on from
 * feetY. Terrain always supports; solids only if their top is not above
 * feet + stepUp (otherwise it's a wall, handled horizontally).
 */
export function groundInfo(world, x, z, feetY, stepUp, out = GROUND) {
  const ht = terrainHeight(world, x, z);
  terrainGradient(world, x, z, _grad);
  out.y = ht; out.kind = 'terrain'; out.solid = -1;
  // Heightfield normal = normalize(-dy/dx, 1, -dy/dz)
  {
    const nx = -_grad.x, nz = -_grad.z;
    const inv = 1 / Math.sqrt(nx * nx + 1 + nz * nz);
    out.nx = nx * inv; out.ny = inv; out.nz = nz * inv;
  }

  const ids = querySolids(world, x - 1, z - 1, x + 1, z + 1, _scratch);
  const ceiling = feetY + stepUp;
  for (let i = 0; i < ids.length; i++) {
    const o = world.solids[ids[i]];
    if (o.y1 <= out.y) continue;
    if (o.y1 > ceiling) continue;
    const top = solidTop(o, x, z);
    if (top === null || top <= out.y || top > ceiling) continue;
    out.y = top; out.kind = o.k; out.solid = ids[i];
    if (o.t === SHAPE.RAMP) {
      const run = o.ax === 0 ? o.x1 - o.x0 : o.z1 - o.z0;
      const slope = ((o.y1 - o.y0) / run) * (o.dir > 0 ? 1 : -1);
      if (o.ax === 0) {
        const inv = 1 / Math.sqrt(slope * slope + 1);
        out.nx = -slope * inv; out.ny = inv; out.nz = 0;
      } else {
        const inv = 1 / Math.sqrt(slope * slope + 1);
        out.nx = 0; out.ny = inv; out.nz = -slope * inv;
      }
    } else {
      out.nx = 0; out.ny = 1; out.nz = 0;
    }
  }
  return out;
}

/**
 * Push a vertical cylinder (radius r, height h, feet at pos.y) out of every
 * solid whose top is too high to step onto. Returns the number of contacts.
 */
export function resolveHorizontal(world, pos, vel, r, h, stepUp) {
  const ids = querySolids(world, pos.x - r, pos.z - r, pos.x + r, pos.z + r, _scratch);
  const feet = pos.y, head = pos.y + h;
  let contacts = 0;

  for (let i = 0; i < ids.length; i++) {
    const o = world.solids[ids[i]];
    if (o.y1 <= feet + stepUp) continue;   // steppable — the ground query owns it
    if (o.y0 >= head) continue;            // overhead — the ceiling pass owns it

    if (o.t === SHAPE.CYL) {
      const dx = pos.x - o.cx, dz = pos.z - o.cz;
      const d = Math.hypot(dx, dz);
      const min = o.r + r;
      if (d < min && d > 1e-5) {
        const push = (min - d) / d;
        pos.x += dx * push; pos.z += dz * push;
        const nx = dx / d, nz = dz / d;
        const vn = vel.x * nx + vel.z * nz;
        if (vn < 0) { vel.x -= nx * vn; vel.z -= nz * vn; }
        contacts++;
      }
      continue;
    }

    // Ramps only block where their surface is already above the step height.
    if (o.t === SHAPE.RAMP) {
      const cx = clamp(pos.x, o.x0, o.x1), cz = clamp(pos.z, o.z0, o.z1);
      const top = solidTop(o, cx, cz);
      if (top === null || top <= feet + stepUp) continue;
    }

    const cx = clamp(pos.x, o.x0, o.x1);
    const cz = clamp(pos.z, o.z0, o.z1);
    const dx = pos.x - cx, dz = pos.z - cz;
    const d2 = dx * dx + dz * dz;

    if (d2 > r * r) continue;

    if (d2 > 1e-6) {
      // Outside the footprint: push straight out along the closest-point normal.
      const d = Math.sqrt(d2);
      const push = (r - d) / d;
      pos.x += dx * push; pos.z += dz * push;
      const nx = dx / d, nz = dz / d;
      const vn = vel.x * nx + vel.z * nz;
      if (vn < 0) { vel.x -= nx * vn; vel.z -= nz * vn; }
    } else {
      // Centre is inside the box: eject along the cheapest axis.
      const pxMin = pos.x - o.x0 + r, pxMax = o.x1 - pos.x + r;
      const pzMin = pos.z - o.z0 + r, pzMax = o.z1 - pos.z + r;
      const m = Math.min(pxMin, pxMax, pzMin, pzMax);
      if (m === pxMin) { pos.x = o.x0 - r; if (vel.x > 0) vel.x = 0; }
      else if (m === pxMax) { pos.x = o.x1 + r; if (vel.x < 0) vel.x = 0; }
      else if (m === pzMin) { pos.z = o.z0 - r; if (vel.z > 0) vel.z = 0; }
      else { pos.z = o.z1 + r; if (vel.z < 0) vel.z = 0; }
    }
    contacts++;
  }
  return contacts;
}

/** Stop the head clipping into overhead geometry (tunnel roofs, decks). */
export function resolveCeiling(world, pos, vel, r, h, stepUp) {
  const ids = querySolids(world, pos.x - r, pos.z - r, pos.x + r, pos.z + r, _scratch);
  const feet = pos.y, head = pos.y + h;
  for (let i = 0; i < ids.length; i++) {
    const o = world.solids[ids[i]];
    if (o.y0 <= feet + stepUp || o.y0 >= head || o.y1 <= head) continue;
    if (o.t === SHAPE.CYL) {
      const dx = pos.x - o.cx, dz = pos.z - o.cz;
      if (dx * dx + dz * dz > (o.r + r) * (o.r + r)) continue;
    } else {
      if (pos.x + r < o.x0 || pos.x - r > o.x1 || pos.z + r < o.z0 || pos.z - r > o.z1) continue;
    }
    pos.y = o.y0 - h - 0.01;
    if (vel.y > 0) vel.y = 0;
  }
}

/**
 * Line-of-sight test in XZ (used by bots and by the hit-arc sanity check).
 * Coarse on purpose: samples along the segment against solid tops.
 */
export function blocked(world, ax, ay, az, bx, by, bz) {
  const dx = bx - ax, dz = bz - az, dy = by - ay;
  const dist = Math.hypot(dx, dz);
  const steps = Math.min(24, Math.max(2, Math.ceil(dist / 22)));
  for (let i = 1; i < steps; i++) {
    const f = i / steps;
    const x = ax + dx * f, z = az + dz * f, y = ay + dy * f;
    const ids = querySolids(world, x - 1, z - 1, x + 1, z + 1, _scratch);
    for (let n = 0; n < ids.length; n++) {
      const o = world.solids[ids[n]];
      if (o.y0 > y || o.y1 < y) continue;
      if (o.t === SHAPE.CYL) {
        const ddx = x - o.cx, ddz = z - o.cz;
        if (ddx * ddx + ddz * ddz < o.r * o.r) return true;
      } else if (o.t === SHAPE.BOX) {
        if (x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1) return true;
      }
    }
    if (terrainHeight(world, x, z) > y + 4) return true;
  }
  return false;
}

/* ------------------------------------------------------------- raycasting */

const _ray = [];

/**
 * Ray vs the world. Walks the solid grid along the ray and slab-tests every
 * candidate, then marches the terrain heightfield. Deterministic, so the client
 * can predict a grapple shot and the server will agree.
 *
 * @returns {{x,y,z,dist,kind,normalY}|null} nearest hit within maxDist
 */
export function raycast(world, ox, oy, oz, dx, dy, dz, maxDist) {
  let best = maxDist;
  let hit = null;

  // Broad phase: the AABB of the whole ray.
  const ex = ox + dx * maxDist, ey = oy + dy * maxDist, ez = oz + dz * maxDist;
  const ids = querySolids(world,
    Math.min(ox, ex) - 4, Math.min(oz, ez) - 4,
    Math.max(ox, ex) + 4, Math.max(oz, ez) + 4, _ray);

  const inv = (v) => (Math.abs(v) < 1e-8 ? 1e8 : 1 / v);
  const ix = inv(dx), iy = inv(dy), iz = inv(dz);

  for (let i = 0; i < ids.length; i++) {
    const o = world.solids[ids[i]];
    if (o.k === 'bounds') continue;

    // Slab test against the solid's AABB (cylinders and ramps use their box,
    // which is close enough for a hook and keeps this cheap).
    let t0 = (o.x0 - ox) * ix, t1 = (o.x1 - ox) * ix;
    if (t0 > t1) { const t = t0; t0 = t1; t1 = t; }
    let u0 = (o.y0 - oy) * iy, u1 = (o.y1 - oy) * iy;
    if (u0 > u1) { const t = u0; u0 = u1; u1 = t; }
    let v0 = (o.z0 - oz) * iz, v1 = (o.z1 - oz) * iz;
    if (v0 > v1) { const t = v0; v0 = v1; v1 = t; }

    const near = Math.max(t0, u0, v0, 0);
    const far = Math.min(t1, u1, v1);
    if (near > far || near >= best) continue;

    // Which slab produced the entry? That face is the surface normal, and
    // wall-running lives or dies on having a real one.
    let nx = 0, ny = 0, nz = 0;
    if (near === t0) nx = dx > 0 ? -1 : 1;
    else if (near === u0) ny = dy > 0 ? -1 : 1;
    else nz = dz > 0 ? -1 : 1;

    if (o.t === SHAPE.RAMP) {
      // Only accept the ramp if the ray is actually above its sloped surface
      // at the entry point, so hooks do not catch on the empty wedge.
      const px = ox + dx * near, pz = oz + dz * near, py = oy + dy * near;
      const top = solidTop(o, clamp(px, o.x0, o.x1), clamp(pz, o.z0, o.z1));
      if (top !== null && py < top - 6) continue;
    }

    best = near;
    hit = {
      x: ox + dx * near, y: oy + dy * near, z: oz + dz * near,
      dist: near, kind: o.k, solid: ids[i],
      nx, ny, nz, normalY: ny !== 0 ? 1 : 0,
      top: o.y1, bottom: o.y0,
    };
  }

  // Terrain: march until we are under the heightfield, then bisect.
  {
    const step = 14;
    let prev = 0;
    let prevAbove = oy - terrainHeight(world, ox, oz);
    for (let d = step; d <= Math.min(best, maxDist); d += step) {
      const x = ox + dx * d, y = oy + dy * d, z = oz + dz * d;
      const above = y - terrainHeight(world, x, z);
      if (above <= 0 && prevAbove > 0) {
        let lo = prev, hi = d;
        for (let k = 0; k < 8; k++) {
          const mid = (lo + hi) * 0.5;
          const my = oy + dy * mid;
          if (my - terrainHeight(world, ox + dx * mid, oz + dz * mid) > 0) lo = mid; else hi = mid;
        }
        if (hi < best) {
          best = hi;
          hit = {
            x: ox + dx * hi, y: oy + dy * hi, z: oz + dz * hi,
            dist: hi, kind: 'terrain', solid: -1,
            nx: 0, ny: 1, nz: 0, normalY: 1,
            top: oy + dy * hi, bottom: -1e4,
          };
        }
        break;
      }
      prev = d; prevAbove = above;
    }
  }

  return hit;
}

export { terrainHeight };

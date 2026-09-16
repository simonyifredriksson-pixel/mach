/**
 * VELOCITY RONIN — grappling hook.
 *
 * The hook is a physical object, not a teleport. Pressing G fires a head that
 * visibly travels; when it catches, the rope becomes a real constraint:
 *
 *   - a reel acceleration pulls you along the rope toward the anchor
 *   - the rope length clamps your distance, so anything sideways becomes a SWING
 *   - gravity keeps working, so a swing arcs and accelerates like a pendulum
 *   - releasing hands the momentum straight back to the movement system
 *
 * That last point is the whole design: grapple speed IS movement speed, and
 * movement speed IS damage. A well-timed release off a rooftop drops you into a
 * 400-speed strike with the blade already coming round.
 *
 * Deterministic and shared, so client prediction and the authority agree on
 * where the hook caught and how hard it pulled.
 */

import { CFG } from '../core/Config.js';
import { clamp, clamp01, lerp } from '../core/Util.js';
import { raycast } from './Physics.js';

export const GSTATE = { IDLE: 0, FIRING: 1, ATTACHED: 2 };

export function makeGrappleState() {
  return {
    state: GSTATE.IDLE,
    ax: 0, ay: 0, az: 0,        // anchor
    hx: 0, hy: 0, hz: 0,        // hook head position while in flight
    travel: 0,                  // distance flown
    total: 0,                   // distance to fly
    rope: 0,                    // current rope length
    time: 0,                    // time attached
    cooldown: 0,
    fired: 0,                   // id, bumped per shot (for one-shot FX)
    justAttached: false,
    justReleased: false,
    releaseSpeed: 0,
  };
}

/** Aim direction from yaw/pitch. forward = (-sin, -cos) at pitch 0. */
export function aimVector(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  out.x = -Math.sin(yaw) * cp;
  out.y = Math.sin(pitch);
  out.z = -Math.cos(yaw) * cp;
  return out;
}

const _dir = { x: 0, y: 0, z: 0 };

/**
 * Find something to hook. Casts from the player's shoulder along the aim, and
 * if the centre ray misses, sweeps a small cone so that shooting at speed does
 * not demand pixel-perfect aim. Never an auto-lock: the cone is ~4 degrees.
 */
export function findAnchor(world, px, py, pz, yaw, pitch) {
  const ox = px, oy = py + 13, oz = pz;
  const tryDir = (y, p) => {
    aimVector(y, p, _dir);
    const hit = raycast(world, ox, oy, oz, _dir.x, _dir.y, _dir.z, CFG.GRAPPLE_KEY_RANGE);
    if (!hit) return null;
    if (hit.dist < CFG.GRAPPLE_MIN_RANGE) return null;
    if (hit.y - py < CFG.GRAPPLE_ANCHOR_MIN_Y) return null;
    // Bias the catch point up a little. Hooking the lip of a roof instead of
    // the wall under it is the difference between vaulting onto it and
    // face-planting into it, and the player is aiming at the roof anyway.
    hit.y += CFG.GRAPPLE_ANCHOR_LIFT;
    return hit;
  };

  const direct = tryDir(yaw, pitch);
  if (direct) return direct;

  // Cone sweep: eight offsets on a small ring, nearest hit wins.
  const a = CFG.GRAPPLE_AIM_ASSIST;
  let best = null;
  for (let i = 0; i < 8; i++) {
    const ang = (i / 8) * Math.PI * 2;
    const hit = tryDir(yaw + Math.cos(ang) * a, clamp(pitch + Math.sin(ang) * a, -1.2, 1.2));
    if (hit && (!best || hit.dist < best.dist)) best = hit;
  }
  return best;
}

/**
 * Phase 1 — runs BEFORE the movement integration. Handles the state machine,
 * flies the hook, and adds the reel / swing acceleration to the velocity.
 */
export function stepGrapplePre(g, move, input, world, dt, yaw, pitch) {
  g.justAttached = false;
  g.justReleased = false;
  g.cooldown = Math.max(0, g.cooldown - dt);

  const pos = move.pos;

  /* ------------------------------------------------------------- release */
  if (g.state !== GSTATE.IDLE && input.grapple) {
    release(g, move);
    return;
  }

  /* ---------------------------------------------------------------- fire */
  if (g.state === GSTATE.IDLE) {
    if (input.grapple && g.cooldown <= 0) {
      const hit = findAnchor(world, pos.x, pos.y, pos.z, yaw, pitch);
      if (hit) {
        g.state = GSTATE.FIRING;
        g.ax = hit.x; g.ay = hit.y; g.az = hit.z;
        g.hx = pos.x; g.hy = pos.y + 13; g.hz = pos.z;
        g.travel = 0;
        g.total = hit.dist;
        g.time = 0;
        g.fired++;
      } else {
        // Missed: short cooldown so spamming G into the sky costs something.
        g.cooldown = CFG.GRAPPLE_COOLDOWN;
        g.fired++;
      }
    }
    return;
  }

  /* ------------------------------------------------------------- in flight */
  if (g.state === GSTATE.FIRING) {
    g.travel += CFG.GRAPPLE_HOOK_SPEED * dt;
    const f = clamp01(g.travel / Math.max(1, g.total));
    // The head flies from the shoulder to the anchor; the shoulder has moved,
    // so re-anchor the tail each tick and the cable stays attached to the hand.
    g.hx = lerp(pos.x, g.ax, f);
    g.hy = lerp(pos.y + 13, g.ay, f);
    g.hz = lerp(pos.z, g.az, f);
    if (f >= 1) {
      g.state = GSTATE.ATTACHED;
      g.justAttached = true;
      g.time = 0;
      g.rope = Math.max(CFG.GRAPPLE_DETACH_DIST,
        Math.hypot(g.ax - pos.x, g.ay - (pos.y + 13), g.az - pos.z));
    }
    return;
  }

  /* -------------------------------------------------------------- attached */
  g.time += dt;
  const cx = pos.x, cy = pos.y + 13, cz = pos.z;
  let dx = g.ax - cx, dy = g.ay - cy, dz = g.az - cz;
  let dist = Math.hypot(dx, dy, dz);

  if (dist < CFG.GRAPPLE_DETACH_DIST || g.time > CFG.GRAPPLE_MAX_TIME) {
    // Arriving at the anchor launches you off it rather than dumping you into
    // the surface — this is what makes roof-to-roof chaining work.
    release(g, move, dist < CFG.GRAPPLE_DETACH_DIST);
    return;
  }

  const nx = dx / dist, ny = dy / dist, nz = dz / dist;

  // Reel: strong close in, still meaningful at long range.
  const pull = Math.max(CFG.GRAPPLE_PULL_MIN, CFG.GRAPPLE_PULL * clamp01(1.25 - dist / 700));
  move.vel.x += nx * pull * dt;
  move.vel.y += ny * pull * dt;
  move.vel.z += nz * pull * dt;

  // Rope shortens while you hold on, which is what turns a hang into an arc.
  g.rope = Math.max(CFG.GRAPPLE_DETACH_DIST, Math.min(g.rope, dist) - CFG.GRAPPLE_REEL * dt);

  // Swing steering: push perpendicular to the rope, in the plane of travel.
  const mag = Math.hypot(input.mx, input.mz);
  if (mag > 0.02) {
    const s = Math.sin(yaw), c = Math.cos(yaw);
    let wx = -s * input.mz + c * input.mx;
    let wz = -c * input.mz - s * input.mx;
    const l = Math.hypot(wx, wz) || 1;
    wx /= l; wz /= l;
    // Strip the component along the rope so steering never fights the reel.
    const along = wx * nx + wz * nz;
    wx -= nx * along; wz -= nz * along;
    move.vel.x += wx * CFG.GRAPPLE_SWING_CTRL * dt;
    move.vel.z += wz * CFG.GRAPPLE_SWING_CTRL * dt;
  }

  move.grounded = false;
}

/**
 * Phase 2 — runs AFTER the movement integration. Enforces the rope as a hard
 * distance constraint, which is what makes a swing a swing instead of a drift.
 */
export function stepGrapplePost(g, move) {
  if (g.state !== GSTATE.ATTACHED) return;
  const pos = move.pos;
  const cx = pos.x, cy = pos.y + 13, cz = pos.z;
  const dx = cx - g.ax, dy = cy - g.ay, dz = cz - g.az;
  const dist = Math.hypot(dx, dy, dz);
  if (dist <= g.rope || dist < 1e-3) return;

  const nx = dx / dist, ny = dy / dist, nz = dz / dist;
  const pullBack = dist - g.rope;
  pos.x -= nx * pullBack;
  pos.y -= ny * pullBack;
  pos.z -= nz * pullBack;

  // Kill only the outward radial velocity; everything tangential is kept, so
  // the pendulum accelerates instead of dying against the rope.
  const radial = move.vel.x * nx + move.vel.y * ny + move.vel.z * nz;
  if (radial > 0) {
    move.vel.x -= nx * radial;
    move.vel.y -= ny * radial;
    move.vel.z -= nz * radial;
  }

  const sp = Math.hypot(move.vel.x, move.vel.z);
  if (sp > CFG.MAX_SPEED) {
    const k = CFG.MAX_SPEED / sp;
    move.vel.x *= k; move.vel.z *= k;
  }
  move.speed = Math.hypot(move.vel.x, move.vel.z);
}

export function release(g, move, arrived = false) {
  if (g.state === GSTATE.ATTACHED) {
    if (arrived) move.vel.y = Math.max(move.vel.y, CFG.GRAPPLE_ARRIVE_POP);
    // Hand the momentum back with a small kick, then respect the ceiling.
    move.vel.x *= CFG.GRAPPLE_RELEASE_BOOST;
    move.vel.z *= CFG.GRAPPLE_RELEASE_BOOST;
    const sp = Math.hypot(move.vel.x, move.vel.z);
    if (sp > CFG.MAX_SPEED) {
      const k = CFG.MAX_SPEED / sp;
      move.vel.x *= k; move.vel.z *= k;
    }
    move.speed = Math.hypot(move.vel.x, move.vel.z);
    g.justReleased = true;
    g.releaseSpeed = move.speed;
  }
  g.state = GSTATE.IDLE;
  g.cooldown = CFG.GRAPPLE_COOLDOWN;
  g.rope = 0;
  g.time = 0;
}

export function isGrappling(g) { return g.state === GSTATE.ATTACHED; }
export function isHookOut(g) { return g.state !== GSTATE.IDLE; }

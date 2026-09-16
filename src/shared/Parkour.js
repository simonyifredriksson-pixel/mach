/**
 * VELOCITY RONIN — parkour.
 *
 * Wall-running, wall-kicks, wall-climbs, ledge vaults and slides. One rule
 * governs all of it:
 *
 *   NOTHING HERE EVER RESETS YOUR SPEED. It only redirects it.
 *
 * Every transition is a projection or an impulse applied to the velocity you
 * already had. Hit a wall at 380 and you leave it at 380, pointed somewhere
 * else. That is what makes a route chainable: sprint -> jump -> wall-run ->
 * kick -> air -> grapple -> release -> land -> sprint reads as one continuous
 * motion because it IS one continuous velocity.
 *
 * Deterministic and shared, so the client predicts exactly what the authority
 * will do — a wall-run that only existed on your screen would be worse than no
 * wall-run at all.
 */

import { CFG } from '../core/Config.js';
import { clamp, clamp01, lerp } from '../core/Util.js';
import { raycast, groundInfo } from './Physics.js';

export const PSTATE = { NONE: 0, WALLRUN: 1, WALLCLIMB: 2, SLIDE: 3 };

export function makeParkourState() {
  return {
    state: PSTATE.NONE,
    timer: 0,
    // Wall contact
    nx: 0, nz: 0,            // wall normal (points away from the wall)
    side: 0,                 // -1 wall on your left, +1 on your right
    wallX: 0, wallZ: 0,      // contact point, for FX
    // Re-attach guard: you cannot climb the same wall like a ladder.
    lastNX: 0, lastNZ: 0, lastWallAt: -99,
    // Slide
    slideTime: 0,
    vaultCooldown: 0,
    // One-shot flags for the renderer / audio
    justWallrun: false,
    justKick: false,
    justVault: false,
    justSlide: false,
    justSlideEnd: false,
    kickX: 0, kickZ: 0,
    contactSpeed: 0,
  };
}

const _g = { y: 0, nx: 0, ny: 1, nz: 0, kind: 'terrain', solid: -1 };

/** Horizontal probe from chest height. Returns the hit or null. */
function probe(world, pos, dx, dz, dist) {
  return raycast(world, pos.x, pos.y + 11, pos.z, dx, 0, dz, dist);
}

/** Only near-vertical faces are wall-runnable. */
function isVertical(hit) {
  return hit && Math.abs(hit.ny) < 0.4 && (Math.abs(hit.nx) > 0.6 || Math.abs(hit.nz) > 0.6);
}

/**
 * Phase 1 — before movement integration. Owns wall detection, the wall-run /
 * climb / slide state machines, and every impulse they produce.
 *
 * @param {object} pk     parkour state
 * @param {object} move   move state
 * @param {object} input  {mx,mz,yaw,sprint,jump,crouch}
 * @param {object} world
 * @param {number} dt
 * @param {number} time   sim time, for the re-attach guard
 * @param {boolean} grappling
 */
export function stepParkourPre(pk, move, input, world, dt, time, grappling) {
  pk.justWallrun = pk.justKick = pk.justVault = pk.justSlide = pk.justSlideEnd = false;
  pk.vaultCooldown = Math.max(0, pk.vaultCooldown - dt);

  const vel = move.vel;
  const pos = move.pos;
  let speed = Math.hypot(vel.x, vel.z);
  // Reset the per-tick overrides; whatever runs below re-asserts what it needs.
  move.gravityScale = 1;
  move.slopeGain = CFG.SLOPE_GAIN;

  // The grapple outranks everything: a rope in flight owns your trajectory.
  if (grappling && pk.state !== PSTATE.NONE) endWall(pk, time);

  /* =================================================================== slide */
  if (pk.state === PSTATE.SLIDE) {
    pk.slideTime += dt;
    const wantOut = !input.crouch && pk.slideTime > CFG.SLIDE_MIN_TIME;
    if (!move.grounded || speed < 90 || wantOut) {
      pk.state = PSTATE.NONE;
      pk.justSlideEnd = true;
    } else {
      // Slides are a friction hole, not an engine: flat ground bleeds slowly,
      // downhill accelerates hard, uphill kills it. Routes get read as terrain.
      move.mods.friction *= CFG.SLIDE_FRICTION;
      move.mods.turn *= CFG.SLIDE_TURN;
      move.mods.accel *= 0.25;
      move.slopeGain = CFG.SLIDE_SLOPE_GAIN;
      if (input.jump) {
        // Slide hop: everything you had, launched.
        pk.state = PSTATE.NONE;
        pk.justSlideEnd = true;
      }
      return;
    }
  } else if (input.crouch && move.grounded && speed >= CFG.SLIDE_MIN_SPEED && !grappling) {
    pk.state = PSTATE.SLIDE;
    pk.slideTime = 0;
    pk.justSlide = true;
    const k = CFG.SLIDE_ENTRY_BOOST;
    vel.x *= k; vel.z *= k;
    speed = Math.hypot(vel.x, vel.z);
    if (speed > CFG.MAX_SPEED) {
      const c = CFG.MAX_SPEED / speed;
      vel.x *= c; vel.z *= c;
    }
    return;
  }

  /* ============================================================== wall climb */
  if (pk.state === PSTATE.WALLCLIMB) {
    pk.timer += dt;
    const ahead = probe(world, pos, -pk.nx, -pk.nz, CFG.PLAYER_RADIUS + CFG.WALL_PROBE);
    const stillOn = isVertical(ahead) && ahead.dist < CFG.PLAYER_RADIUS + CFG.WALL_PROBE;
    if (pk.timer > CFG.WALLCLIMB_MAX_TIME || !stillOn || move.grounded || input.jump) {
      if (input.jump && stillOn) kick(pk, move, time);
      else endWall(pk, time);
    } else {
      // Trade horizontal speed for height. You do not get free altitude.
      move.gravityScale = 0.08;
      vel.y += CFG.WALLCLIMB_ACCEL * dt;
      const bleed = Math.max(0, 1 - CFG.WALLCLIMB_COST * dt);
      vel.x *= bleed; vel.z *= bleed;
      vel.x += pk.nx * 40 * dt;      // gentle push in so you stay on the face
      vel.z += pk.nz * 40 * dt;
      move.mods.turn *= 0.3;
      return;
    }
  }

  /* =============================================================== wall run */
  if (pk.state === PSTATE.WALLRUN) {
    pk.timer += dt;
    const into = probe(world, pos, -pk.nx, -pk.nz, CFG.PLAYER_RADIUS + CFG.WALL_PROBE + 6);
    const attached = isVertical(into);

    // Pushing away from the wall lets go — a deliberate, readable exit.
    let pushAway = 0;
    if (Math.hypot(input.mx, input.mz) > 0.02) {
      const s = Math.sin(input.yaw), c = Math.cos(input.yaw);
      const wx = -s * input.mz + c * input.mx;
      const wz = -c * input.mz - s * input.mx;
      pushAway = wx * pk.nx + wz * pk.nz;
    }

    if (input.jump) { kick(pk, move, time); return; }
    if (!attached || move.grounded || pk.timer > CFG.WALLRUN_MAX_TIME
      || speed < CFG.WALLRUN_EXIT_SPEED || pushAway > 0.55) {
      endWall(pk, time);
    } else {
      pk.nx = into.nx; pk.nz = into.nz;
      pk.wallX = into.x; pk.wallZ = into.z;

      // Gravity ramps back in, so a wall-run is an arc with a natural end
      // rather than a ledge you can park on.
      const ramp = clamp01(pk.timer / CFG.WALLRUN_GRAV_RAMP);
      move.gravityScale = lerp(CFG.WALLRUN_GRAV_START, CFG.WALLRUN_GRAV_END, ramp * ramp);

      // Kill any velocity going INTO the wall, keep everything along it.
      const into2 = vel.x * pk.nx + vel.z * pk.nz;
      if (into2 < 0) { vel.x -= pk.nx * into2; vel.z -= pk.nz * into2; }
      // Light inward hold so small bumps do not throw you off.
      vel.x -= pk.nx * CFG.WALLRUN_STICK * dt;
      vel.z -= pk.nz * CFG.WALLRUN_STICK * dt;

      // Drive along the wall with the stick, and you can still accelerate.
      const along = { x: -pk.nz, z: pk.nx };
      const dir = Math.sign(vel.x * along.x + vel.z * along.z) || 1;
      if (input.sprint) {
        const cur = Math.hypot(vel.x, vel.z);
        if (cur < CFG.MAX_SPEED) {
          vel.x += along.x * dir * CFG.WALLRUN_ACCEL * dt;
          vel.z += along.z * dir * CFG.WALLRUN_ACCEL * dt;
        }
      }
      move.mods.turn *= 0.22;
      move.mods.accel *= 0.15;

      const sp = Math.hypot(vel.x, vel.z);
      if (sp > CFG.MAX_SPEED) { const c = CFG.MAX_SPEED / sp; vel.x *= c; vel.z *= c; }
      return;
    }
  }

  /* ======================================================= look for a wall */
  if (pk.state === PSTATE.NONE && !move.grounded && !grappling && speed > CFG.WALLRUN_MIN_SPEED
    && vel.y > -300 && time - pk.lastWallAt > CFG.WALLRUN_REATTACH_TIME * 0.5) {

    const fx = vel.x / speed, fz = vel.z / speed;
    const reach = CFG.PLAYER_RADIUS + CFG.WALL_PROBE;

    // Head-on into a wall while airborne and holding forward -> climb it.
    const front = probe(world, pos, fx, fz, reach);
    if (isVertical(front)) {
      const facing = -(fx * front.nx + fz * front.nz);       // 1 = dead on
      const sameWall = pk.lastNX * front.nx + pk.lastNZ * front.nz > 0.9
        && time - pk.lastWallAt < CFG.WALLRUN_REATTACH_TIME;
      if (!sameWall && facing > 0.72 && speed > CFG.WALLCLIMB_MIN_SPEED && input.mz > 0.3) {
        pk.state = PSTATE.WALLCLIMB;
        pk.timer = 0;
        pk.nx = front.nx; pk.nz = front.nz;
        pk.side = 0;
        pk.wallX = front.x; pk.wallZ = front.z;
        pk.contactSpeed = speed;
        pk.justWallrun = true;
        return;
      }
    }

    // Shoulder probes: left and right of travel.
    const leftX = fz, leftZ = -fx;
    for (const side of [-1, 1]) {
      const dx = leftX * side, dz = leftZ * side;
      const hit = probe(world, pos, dx, dz, reach);
      if (!isVertical(hit)) continue;
      const sameWall = pk.lastNX * hit.nx + pk.lastNZ * hit.nz > 0.9
        && time - pk.lastWallAt < CFG.WALLRUN_REATTACH_TIME;
      if (sameWall) continue;
      // You must be travelling ALONG the surface, not into it.
      const intoWall = -(fx * hit.nx + fz * hit.nz);
      if (Math.abs(intoWall) > Math.sin(CFG.WALLRUN_ALIGN + 0.55)) continue;

      pk.state = PSTATE.WALLRUN;
      pk.timer = 0;
      pk.nx = hit.nx; pk.nz = hit.nz;
      pk.side = side > 0 ? 1 : -1;
      pk.wallX = hit.x; pk.wallZ = hit.z;
      pk.contactSpeed = speed;
      pk.justWallrun = true;
      // Project onto the wall plane and pop up slightly: the entry should feel
      // like being caught and flung, never like hitting something.
      const d = vel.x * hit.nx + vel.z * hit.nz;
      if (d < 0) { vel.x -= hit.nx * d; vel.z -= hit.nz * d; }
      vel.y = Math.max(vel.y, CFG.WALLRUN_ENTRY_UP * clamp01(speed / 320));
      return;
    }
  }

  /* ================================================================= vault */
  // Flow over low ledges instead of stopping dead on them. This is the single
  // biggest contributor to "the movement never feels interrupted".
  if (pk.state === PSTATE.NONE && speed > CFG.VAULT_MIN_SPEED && pk.vaultCooldown <= 0) {
    const fx = vel.x / speed, fz = vel.z / speed;
    const hit = probe(world, pos, fx, fz, CFG.PLAYER_RADIUS + 12);
    if (hit && Math.abs(hit.ny) < 0.5 && hit.top !== undefined) {
      const rise = hit.top - pos.y;
      if (rise > CFG.STEP_HEIGHT && rise < CFG.VAULT_MAX_RISE) {
        // Is there room to stand up there?
        const ax = pos.x + fx * (CFG.PLAYER_RADIUS + 18);
        const az = pos.z + fz * (CFG.PLAYER_RADIUS + 18);
        const g = groundInfo(world, ax, az, hit.top + 2, CFG.STEP_HEIGHT, _g);
        if (Math.abs(g.y - hit.top) < CFG.VAULT_CLEAR) {
          // Exactly enough upward velocity to clear the lip, no more. Forward
          // speed is untouched, so the vault costs nothing but a little height.
          const need = Math.sqrt(2 * CFG.GRAVITY * (rise + 6));
          if (vel.y < need) vel.y = need;
          pk.vaultCooldown = CFG.VAULT_COOLDOWN;
          pk.justVault = true;
        }
      }
    }
  }
}

/** Kick off the wall: keep the along-wall run, add out and up. */
function kick(pk, move, time) {
  const vel = move.vel;
  const nx = pk.nx, nz = pk.nz;
  // Split the current velocity into along-wall and into-wall parts.
  const into = vel.x * nx + vel.z * nz;
  let ax = vel.x - nx * into, az = vel.z - nz * into;
  ax *= CFG.WALLKICK_KEEP; az *= CFG.WALLKICK_KEEP;

  vel.x = ax + nx * CFG.WALLKICK_OUT;
  vel.z = az + nz * CFG.WALLKICK_OUT;
  vel.y = Math.max(vel.y, 0) + CFG.WALLKICK_UP;

  const sp = Math.hypot(vel.x, vel.z);
  if (sp > CFG.MAX_SPEED) { const c = CFG.MAX_SPEED / sp; vel.x *= c; vel.z *= c; }
  move.speed = Math.hypot(vel.x, vel.z);
  move.grounded = false;

  pk.justKick = true;
  pk.kickX = nx; pk.kickZ = nz;
  endWall(pk, time);
}

function endWall(pk, time) {
  if (pk.state === PSTATE.WALLRUN || pk.state === PSTATE.WALLCLIMB) {
    pk.lastNX = pk.nx; pk.lastNZ = pk.nz; pk.lastWallAt = time;
  }
  pk.state = PSTATE.NONE;
  pk.timer = 0;
}

/** Phase 2 — after integration. Drops wall state the moment you touch down. */
export function stepParkourPost(pk, move, time) {
  if (move.grounded && (pk.state === PSTATE.WALLRUN || pk.state === PSTATE.WALLCLIMB)) {
    endWall(pk, time);
  }
  if (move.grounded) { pk.lastWallAt = -99; pk.lastNX = 0; pk.lastNZ = 0; }
}

export const isWallrunning = (pk) => pk.state === PSTATE.WALLRUN;
export const isSliding = (pk) => pk.state === PSTATE.SLIDE;
export const onWall = (pk) => pk.state === PSTATE.WALLRUN || pk.state === PSTATE.WALLCLIMB;

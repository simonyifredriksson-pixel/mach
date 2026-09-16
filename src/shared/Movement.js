/**
 * [MACH] — movement.
 *
 * The whole design sits on one curve: steering authority collapses as speed
 * rises. At a walk you can reverse direction inside a tick. At 500 you get
 * ~66 degrees per second, which is a 100-metre turning circle. Speed is not a
 * stat you buy, it is a commitment you make.
 *
 * Deterministic and side-effect free apart from `p` — the client predicts with
 * this exact function, so corrections stay in the noise.
 */

import { CFG, speedT } from '../core/Config.js';
import { clamp, clamp01, lerp, angleDelta } from '../core/Util.js';
import { groundInfo, resolveHorizontal, resolveCeiling } from './Physics.js';

const TURN_SCRUB = 0.10;      // momentum lost per radian of hard steering
const BRAKE_ANGLE = 2.05;     // input this far from velocity = active braking
const LAND_SNAP = 1.5;

const _g = { y: 0, nx: 0, ny: 1, nz: 0, kind: 'terrain', solid: -1 };

export function makeMoveState() {
  return {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    speed: 0,
    grounded: true,
    groundKind: 'terrain',
    groundY: 0,
    slope: 0,
    coyote: 0,
    jumpBuffer: 0,
    wasGrounded: true,
    landImpact: 0,
    airTime: 0,
    mods: { turn: 1, accel: 1, friction: 1 },
  };
}

/**
 * One fixed movement tick.
 * @param {object} p      move state (mutated)
 * @param {object} input  {mx, mz, yaw, sprint, jump}
 * @param {object} world  shared world
 * @param {number} dt     fixed timestep
 * @param {object} [ev]   optional {jumped, landed, landSpeed} output flags
 */
export function stepPlayer(p, input, world, dt, ev) {
  if (ev) { ev.jumped = false; ev.landed = false; ev.landSpeed = 0; }
  const mods = p.mods;

  let vx = p.vel.x, vz = p.vel.z;
  let speed = Math.hypot(vx, vz);
  const t = speedT(speed);

  /* ------------------------------------------------------- wish direction */
  let wx = 0, wz = 0, wishMag = 0;
  {
    const mx = input.mx, mz = input.mz;
    wishMag = Math.min(1, Math.hypot(mx, mz));
    if (wishMag > 0.02) {
      const s = Math.sin(input.yaw), c = Math.cos(input.yaw);
      // forward = (-sin, -cos), right = (cos, -sin)
      const fx = -s * mz, fz = -c * mz;
      const rx = c * mx, rz = -s * mx;
      wx = fx + rx; wz = fz + rz;
      const l = Math.hypot(wx, wz) || 1;
      wx /= l; wz /= l;
    }
  }

  const airMulTurn = p.grounded ? 1 : CFG.AIR_TURN_MULT;
  const airMulAcc = p.grounded ? 1 : CFG.AIR_ACCEL_MULT;
  const turnRate = lerp(CFG.TURN_RATE_LOW, CFG.TURN_RATE_HIGH, Math.pow(t, CFG.TURN_CURVE)) * mods.turn * airMulTurn;
  const accel = Math.max(CFG.ACCEL_BASE * (1 - Math.pow(t, CFG.ACCEL_FALLOFF)), CFG.ACCEL_MIN) * mods.accel * airMulAcc;
  const capSpeed = input.sprint ? CFG.MAX_SPEED : CFG.WALK_MAX;

  if (wishMag > 0.02) {
    if (speed < 2) {
      // Standing start: point the velocity straight at the input.
      speed = Math.min(capSpeed, accel * dt);
      vx = wx * speed; vz = wz * speed;
    } else {
      const cur = Math.atan2(vz, vx);
      const want = Math.atan2(wz, wx);
      const d = angleDelta(cur, want);
      const maxTurn = turnRate * dt;
      const applied = clamp(d, -maxTurn, maxTurn);
      const na = cur + applied;

      // Scrubbing: carving costs momentum, which is what stops "turn at 500".
      speed *= 1 - Math.min(0.5, Math.abs(applied) * TURN_SCRUB);

      if (Math.abs(d) > BRAKE_ANGLE) {
        speed -= CFG.BRAKE_DECEL * dt * mods.friction * (p.grounded ? 1 : 0.35);
      } else if (speed < capSpeed) {
        speed = Math.min(capSpeed, speed + accel * dt * wishMag);
      } else {
        speed = Math.max(capSpeed, speed - CFG.OVERSPEED_DECEL * dt);
      }
      speed = Math.max(0, speed);
      vx = Math.cos(na) * speed; vz = Math.sin(na) * speed;
    }
  } else if (p.grounded) {
    const fr = (CFG.FRICTION_BASE + speed * CFG.FRICTION_DRAG) * mods.friction;
    const ns = Math.max(0, speed - fr * dt);
    if (speed > 1e-4) { const k = ns / speed; vx *= k; vz *= k; }
    speed = ns;
  } else if (speed > capSpeed) {
    speed = Math.max(capSpeed, speed - CFG.OVERSPEED_DECEL * 0.4 * dt);
    const k = speed / Math.max(1e-4, Math.hypot(vx, vz));
    vx *= k; vz *= k;
  }

  /* --------------------------------------------------------- air control */
  // Airborne, the input gets a pure lateral nudge on top of the (reduced)
  // steering above. It is enough to shape a jump, thread a gap or line up a
  // landing — and far too little to reverse a 400-speed commitment.
  if (!p.grounded && wishMag > 0.02 && speed > 1) {
    const cx = vx / speed, cz = vz / speed;
    const along = wx * cx + wz * cz;
    let sx = wx - cx * along, sz = wz - cz * along;
    const sl = Math.hypot(sx, sz);
    if (sl > 1e-4) {
      sx /= sl; sz /= sl;
      const auth = CFG.AIR_STRAFE * (1 - t * 0.55) * mods.accel;
      vx += sx * auth * dt * wishMag;
      vz += sz * auth * dt * wishMag;
    }
  }

  /* ------------------------------------------------------------ the slopes */
  if (p.grounded) {
    const slopeMag = Math.hypot(p.groundNX || 0, p.groundNZ || 0);
    if (slopeMag > 0.02) {
      vx += (p.groundNX || 0) * CFG.GRAVITY * CFG.SLOPE_GAIN * dt;
      vz += (p.groundNZ || 0) * CFG.GRAVITY * CFG.SLOPE_GAIN * dt;
    }
  }

  // Hard ceiling. 500 is the law.
  speed = Math.hypot(vx, vz);
  if (speed > CFG.MAX_SPEED) {
    const k = CFG.MAX_SPEED / speed;
    vx *= k; vz *= k; speed = CFG.MAX_SPEED;
  }
  p.vel.x = vx; p.vel.z = vz;

  /* ------------------------------------------------------------- vertical */
  p.coyote = p.grounded ? CFG.COYOTE_TIME : Math.max(0, p.coyote - dt);
  p.jumpBuffer = input.jump ? CFG.JUMP_BUFFER : Math.max(0, p.jumpBuffer - dt);

  if (p.jumpBuffer > 0 && p.coyote > 0) {
    p.vel.y = CFG.JUMP_VELOCITY;
    p.grounded = false;
    p.coyote = 0;
    p.jumpBuffer = 0;
    if (ev) ev.jumped = true;
  }
  if (!p.grounded) p.vel.y -= CFG.GRAVITY * dt;

  /* ----------------------------------------------------------- integrate */
  const R = CFG.PLAYER_RADIUS, H = CFG.PLAYER_HEIGHT, STEP = CFG.STEP_HEIGHT;
  const disp = speed * dt;
  const sub = Math.min(4, Math.max(1, Math.ceil(disp / (R * 0.7))));
  const sdt = dt / sub;

  for (let i = 0; i < sub; i++) {
    p.pos.x += p.vel.x * sdt;
    p.pos.z += p.vel.z * sdt;
    resolveHorizontal(world, p.pos, p.vel, R, H, STEP);
  }

  p.pos.y += p.vel.y * dt;
  resolveCeiling(world, p.pos, p.vel, R, H, STEP);

  const g = groundInfo(world, p.pos.x, p.pos.z, p.pos.y, STEP, _g);
  p.groundNX = g.nx; p.groundNZ = g.nz;
  p.slope = 1 - g.ny;

  const wasGrounded = p.grounded;
  p.airTime = p.grounded ? 0 : p.airTime + dt;
  if (p.vel.y <= 0 && p.pos.y <= g.y + LAND_SNAP) {
    if (!wasGrounded && ev) { ev.landed = true; ev.landSpeed = -p.vel.y; ev.airTime = p.airTime; }
    p.pos.y = g.y;
    p.vel.y = 0;
    p.grounded = true;
    p.groundKind = g.kind;
  } else if (p.pos.y < g.y) {
    p.pos.y = g.y;
    if (p.vel.y < 0) p.vel.y = 0;
    p.grounded = true;
    p.groundKind = g.kind;
  } else {
    p.grounded = false;
  }
  p.groundY = g.y;

  // Safety net: nothing may leave the arena.
  p.pos.x = clamp(p.pos.x, -CFG_HALF + R, CFG_HALF - R);
  p.pos.z = clamp(p.pos.z, -CFG_HALF + R, CFG_HALF - R);
  if (p.pos.y < -400) { p.pos.y = g.y; p.vel.y = 0; }

  p.speed = Math.hypot(p.vel.x, p.vel.z);
  p.wasGrounded = wasGrounded;
  return p;
}

const CFG_HALF = 2600;

/** Facing of travel — used by the renderer and by the katana arc. */
export function velocityYaw(p, fallback) {
  if (p.speed < 8) return fallback;
  return Math.atan2(-p.vel.x, -p.vel.z);
}

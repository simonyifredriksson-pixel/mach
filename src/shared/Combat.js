/**
 * [MACH] — katana state machine + hit geometry.
 *
 * Shared so the client can predict the swing (instant animation, no input lag)
 * while the authority owns whether it actually connected.
 *
 * The anti-snowball rule lives in `attackArc`: reach and arc both shrink as you
 * go faster. At a walk the blade covers a 150-degree fan. At 500 it is a
 * 48-degree sliver that you are travelling through at 8 units per millisecond.
 * The damage is enormous; the window is not.
 */

import { CFG, speedT } from '../core/Config.js';
import { lerp, clamp01, angleDelta } from '../core/Util.js';

export const WSTATE = {
  SHEATHED: 0, DRAWING: 1, READY: 2, SHEATHING: 3, WINDUP: 4, ACTIVE: 5, RECOVER: 6,
};

export const ATTACK = { SLASH: 0, IAI: 1 };

export function makeCombatState() {
  return {
    state: WSTATE.SHEATHED,
    timer: 0,
    attackType: ATTACK.SLASH,
    swingIndex: 0,       // 0 = right-to-left, 1 = left-to-right, 2 = rising (air)
    attackId: 0,
    hitLanded: false,
    buffered: false,
    lastWhiff: false,
    phase: 0,            // 0..1 through the current state, for animation
  };
}

const EV = { startWindup: false, active: false, endActive: false, whiff: false, draw: false, sheathe: false, ready: false };

/**
 * One fixed combat tick. Mutates `c` and writes movement multipliers into
 * `mods`. Returns a flags object (reused — copy what you need).
 */
export function stepCombat(c, input, dt, mods, grounded) {
  EV.startWindup = EV.active = EV.endActive = EV.whiff = EV.draw = EV.sheathe = EV.ready = false;
  c.timer -= dt;

  const beginAttack = (type) => {
    c.state = WSTATE.WINDUP;
    c.attackType = type;
    c.timer = type === ATTACK.IAI ? CFG.IAI.windup : CFG.SWING.windup;
    c.hitLanded = false;
    c.buffered = false;
    c.attackId++;
    c.swingIndex = !grounded ? 2 : (c.swingIndex === 0 ? 1 : 0);
    EV.startWindup = true;
  };

  switch (c.state) {
    case WSTATE.SHEATHED:
      if (input.attack) beginAttack(ATTACK.IAI);          // iai — quick draw
      else if (input.sheathe) { c.state = WSTATE.DRAWING; c.timer = CFG.DRAW_TIME; EV.draw = true; }
      break;

    case WSTATE.DRAWING:
      if (input.attack) c.buffered = true;
      if (c.timer <= 0) {
        c.state = WSTATE.READY; EV.ready = true;
        if (c.buffered) beginAttack(ATTACK.SLASH);
      }
      break;

    case WSTATE.READY:
      if (input.attack) beginAttack(ATTACK.SLASH);
      else if (input.sheathe) { c.state = WSTATE.SHEATHING; c.timer = CFG.SHEATHE_TIME; EV.sheathe = true; }
      break;

    case WSTATE.SHEATHING:
      if (input.attack) { beginAttack(ATTACK.SLASH); break; }  // cancel back out
      if (c.timer <= 0) c.state = WSTATE.SHEATHED;
      break;

    case WSTATE.WINDUP:
      if (c.timer <= 0) {
        c.state = WSTATE.ACTIVE;
        c.timer = c.attackType === ATTACK.IAI ? CFG.IAI.active : CFG.SWING.active;
        EV.active = true;
      }
      break;

    case WSTATE.ACTIVE:
      if (c.timer <= 0) {
        const tbl = c.attackType === ATTACK.IAI ? CFG.IAI : CFG.SWING;
        c.lastWhiff = !c.hitLanded;
        c.state = WSTATE.RECOVER;
        c.timer = c.hitLanded ? tbl.recover : tbl.whiffRecover;
        EV.endActive = true;
        EV.whiff = c.lastWhiff;
      }
      break;

    case WSTATE.RECOVER:
      // Late-buffered inputs chain into the next swing for a clean combo feel,
      // but only if the previous one connected. Missing costs you the tempo.
      if (input.attack && !c.lastWhiff && c.timer < 0.10) c.buffered = true;
      if (c.timer <= 0) {
        c.state = WSTATE.READY;
        if (c.buffered) beginAttack(ATTACK.SLASH);
      }
      break;
  }

  // Movement multipliers — this is the *cost* half of the combat contract.
  mods.turn = 1; mods.accel = 1; mods.friction = 1;
  switch (c.state) {
    case WSTATE.WINDUP:
    case WSTATE.ACTIVE:
      mods.turn = CFG.ATTACK_TURN_MULT;
      mods.accel = CFG.ATTACK_ACCEL_MULT;
      break;
    case WSTATE.RECOVER:
      if (c.lastWhiff) {
        mods.turn = CFG.WHIFF_TURN_MULT;
        mods.accel = 0.22;
        mods.friction = CFG.WHIFF_FRICTION_MULT;
      } else {
        mods.turn = 0.7; mods.accel = 0.8;
      }
      break;
    case WSTATE.DRAWING:
    case WSTATE.SHEATHING:
      mods.turn = 0.88; mods.accel = 0.9;
      break;
  }

  // Normalised phase for animation.
  const dur = stateDuration(c);
  c.phase = dur > 0 ? clamp01(1 - c.timer / dur) : 0;
  return EV;
}

function stateDuration(c) {
  const tbl = c.attackType === ATTACK.IAI ? CFG.IAI : CFG.SWING;
  switch (c.state) {
    case WSTATE.WINDUP: return tbl.windup;
    case WSTATE.ACTIVE: return tbl.active;
    case WSTATE.RECOVER: return c.lastWhiff ? tbl.whiffRecover : tbl.recover;
    case WSTATE.DRAWING: return CFG.DRAW_TIME;
    case WSTATE.SHEATHING: return CFG.SHEATHE_TIME;
    default: return 0;
  }
}

export function isAttacking(c) {
  return c.state === WSTATE.WINDUP || c.state === WSTATE.ACTIVE;
}
export function isVulnerable(c) {
  return c.state === WSTATE.RECOVER && c.lastWhiff;
}

/**
 * Blade coverage for a given speed. Both numbers shrink with velocity, so the
 * 250-damage hit demands a near-perfect intercept line.
 */
export function attackArc(speed) {
  const t = speedT(speed);
  return {
    reach: lerp(CFG.REACH_LOW, CFG.REACH_HIGH, t),
    halfAngle: lerp(CFG.ARC_LOW, CFG.ARC_HIGH, Math.pow(t, CFG.ARC_CURVE)),
  };
}

/**
 * Pure geometric test: does the blade of `a` (aiming along aimYaw at `speed`)
 * reach the torso sphere of `b`? Positions are feet-level.
 */
export function bladeHits(ax, ay, az, aimYaw, speed, bx, by, bz) {
  const arc = attackArc(speed);
  const cy = ay + CFG.HIT_SPHERE_Y;
  const ty = by + CFG.HIT_SPHERE_Y;
  if (Math.abs(ty - cy) > CFG.VERTICAL_REACH + CFG.HIT_SPHERE_R) return null;

  const dx = bx - ax, dz = bz - az;
  const dist = Math.hypot(dx, dz);
  if (dist > arc.reach + CFG.HIT_SPHERE_R) return null;

  // Angular slack from the target's radius at this distance.
  const slack = Math.atan2(CFG.HIT_SPHERE_R, Math.max(6, dist));
  // Aim yaw -> direction angle in the (dx, dz) plane. forward = (-sin, -cos).
  const face = Math.atan2(-Math.cos(aimYaw), -Math.sin(aimYaw));
  const toTarget = Math.atan2(dz, dx);
  const off = Math.abs(angleDelta(face, toTarget));
  if (off > arc.halfAngle + slack) return null;

  // Quality 1 = dead centre of the arc at point-blank.
  const quality = clamp01(1 - off / (arc.halfAngle + slack)) * clamp01(1 - dist / (arc.reach + CFG.HIT_SPHERE_R)) ** 0.5;
  return { dist, off, quality };
}

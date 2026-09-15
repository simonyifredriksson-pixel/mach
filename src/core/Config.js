/**
 * [MACH] — central balance & tuning table.
 *
 * Everything that defines how the game FEELS lives here. This file is shared
 * verbatim by the authoritative simulation (server / loopback authority) and by
 * the client's prediction layer, so both sides always agree.
 *
 * World scale: 10 world units = 1 metre. A player is 18u tall (1.8 m).
 * Speed is therefore quoted directly in world units / second, which is the
 * number the HUD shows. MAX_SPEED 500 ~= 50 m/s ~= 180 km/h.
 */

export const CFG = {
  /* ---------------------------------------------------------------- core */
  MAX_SPEED: 500,          // hard ceiling — never exceeded, ever
  DAMAGE_MULTIPLIER: 0.5,  // DAMAGE = SPEED * 0.5
  MAX_HEALTH: 250,         // exactly one 500-speed hit. Speed is lethal.

  /* --------------------------------------------------------- simulation */
  TICK_RATE: 60,
  SNAPSHOT_RATE: 30,
  INTERP_DELAY: 0.10,      // remote-player render delay (s)
  MAX_REWIND: 0.30,        // lag-compensation clamp (s)
  HISTORY_SECONDS: 0.6,

  /* ----------------------------------------------------------- movement */
  WALK_MAX: 115,           // no sprint
  // Roughly 2.5-3.5 s from a walk to 500 on a clean straight, and the last
  // 50 units of that take almost a second. Top speed is earned, not toggled.
  ACCEL_BASE: 620,         // u/s^2 at a standstill
  ACCEL_FALLOFF: 1.25,     // higher = harder to reach top speed
  ACCEL_MIN: 34,           // the last stretch to 500 is a grind
  FRICTION_BASE: 250,      // decel with no input
  FRICTION_DRAG: 0.55,     // + this * speed
  BRAKE_DECEL: 900,        // holding against your own velocity
  OVERSPEED_DECEL: 420,    // shedding speed above the current cap

  // Steering authority. This is the heart of the risk/reward curve: the faster
  // you go, the less you can change your mind.
  // At 0: ~690 deg/s, instant. At 250: ~250 deg/s. At 500: 66 deg/s, which is
  // a 400-unit turning circle — you commit to a line long before you arrive.
  TURN_RATE_LOW: 12.0,     // rad/s of velocity re-aim at 0 speed
  TURN_RATE_HIGH: 1.15,    // rad/s at MAX_SPEED — barely steerable
  TURN_CURVE: 0.70,
  AIR_TURN_MULT: 0.45,
  AIR_ACCEL_MULT: 0.38,
  ATTACK_TURN_MULT: 0.45,  // committed during a swing
  ATTACK_ACCEL_MULT: 0.35,
  WHIFF_TURN_MULT: 0.30,   // punished for missing
  WHIFF_FRICTION_MULT: 2.1,

  GRAVITY: 950,
  JUMP_VELOCITY: 215,
  COYOTE_TIME: 0.10,
  JUMP_BUFFER: 0.12,
  SLOPE_GAIN: 1.35,        // gravity fed along slopes: ramps build real speed
  MAX_SLOPE_COS: 0.55,     // steeper than this is a wall

  /* ---------------------------------------------------------- character */
  PLAYER_RADIUS: 9,
  PLAYER_HEIGHT: 18,
  STEP_HEIGHT: 7,
  HIT_SPHERE_Y: 10,        // torso centre, from feet
  HIT_SPHERE_R: 8.5,

  /* ------------------------------------------------------------- katana */
  // Reach and arc both TIGHTEN with speed. Big damage demands real precision.
  REACH_LOW: 36,
  REACH_HIGH: 27,
  ARC_LOW: 1.30,           // half-angle rad at low speed (~75 deg)
  ARC_HIGH: 0.42,          // half-angle rad at 500 (~24 deg)
  ARC_CURVE: 0.80,
  VERTICAL_REACH: 22,

  SWING: {                 // drawn-blade slash
    windup: 0.115,
    active: 0.075,
    recover: 0.215,
    whiffRecover: 0.50,
  },
  IAI: {                   // quick-draw from the sheath
    windup: 0.215,
    active: 0.085,
    recover: 0.285,
    whiffRecover: 0.58,
  },
  DRAW_TIME: 0.32,
  SHEATHE_TIME: 0.30,
  IFRAME: 0.34,            // post-hit immunity, stops double-taps
  HIT_SPEED_LOSS: 0.22,    // victim sheds this fraction of speed on impact
  HIT_KNOCK: 55,           // + a shove along the blade direction

  /* ------------------------------------------------------------- rounds */
  RESPAWN_TIME: 3.0,
  SPAWN_PROTECT: 1.4,
  BOUNTY_CURRENCY: 120,    // credits per kill
  HIT_CURRENCY: 0.35,      // credits per point of damage dealt
  SURVIVE_CURRENCY: 8,     // credits per 10s alive

  /* ------------------------------------------------------------- camera */
  CAM_DIST: 46,
  CAM_DIST_FAST: 66,
  CAM_HEIGHT: 17,
  CAM_FOV: 72,
  CAM_FOV_FAST: 108,
  CAM_SHAKE: 0.85,
  MOUSE_SENS: 0.0022,
};

/** Normalised 0..1 "how fast am I" used by every speed-scaled system. */
export function speedT(speed) {
  const t = speed / CFG.MAX_SPEED;
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

/** Authoritative damage. The one formula the whole game is built on. */
export function damageForSpeed(speed) {
  const s = speed < 0 ? 0 : speed > CFG.MAX_SPEED ? CFG.MAX_SPEED : speed;
  return s * CFG.DAMAGE_MULTIPLIER;
}

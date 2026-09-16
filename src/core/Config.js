/**
 * VELOCITY RONIN — central balance & tuning table.
 *
 * Everything that defines how the game FEELS lives here. This file is shared
 * verbatim by the authoritative simulation (server / loopback authority) and by
 * the client's prediction layer, so both sides always agree.
 *
 * World scale: 10 world units = 1 metre. A player is 18u tall (1.8 m).
 * Speed is therefore quoted directly in world units / second, which is the
 * number the HUD shows. MAX_SPEED 500 ~= 50 m/s ~= 180 km/h.
 */

/**
 * WORLD RUSH.
 *
 * The speed NUMBER is fixed by the design: 0-500, and damage is speed x 0.5.
 * How much world you cross per point of that number is a free parameter, and
 * this is it. At 3.0 a reading of 500 moves you 1500 units every second —
 * 150 m/s, 540 km/h, the whole 5.2 km district in three and a half seconds.
 *
 * It is applied to position integration, which is mathematically identical to
 * scaling every velocity and acceleration in the game at once: jump arcs,
 * grapple pulls, wall kicks and slides all grow together, so nothing has to be
 * retuned relative to anything else and the numbers on screen never change.
 */
export const WORLD_RUSH = 2.4;

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
  // About 2 s from a walk to 500, covering ~1.4 km of ground doing it. Quick
  // enough that top speed is reachable on real stretches of the district now
  // that every stretch goes past 2.4x faster; slow enough to still be earned.
  ACCEL_BASE: 900,         // u/s^2 at a standstill
  ACCEL_FALLOFF: 1.25,     // higher = harder to reach top speed
  ACCEL_MIN: 62,           // the last stretch to 500 is still a grind
  FRICTION_BASE: 250,      // decel with no input
  FRICTION_DRAG: 0.55,     // + this * speed
  BRAKE_DECEL: 900,        // holding against your own velocity
  OVERSPEED_DECEL: 420,    // shedding speed above the current cap

  // Steering authority. This is the heart of the risk/reward curve: the faster
  // you go, the less you can change your mind.
  // At 0: ~690 deg/s, instant. At 250: ~250 deg/s. At 500: 66 deg/s, which is
  // a 400-unit turning circle — you commit to a line long before you arrive.
  // Turning circle = speed / turn rate, and speed now buys 2.4x the distance,
  // so the same rad/s is a far bigger arc. Raised to keep 500 committal rather
  // than impossible: at top speed you carve an ~800 unit circle.
  TURN_RATE_LOW: 12.0,     // rad/s of velocity re-aim at 0 speed
  TURN_RATE_HIGH: 1.55,    // rad/s at MAX_SPEED — a wide, committed arc
  TURN_CURVE: 0.70,
  // Airborne you keep your line but can still shape it — enough to correct a
  // jump or set up a landing, never enough to reverse in mid-air.
  AIR_TURN_MULT: 0.52,
  AIR_STRAFE: 320,         // u/s^2 of pure lateral nudge while airborne
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
  HIT_SPHERE_R: 11.5,

  /* ------------------------------------------------------------- katana */
  // Reach and arc both TIGHTEN with speed. Big damage demands real precision.
  // Reach is scaled for WORLD_RUSH: you now cross 25 units per tick at top
  // speed, so a 36-unit blade would be geometrically impossible to land.
  REACH_LOW: 66,
  REACH_HIGH: 48,
  ARC_LOW: 1.30,           // half-angle rad at low speed (~75 deg)
  ARC_HIGH: 0.42,          // half-angle rad at 500 (~24 deg)
  ARC_CURVE: 0.80,
  VERTICAL_REACH: 34,

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

  /* ------------------------------------------------------------- parkour */
  // Wall movement exists to keep momentum alive. Every number here is chosen so
  // that the fastest line through a space is a parkour line, not a straight one
  // — and so that nothing ever RESETS your speed, it only redirects it.
  WALL_PROBE: 16,            // how far out the shoulder rays look
  WALLRUN_MIN_SPEED: 145,    // below this a wall is just a wall
  WALLRUN_EXIT_SPEED: 95,
  WALLRUN_MAX_TIME: 2.3,
  WALLRUN_GRAV_START: 0.14,  // gravity scale at attach...
  WALLRUN_GRAV_END: 0.95,    // ...and by the time your run is spent
  WALLRUN_GRAV_RAMP: 1.5,    // seconds to travel between the two
  WALLRUN_ENTRY_UP: 82,      // small pop on attach so it reads as a launch
  WALLRUN_STICK: 210,        // inward hold, in u/s^2
  WALLRUN_ACCEL: 520,        // you can still gain speed along a wall
  WALLRUN_ALIGN: 0.30,       // max rad between velocity and wall to attach
  WALLRUN_REATTACH_TIME: 0.45,

  WALLKICK_UP: 232,
  WALLKICK_OUT: 205,
  WALLKICK_KEEP: 1.04,       // along-wall momentum is kept and nudged up
  WALLKICK_BUFFER: 0.14,

  WALLCLIMB_MAX_TIME: 0.55,  // straight up a wall you hit head-on
  // Height is scaled by WORLD_RUSH like everything else, so this buys roughly
  // one jump's worth of climb. It used to buy nine, which let you ladder a
  // tower into the sky.
  WALLCLIMB_ACCEL: 420,
  WALLCLIMB_MIN_SPEED: 120,
  WALLCLIMB_COST: 0.55,      // horizontal speed converted into height

  VAULT_MAX_RISE: 46,        // ledges up to this high are flowed over, not hit
  VAULT_MIN_SPEED: 70,
  VAULT_CLEAR: 22,
  VAULT_COOLDOWN: 0.3,

  SLIDE_MIN_SPEED: 150,
  SLIDE_ENTRY_BOOST: 1.07,
  SLIDE_FRICTION: 0.11,      // multiplier on normal ground friction
  SLIDE_TURN: 0.42,
  SLIDE_SLOPE_GAIN: 2.1,     // downhill slides really pick up
  SLIDE_MIN_TIME: 0.18,
  SLIDE_HOP_UP: 1.0,         // jumping out of a slide keeps everything

  /* ------------------------------------------------------ grappling hook */
  // The hook is a real object that travels, catches, and reels. It never
  // teleports you: every unit of the pull is integrated through the same
  // movement step as running, so momentum carries straight out of a release.
  GRAPPLE_KEY_RANGE: 1700,   // max anchor distance
  GRAPPLE_MIN_RANGE: 90,     // too close to be worth it
  GRAPPLE_HOOK_SPEED: 5200,  // the hook always outruns you, even at 500
  GRAPPLE_PULL: 1500,        // reel acceleration toward the anchor (u/s^2)
  GRAPPLE_PULL_MIN: 520,     // floor so long grapples still feel strong
  GRAPPLE_REEL: 240,         // rope shortening rate (u/s)
  GRAPPLE_SWING_CTRL: 900,   // lateral steering authority while swinging
  GRAPPLE_RELEASE_BOOST: 1.06,
  GRAPPLE_DETACH_DIST: 85,   // auto-release on arrival, wide enough that 25
                             // units of travel per tick cannot skip past it
  GRAPPLE_ARRIVE_POP: 95,    // upward kick on arrival: clears the lip, never a splat
  GRAPPLE_ANCHOR_LIFT: 9,    // bias anchors up so you catch ledges, not faces
  GRAPPLE_MAX_TIME: 4.0,     // safety: never stay latched forever
  GRAPPLE_COOLDOWN: 0.28,
  GRAPPLE_AIM_ASSIST: 0.075, // rad of search cone when the centre ray misses
  GRAPPLE_ANCHOR_MIN_Y: -40, // relative to feet; stops grappling your own floor

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
  CAM_FOV_FAST: 102,
  // NO ambient speed shake. Sprinting must never wobble the frame — speed is
  // sold with FOV, boom length, streaks and wind, all of which stay readable.
  // The camera only shakes for discrete events, and only briefly.
  CAM_SHAKE: 0.0,
  MOUSE_SENS: 0.0022,
  // A routine jump lands at ~215 u/s and must produce NO camera response at
  // all. Only a genuine drop registers, and only proportionally.
  LAND_DIP_MIN: 300,
  LAND_DIP_FULL: 900,

  /* ------------------------------------------------- high-speed hit impact */
  // Landing a strike above 350 speed punches the ATTACKER's camera for exactly
  // 0.3 s: hard hit, then a smooth settle. Never the victim, never stacking.
  IMPACT_SHAKE_MIN_SPEED: 350,   // strictly greater than — 350 itself does not
  IMPACT_SHAKE_TIME: 0.30,       // exact duration
  IMPACT_SHAKE_TIERS: [
    { max: 400, amp: 1.00 },     // 351-400  strong
    { max: 475, amp: 1.45 },     // 401-475  very strong
    { max: 500, amp: 1.90 },     // 476-500  extremely powerful
  ],
  // Degrees of swing at amp 1.0. For scale: taking a hit swings ~1.3 deg, so a
  // 351 strike lands at ~1.5 and a 500 strike at ~4 — unmistakably heavier
  // than routine feedback, still nowhere near nauseating.
  IMPACT_SHAKE_BASE: 7.0,
  IMPACT_HITSTOP: 0.055,         // render-only pause; the sim never stops
  IMPACT_FOV_KICK: 5.0,
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

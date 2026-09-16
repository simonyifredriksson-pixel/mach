/**
 * VELOCITY RONIN — third-person camera.
 *
 * The camera is how the game tells you how fast you are. It does that with
 * FOV, boom length and lead — smooth, continuous, readable things — and NEVER
 * with ambient shake or blur. There is no idle wobble at any speed.
 *
 * It responds to discrete events instead:
 *   accelerating   -> the boom eases out, FOV opens
 *   braking        -> the boom eases in
 *   jump / fall    -> a little vertical give
 *   landing        -> a short spring dip, scaled by impact
 *   sharp turns    -> a subtle bank, in the direction you are carving
 *   grappling      -> pulls in and tilts toward the rope
 *   high-speed hit -> the 0.3 s impact punch, spec'd exactly (see impact())
 *
 * Every response is critically damped or explicitly enveloped, so the frame
 * always returns exactly to neutral. Nothing accumulates.
 */

import * as THREE from '../../lib/three.module.js';
import { CFG, speedT } from '../core/Config.js';
import { clamp, clamp01, lerp, damp, smoothstep } from '../core/Util.js';
import { querySolids, solidTop, SHAPE, terrainHeight } from '../shared/WorldData.js';

const _ids = [];
const DEG = Math.PI / 180;

export class CameraRig {
  constructor(camera, world, profile) {
    this.camera = camera;
    this.world = world;
    this.profile = profile;

    this.fov = CFG.CAM_FOV;
    this.dist = CFG.CAM_DIST;
    this.height = CFG.CAM_HEIGHT;
    this.roll = 0;
    this.leadX = 0;
    this.leadZ = 0;
    this.heightOffset = 0;

    this.target = new THREE.Vector3();
    this.smooth = new THREE.Vector3();
    this.hasSmooth = false;
    this.impulse = new THREE.Vector3();

    // Event responses.
    this.landDip = 0;        // spring displacement
    this.landVel = 0;
    this.fovKick = 0;
    this.distKick = 0;
    this.softShake = 0;      // small, for taking hits / heavy landings

    // The 0.3 s high-speed impact punch.
    this.impactT = 0;
    this.impactAmp = 0;
    this.impactAxis = 0;
    this.impactOffset = new THREE.Vector3();
    this.hitStop = 0;

    this.prevSpeed = 0;
    this.accelSmooth = 0;
    this.time = 0;
  }

  /* ----------------------------------------------------------- responses */

  /** Small, generic knock — taking a hit, a heavy landing. Never speed-driven. */
  addShake(amount) { this.softShake = Math.min(1.1, this.softShake + amount); }
  addKick(amount) { this.fovKick = Math.min(8, this.fovKick + amount * 6); }

  /** Landing spring. `power` is the downward speed that was arrested. */
  land(power) {
    const t = clamp01(power / 420);
    this.landVel -= 2.6 + t * 9.5;
    if (t > 0.45) this.addShake(t * 0.32);
  }

  grappleFire() { this.distKick += 4; }
  grappleHook() { this.fovKick += 3.2; this.distKick += 7; }
  grappleRelease() { this.fovKick += 4.5; }

  /**
   * HIGH-SPEED HIT IMPACT.
   *
   * Fires only for the player who LANDED the strike, and only when their speed
   * at the moment of contact was strictly greater than 350 — 350 itself does
   * nothing, 351 does. Runs for exactly IMPACT_SHAKE_TIME (0.30 s) and then the
   * camera is mathematically back at neutral: the envelope ends at zero, so
   * there is no residue and nothing to drift.
   *
   * The motion is a controlled two-tone ring along ONE fixed axis chosen at
   * impact — a directional punch that settles, not random per-frame jitter.
   *
   * Repeat hits replace the punch rather than stacking it.
   *
   * @param {number} attackerSpeed speed at the instant of contact
   * @returns {boolean} whether the heavy shake triggered
   */
  impact(attackerSpeed) {
    if (!(attackerSpeed > CFG.IMPACT_SHAKE_MIN_SPEED)) return false;

    const tiers = CFG.IMPACT_SHAKE_TIERS;
    let tier = tiers[tiers.length - 1];
    for (const t of tiers) { if (attackerSpeed <= t.max) { tier = t; break; } }

    // Slight continuous scaling inside the tier so 399 reads heavier than 352.
    const within = clamp01((attackerSpeed - CFG.IMPACT_SHAKE_MIN_SPEED) / (CFG.MAX_SPEED - CFG.IMPACT_SHAKE_MIN_SPEED));
    const amp = tier.amp * (0.94 + within * 0.12);

    // No stacking: take the stronger of the two, restart the clock.
    this.impactAmp = Math.min(2.1, Math.max(this.impactAmp * (this.impactT / CFG.IMPACT_SHAKE_TIME), amp));
    this.impactT = CFG.IMPACT_SHAKE_TIME;
    this.impactAxis = Math.random() * Math.PI * 2;
    this.hitStop = CFG.IMPACT_HITSTOP;
    this.fovKick = Math.min(9, this.fovKick + CFG.IMPACT_FOV_KICK * tier.amp);
    return true;
  }

  /** Render-only impact pause. The simulation never stops. */
  consumeHitStop(dt) {
    if (this.hitStop <= 0) return dt;
    this.hitStop -= dt;
    return dt * 0.18;
  }

  /* --------------------------------------------------------------- frame */

  update(dt, focus, yaw, pitch, speed, opts = {}) {
    this.time += dt;
    const t = speedT(speed);
    const settings = this.profile?.settings ?? {};
    const shakeScale = settings.shake ?? 1;
    const grappling = !!opts.grappling;

    /* ---- acceleration sensing: the boom breathes with your throttle ---- */
    const accel = (speed - this.prevSpeed) / Math.max(dt, 1e-4);
    this.prevSpeed = speed;
    this.accelSmooth = damp(this.accelSmooth, clamp(accel / 600, -1.2, 1.2), 6, dt);

    /* ------------------------------------------------------------- boom */
    this.distKick = damp(this.distKick, 0, 4.5, dt);
    const accelPush = clamp(this.accelSmooth, -0.5, 1) * 5.5;
    const wantDist = lerp(CFG.CAM_DIST, CFG.CAM_DIST_FAST, smoothstep(t * 1.08))
      + accelPush + this.distKick - (grappling ? 5 : 0);
    // Deliberately unhurried: the boom is the calmest thing on screen.
    this.dist = damp(this.dist, wantDist * (opts.distMul ?? 1), 4.2, dt);

    this.fovKick = damp(this.fovKick, 0, 6.5, dt);
    const wantFov = lerp(CFG.CAM_FOV, CFG.CAM_FOV_FAST, Math.pow(t, 1.35))
      + (settings.fov ?? 0) + this.fovKick + (grappling ? 4 : 0);
    this.fov = damp(this.fov, wantFov, 6, dt);

    /* ---- lead: look down your line, not at the back of your own head ---- */
    const leadAmt = t * t * 24;
    const inv = 1 / Math.max(1, speed);
    this.leadX = damp(this.leadX, (opts.velX || 0) * inv * leadAmt, 3.5, dt);
    this.leadZ = damp(this.leadZ, (opts.velZ || 0) * inv * leadAmt, 3.5, dt);

    /* ---- landing spring ---- */
    this.landVel += -this.landDip * 150 * dt;     // stiffness
    this.landVel *= Math.exp(-11 * dt);           // damping
    this.landDip += this.landVel * dt;
    if (Math.abs(this.landDip) < 0.002 && Math.abs(this.landVel) < 0.01) { this.landDip = 0; this.landVel = 0; }

    // Vertical give on the way up and down, so jumps feel weighted.
    const airLag = clamp((opts.velY || 0) * -0.012, -3.5, 3.5);
    this.heightOffset = damp(this.heightOffset, airLag, 7, dt);

    const pivotX = focus.x + this.leadX;
    const pivotY = focus.y + this.height + t * 3.0 + this.landDip + this.heightOffset;
    const pivotZ = focus.z + this.leadZ;

    /* ---- shake: events only. There is no ambient term at all. ---- */
    let shakeYaw = 0, shakePitch = 0;

    // Generic soft knock (taking damage, hard landing).
    this.softShake = Math.max(0, this.softShake - dt * 3.6);
    if (this.softShake > 0.0005) {
      const s = this.softShake * this.softShake * 0.55 * shakeScale;
      const n = this.time * 30;
      shakeYaw += Math.sin(n * 1.7) * s * DEG * 3;
      shakePitch += Math.sin(n * 2.3 + 1.1) * s * DEG * 2.4;
    }

    // The 0.3 s high-speed impact punch.
    if (this.impactT > 0) {
      this.impactT = Math.max(0, this.impactT - dt);
      const u = 1 - this.impactT / CFG.IMPACT_SHAKE_TIME;     // 0 -> 1
      // IMPACT -> HEAVY -> SMOOTH SETTLE. Ends at exactly zero.
      const attack = smoothstep(clamp01(u / 0.09));
      const decay = Math.pow(1 - u, 1.85);
      const env = attack * decay;
      // Two-tone ring on one fixed axis: a punch, not a jitter.
      const ring = Math.sin(u * Math.PI * 2 * 4.6) * 0.78 + Math.sin(u * Math.PI * 2 * 8.3) * 0.22;
      const swing = env * ring * this.impactAmp * CFG.IMPACT_SHAKE_BASE * shakeScale;
      shakeYaw += Math.cos(this.impactAxis) * swing * DEG;
      shakePitch += Math.sin(this.impactAxis) * swing * DEG;
      // The positional shove is DERIVED from the same envelope rather than
      // integrated, so when the envelope reaches zero the offset is exactly
      // zero too. Nothing accumulates, nothing lingers, nothing to drift.
      // Purely angular, deliberately. A positional shove sounds good on paper
      // but the look-at partially cancels it, which flattens the tiers and
      // smears the frame for no gain. The swing alone reads as the punch.
      if (this.impactT === 0) this.impactAmp = 0;
    }

    /* ---- bank into carves + roll toward the rope while swinging ---- */
    const bankTarget = clamp((opts.turnRate || 0) * -0.30, -0.10, 0.10) * (0.35 + t)
      + (grappling ? clamp((opts.ropeSide || 0) * 0.06, -0.06, 0.06) : 0);
    this.roll = damp(this.roll, bankTarget, 4.5, dt);

    const ry = yaw + shakeYaw;
    const rp = clamp(pitch + shakePitch, -1.05, 0.9);

    /* --------------------------------------------------------- position */
    const cosP = Math.cos(rp);
    const dx = Math.sin(ry) * cosP;
    const dz = Math.cos(ry) * cosP;
    const dy = Math.sin(rp);

    const dist = this._collide(pivotX, pivotY, pivotZ, dx, dy, dz, this.dist);

    const camX = pivotX + dx * dist;
    const camY = pivotY - dy * dist + 2;
    const camZ = pivotZ + dz * dist;

    if (!this.hasSmooth) { this.smooth.set(camX, camY, camZ); this.hasSmooth = true; }
    // Stiff enough that aiming is 1:1, soft enough that nothing ever snaps.
    const k = 1 - Math.exp(-30 * dt);
    this.smooth.x += (camX - this.smooth.x) * k;
    this.smooth.y += (camY - this.smooth.y) * k;
    this.smooth.z += (camZ - this.smooth.z) * k;

    this.camera.position.copy(this.smooth).add(this.impulse);
    this.impulse.multiplyScalar(Math.exp(-11 * dt));
    if (this.impulse.lengthSq() < 1e-8) this.impulse.set(0, 0, 0);

    this.target.set(
      pivotX - dx * 14,
      pivotY - dy * 14 + 3,
      pivotZ - dz * 14,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    if (Math.abs(this.roll) > 1e-4) this.camera.rotateZ(this.roll);

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    return { fov: this.fov, dist };
  }

  /** Pull the boom in when something solid is in the way. */
  _collide(px, py, pz, dx, dy, dz, want) {
    const steps = 8;
    const pad = 6;
    for (let i = 1; i <= steps; i++) {
      const d = (i / steps) * want;
      const x = px + dx * d, y = py - dy * d + 2, z = pz + dz * d;
      if (terrainHeight(this.world, x, z) > y - pad) return Math.max(14, (i - 1) / steps * want);
      const ids = querySolids(this.world, x - pad, z - pad, x + pad, z + pad, _ids);
      for (let n = 0; n < ids.length; n++) {
        const o = this.world.solids[ids[n]];
        if (o.k === 'bounds') continue;
        if (y < o.y0 - pad || y > o.y1 + pad) continue;
        if (o.t === SHAPE.CYL) {
          const ddx = x - o.cx, ddz = z - o.cz;
          if (ddx * ddx + ddz * ddz < (o.r + pad) * (o.r + pad)) return Math.max(14, (i - 1) / steps * want);
        } else if (o.t === SHAPE.BOX) {
          if (x > o.x0 - pad && x < o.x1 + pad && z > o.z0 - pad && z < o.z1 + pad) {
            return Math.max(14, (i - 1) / steps * want);
          }
        } else {
          const top = solidTop(o, clamp(x, o.x0, o.x1), clamp(z, o.z0, o.z1));
          if (top !== null && y < top + pad && x > o.x0 && x < o.x1 && z > o.z0 && z < o.z1) {
            return Math.max(14, (i - 1) / steps * want);
          }
        }
      }
    }
    return want;
  }
}

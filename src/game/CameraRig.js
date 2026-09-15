/**
 * [MACH] — third-person camera.
 *
 * The camera is a speedometer you look through. FOV opens, the boom lengthens
 * and drifts toward your velocity vector, and a controlled shake comes in above
 * 300. It must never fight the player: no auto-rotate, no lag on the aim axis,
 * and the shake is capped so the blade arc stays readable at 500.
 */

import * as THREE from '../../lib/three.module.js';
import { CFG, speedT } from '../core/Config.js';
import { clamp, clamp01, lerp, damp, smoothstep } from '../core/Util.js';
import { querySolids, solidTop, SHAPE, terrainHeight } from '../shared/WorldData.js';

const _ids = [];

export class CameraRig {
  constructor(camera, world, profile) {
    this.camera = camera;
    this.world = world;
    this.profile = profile;
    this.fov = CFG.CAM_FOV;
    this.dist = CFG.CAM_DIST;
    this.shake = 0;
    this.kick = 0;
    this.roll = 0;
    this.leadX = 0;
    this.leadZ = 0;
    this.target = new THREE.Vector3();
    this.smooth = new THREE.Vector3();
    this.hasSmooth = false;
    this.time = 0;
    this.impulse = new THREE.Vector3();
  }

  /** Punch the camera — used on hits taken and heavy landings. */
  addShake(amount) { this.shake = Math.min(2.2, this.shake + amount); }
  addKick(amount) { this.kick = Math.min(1.5, this.kick + amount); }

  update(dt, focus, yaw, pitch, speed, opts = {}) {
    this.time += dt;
    const t = speedT(speed);
    const settings = this.profile?.settings ?? {};
    const shakeScale = settings.shake ?? 1;

    /* ------------------------------------------------------------- boom */
    const wantDist = lerp(CFG.CAM_DIST, CFG.CAM_DIST_FAST, smoothstep(t * 1.15)) * (opts.distMul ?? 1);
    this.dist = damp(this.dist, wantDist, 5, dt);

    const wantFov = lerp(CFG.CAM_FOV, CFG.CAM_FOV_FAST, Math.pow(t, 1.25)) + (settings.fov ?? 0) + this.kick * 9;
    this.fov = damp(this.fov, wantFov, 7, dt);

    // Drift the pivot toward where you are actually going, so at high speed you
    // see your line instead of the back of your own head.
    const leadAmt = t * t * 26;
    this.leadX = damp(this.leadX, (opts.velX || 0) / Math.max(1, speed) * leadAmt, 4, dt);
    this.leadZ = damp(this.leadZ, (opts.velZ || 0) / Math.max(1, speed) * leadAmt, 4, dt);

    const pivotX = focus.x + this.leadX;
    const pivotY = focus.y + CFG.CAM_HEIGHT + t * 3.5;
    const pivotZ = focus.z + this.leadZ;

    /* ------------------------------------------------------------ shake */
    const baseShake = Math.pow(clamp01((t - 0.42) / 0.58), 1.6) * CFG.CAM_SHAKE;
    this.shake = Math.max(this.shake * Math.exp(-6 * dt), 0);
    this.kick *= Math.exp(-7 * dt);
    const amp = (baseShake + this.shake) * shakeScale;
    const n = this.time * 24;
    const sx = (Math.sin(n * 1.7) + Math.sin(n * 3.3) * 0.5) * amp * 0.5;
    const sy = (Math.sin(n * 2.1 + 1.7) + Math.sin(n * 4.1) * 0.4) * amp * 0.45;
    this.roll = damp(this.roll, (opts.turnRate || 0) * -0.35 + Math.sin(n * 1.3) * amp * 0.012, 6, dt);

    const ry = yaw + sx * 0.012;
    const rp = clamp(pitch + sy * 0.010, -1.05, 0.9);

    /* --------------------------------------------------------- position */
    const cosP = Math.cos(rp);
    const dx = Math.sin(ry) * cosP;
    const dz = Math.cos(ry) * cosP;
    const dy = Math.sin(rp);

    let dist = this.dist;
    dist = this._collide(pivotX, pivotY, pivotZ, dx, dy, dz, dist);

    const camX = pivotX + dx * dist;
    const camY = pivotY - dy * dist + 2;
    const camZ = pivotZ + dz * dist;

    if (!this.hasSmooth) { this.smooth.set(camX, camY, camZ); this.hasSmooth = true; }
    // Position smoothing is deliberately stiff: input must feel 1:1.
    const k = 1 - Math.exp(-34 * dt);
    this.smooth.x += (camX - this.smooth.x) * k;
    this.smooth.y += (camY - this.smooth.y) * k;
    this.smooth.z += (camZ - this.smooth.z) * k;

    this.camera.position.copy(this.smooth).add(this.impulse);
    this.impulse.multiplyScalar(Math.exp(-9 * dt));

    this.target.set(
      pivotX - dx * 14 + sx * 0.6,
      pivotY - dy * 14 + 3 + sy * 0.6,
      pivotZ - dz * 14,
    );
    this.camera.up.set(0, 1, 0);
    this.camera.lookAt(this.target);
    this.camera.rotateZ(this.roll);

    if (Math.abs(this.camera.fov - this.fov) > 0.01) {
      this.camera.fov = this.fov;
      this.camera.updateProjectionMatrix();
    }
    return { fov: this.fov, dist, shake: amp };
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

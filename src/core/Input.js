/**
 * Raw input -> one clean command per fixed step.
 *
 * Edge-triggered actions (attack, jump, sheathe) are latched the instant the
 * key goes down and consumed by the next simulation step, so a click is never
 * eaten by a frame boundary. At 500 speed a dropped input is a death.
 */

import { CFG } from './Config.js';
import { clamp, Emitter } from './Util.js';

export class Input extends Emitter {
  constructor(canvas) {
    super();
    this.canvas = canvas;
    this.keys = new Set();
    this.yaw = 0;
    this.pitch = 0;
    this.locked = false;
    this.sensitivity = CFG.MOUSE_SENS;
    this.invertY = false;
    this.enabled = true;

    this._attackLatch = false;
    this._jumpLatch = false;
    this._sheatheLatch = false;
    this._grappleLatch = false;
    this._attackHeld = false;

    this._bind();
  }

  _bind() {
    const onKey = (e, down) => {
      if (!this.enabled) return;
      const code = e.code;
      if (down) {
        if (this.keys.has(code)) return;   // ignore auto-repeat
        this.keys.add(code);
        if (code === 'Space') { this._jumpLatch = true; e.preventDefault(); }
        if (code === 'KeyR') this._sheatheLatch = true;
        if (code === 'KeyG') this._grappleLatch = true;      // fire / release hook
        this.emit('keydown', code);
      } else {
        this.keys.delete(code);
        this.emit('keyup', code);
      }
      if (['KeyW', 'KeyA', 'KeyS', 'KeyD', 'Space', 'Tab', 'ControlLeft'].includes(code)) e.preventDefault();
    };
    window.addEventListener('keydown', (e) => onKey(e, true));
    window.addEventListener('keyup', (e) => onKey(e, false));
    window.addEventListener('blur', () => { this.keys.clear(); this._attackHeld = false; });

    document.addEventListener('pointerlockchange', () => {
      this.locked = document.pointerLockElement === this.canvas;
      this.emit('lockchange', this.locked);
    });

    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.locked || !this.enabled) return;
      if (e.button === 0) { this._attackLatch = true; this._attackHeld = true; }
      if (e.button === 2) this._sheatheLatch = true;
    });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this._attackHeld = false; });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());

    document.addEventListener('mousemove', (e) => {
      if (!this.locked || !this.enabled) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity * (this.invertY ? -1 : 1);
      this.pitch = clamp(this.pitch, -0.95, 0.85);
      if (this.yaw > Math.PI) this.yaw -= Math.PI * 2;
      if (this.yaw < -Math.PI) this.yaw += Math.PI * 2;
    });
  }

  requestLock() {
    // Chrome rejects this if the user just released the lock, or if the gesture
    // is stale. It is never fatal — swallow it rather than leaking a rejection.
    try {
      const p = this.canvas.requestPointerLock?.();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch (e) { /* not supported here */ }
  }
  releaseLock() { document.exitPointerLock?.(); }

  /** Build the command for one fixed step and clear the latches. */
  sample(cmd) {
    const k = this.keys;
    let mx = 0, mz = 0;
    if (this.enabled) {
      if (k.has('KeyW') || k.has('ArrowUp')) mz += 1;
      if (k.has('KeyS') || k.has('ArrowDown')) mz -= 1;
      if (k.has('KeyD') || k.has('ArrowRight')) mx += 1;
      if (k.has('KeyA') || k.has('ArrowLeft')) mx -= 1;
    }
    cmd.mx = mx; cmd.mz = mz;
    cmd.yaw = this.yaw;
    cmd.pitch = this.pitch;
    cmd.sprint = this.enabled && (k.has('ShiftLeft') || k.has('ShiftRight'));
    // Slide is held, not toggled — it is a momentum tool, not a stance.
    cmd.crouch = this.enabled && (k.has('ControlLeft') || k.has('ControlRight') || k.has('KeyC'));
    cmd.jump = this._jumpLatch;
    cmd.attack = this._attackLatch;
    cmd.sheathe = this._sheatheLatch;
    cmd.grapple = this._grappleLatch;
    this._jumpLatch = false;
    this._attackLatch = false;
    this._sheatheLatch = false;
    this._grappleLatch = false;
    return cmd;
  }

  get attackHeld() { return this._attackHeld; }
}

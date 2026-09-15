/** Small dependency-free math/util helpers shared by sim and client. */

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, v) => clamp01((v - a) / (b - a));
export const smoothstep = (t) => { t = clamp01(t); return t * t * (3 - 2 * t); };

/** Frame-rate independent exponential approach. */
export const damp = (a, b, rate, dt) => lerp(a, b, 1 - Math.exp(-rate * dt));

export const TAU = Math.PI * 2;

/** Shortest signed angular difference b - a, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
  let d = (b - a) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
}

export function angleLerp(a, b, t) {
  return a + angleDelta(a, b) * t;
}

/** Deterministic PRNG — the map must be identical on every machine. */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function randRange(rng, a, b) { return a + (b - a) * rng(); }
export function randPick(rng, arr) { return arr[Math.floor(rng() * arr.length) % arr.length]; }

export function hypot2(x, z) { return Math.sqrt(x * x + z * z); }

export function formatTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  if (m > 0) return `${m}m ${String(sec).padStart(2, '0')}s`;
  return `${sec}s`;
}

export function formatNum(n) {
  return Math.round(n).toLocaleString('en-US');
}

/** Tiny event emitter. */
export class Emitter {
  constructor() { this._h = new Map(); }
  on(evt, fn) {
    if (!this._h.has(evt)) this._h.set(evt, new Set());
    this._h.get(evt).add(fn);
    return () => this.off(evt, fn);
  }
  off(evt, fn) { this._h.get(evt)?.delete(fn); }
  emit(evt, payload) {
    const s = this._h.get(evt);
    if (s) for (const fn of s) fn(payload);
  }
}

/** Fixed-size ring buffer of {t, ...} samples, newest last. */
export class History {
  constructor(seconds) { this.seconds = seconds; this.items = []; }
  push(t, value) {
    this.items.push({ t, value });
    const cutoff = t - this.seconds;
    while (this.items.length > 2 && this.items[0].t < cutoff) this.items.shift();
  }
  /** Linearly interpolated sample at time t (clamped to the stored range). */
  sample(t, lerpFn) {
    const it = this.items;
    if (it.length === 0) return null;
    if (t <= it[0].t) return it[0].value;
    if (t >= it[it.length - 1].t) return it[it.length - 1].value;
    for (let i = it.length - 1; i > 0; i--) {
      if (it[i - 1].t <= t) {
        const a = it[i - 1], b = it[i];
        const f = (t - a.t) / Math.max(1e-6, b.t - a.t);
        return lerpFn(a.value, b.value, f);
      }
    }
    return it[0].value;
  }
}

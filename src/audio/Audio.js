/**
 * [MACH] — audio.
 *
 * Every sound is synthesised at runtime: no audio files ship with the game.
 * The important one is WIND — a filtered noise bed whose cutoff, gain and a
 * second resonant band all track speed, so you can hear 380 without looking at
 * the HUD. Katana swings pitch up with velocity for the same reason.
 */

import { clamp, clamp01, lerp } from '../core/Util.js';
import { speedT } from '../core/Config.js';

export class AudioSystem {
  constructor(settings) {
    this.settings = settings || { master: 0.8, sfx: 0.9, music: 0.5 };
    this.ctx = null;
    this.ready = false;
    this.listenerPos = { x: 0, y: 0, z: 0 };
    this.listenerRight = { x: 1, y: 0, z: 0 };
    this.listenerFwd = { x: 0, y: 0, z: -1 };
    this.musicOn = true;
    this._duck = 1;
    this._duckTarget = 1;
  }

  /** Must be called from a user gesture. */
  init() {
    if (this.ctx) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ctx = new AC();
    const c = this.ctx;

    this.master = c.createGain();
    this.master.gain.value = this.settings.master ?? 0.8;
    this.master.connect(c.destination);

    // A gentle limiter so a six-way fight never clips.
    this.comp = c.createDynamicsCompressor();
    this.comp.threshold.value = -12;
    this.comp.knee.value = 24;
    this.comp.ratio.value = 6;
    this.comp.attack.value = 0.004;
    this.comp.release.value = 0.2;
    this.comp.connect(this.master);

    this.sfxBus = c.createGain();
    this.sfxBus.gain.value = this.settings.sfx ?? 0.9;
    this.sfxBus.connect(this.comp);

    this.uiBus = c.createGain();
    this.uiBus.gain.value = 0.9;
    this.uiBus.connect(this.comp);

    this.musicBus = c.createGain();
    this.musicBus.gain.value = this.settings.music ?? 0.5;
    this.musicBus.connect(this.comp);

    this.noise = this._noiseBuffer(2.0);
    this._buildWind();
    this._buildMusic();
    this.ready = true;
  }

  resume() { if (this.ctx?.state === 'suspended') this.ctx.resume(); }

  applySettings(s) {
    this.settings = s;
    if (!this.ready) return;
    this.master.gain.value = s.master ?? 0.8;
    this.sfxBus.gain.value = s.sfx ?? 0.9;
    this.musicBus.gain.value = (s.music ?? 0.5) * this._duck;
  }

  _noiseBuffer(seconds) {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * seconds);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    return buf;
  }

  /* --------------------------------------------------------------- wind */

  _buildWind() {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;

    const lp = c.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 400; lp.Q.value = 0.6;

    const band = c.createBiquadFilter();
    band.type = 'bandpass'; band.frequency.value = 900; band.Q.value = 2.2;

    const gMain = c.createGain(); gMain.gain.value = 0;
    const gBand = c.createGain(); gBand.gain.value = 0;

    src.connect(lp); lp.connect(gMain); gMain.connect(this.sfxBus);
    src.connect(band); band.connect(gBand); gBand.connect(this.sfxBus);
    src.start();

    this.wind = { lp, band, gMain, gBand };
  }

  updateWind(speed, grounded) {
    if (!this.ready) return;
    const t = speedT(speed);
    const w = this.wind;
    const now = this.ctx.currentTime;
    const gain = Math.pow(clamp01((t - 0.10) / 0.9), 1.35) * 0.55;
    w.gMain.gain.setTargetAtTime(gain, now, 0.10);
    w.lp.frequency.setTargetAtTime(lerp(260, 2600, t), now, 0.12);
    w.gBand.gain.setTargetAtTime(Math.pow(clamp01((t - 0.45) / 0.55), 2) * 0.22, now, 0.15);
    w.band.frequency.setTargetAtTime(lerp(700, 2900, t), now, 0.15);
  }

  /* ------------------------------------------------------------- music */

  _buildMusic() {
    const c = this.ctx;
    this.musicNodes = [];
    // Slow, dark two-chord bed. Deliberately sparse: this is a reaction game.
    const base = 55;                       // A1
    const voices = [1, 1.5, 2, 3, 4.5];
    const pad = c.createGain(); pad.gain.value = 0.0; pad.connect(this.musicBus);
    for (const v of voices) {
      const o = c.createOscillator();
      o.type = 'sawtooth';
      o.frequency.value = base * v;
      o.detune.value = (Math.random() - 0.5) * 12;
      const f = c.createBiquadFilter();
      f.type = 'lowpass'; f.frequency.value = 340; f.Q.value = 3;
      const g = c.createGain(); g.gain.value = 0.10 / voices.length;
      o.connect(f); f.connect(g); g.connect(pad);
      o.start();
      this.musicNodes.push({ o, f, g });
    }
    this.musicPad = pad;
    this.musicPad.gain.setTargetAtTime(0.35, c.currentTime, 4);

    // Sub pulse on a slow clock.
    this._pulseTimer = setInterval(() => {
      if (!this.ready || !this.musicOn) return;
      const t = this.ctx.currentTime;
      const o = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      o.type = 'sine'; o.frequency.setValueAtTime(74, t);
      o.frequency.exponentialRampToValueAtTime(41, t + 0.5);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.35, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.9);
      o.connect(g); g.connect(this.musicBus);
      o.start(t); o.stop(t + 1.0);
    }, 2400);
  }

  setMusic(on) {
    this.musicOn = on;
    if (this.ready) this.musicBus.gain.setTargetAtTime(on ? (this.settings.music ?? 0.5) * this._duck : 0, this.ctx.currentTime, 0.4);
  }

  /** Duck the bed — used by the ??? reveal. */
  duck(amount, time = 0.6) {
    this._duck = amount;
    if (this.ready) this.musicBus.gain.setTargetAtTime((this.settings.music ?? 0.5) * amount * (this.musicOn ? 1 : 0), this.ctx.currentTime, time);
  }

  /* ------------------------------------------------------------ helpers */

  setListener(pos, quaternion) {
    this.listenerPos = pos;
    // Right and forward from the camera quaternion (no AudioListener needed).
    const q = quaternion;
    const rx = 1 - 2 * (q.y * q.y + q.z * q.z);
    const ry = 2 * (q.x * q.y + q.w * q.z);
    const rz = 2 * (q.x * q.z - q.w * q.y);
    this.listenerRight = { x: rx, y: ry, z: rz };
  }

  _spatial(pos, refDist = 260) {
    if (!pos) return { gain: 1, pan: 0 };
    const dx = pos.x - this.listenerPos.x, dy = pos.y - this.listenerPos.y, dz = pos.z - this.listenerPos.z;
    const d = Math.hypot(dx, dy, dz);
    const gain = clamp01(1 / (1 + (d / refDist) * (d / refDist) * 2.2));
    const inv = d > 1e-3 ? 1 / d : 0;
    const pan = clamp((dx * this.listenerRight.x + dy * this.listenerRight.y + dz * this.listenerRight.z) * inv, -1, 1);
    return { gain, pan, dist: d };
  }

  _out(gain, pan, bus) {
    const c = this.ctx;
    const g = c.createGain();
    g.gain.value = gain;
    if (pan !== 0 && c.createStereoPanner) {
      const p = c.createStereoPanner();
      p.pan.value = pan;
      g.connect(p); p.connect(bus || this.sfxBus);
    } else {
      g.connect(bus || this.sfxBus);
    }
    return g;
  }

  _noiseBurst({ dur = 0.2, type = 'bandpass', freq = 1200, q = 1, gain = 0.5, sweep = 0, pan = 0, bus = null, curve = 2 }) {
    const c = this.ctx, t = c.currentTime;
    const src = c.createBufferSource();
    src.buffer = this.noise;
    src.loop = true;
    src.playbackRate.value = 0.8 + Math.random() * 0.4;
    const f = c.createBiquadFilter();
    f.type = type; f.frequency.setValueAtTime(freq, t); f.Q.value = q;
    if (sweep) f.frequency.exponentialRampToValueAtTime(Math.max(60, freq * sweep), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + dur * 0.06);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(f); f.connect(g);
    g.connect(this._out(1, pan, bus));
    src.start(t); src.stop(t + dur + 0.02);
  }

  _tone({ freq = 440, dur = 0.2, type = 'sine', gain = 0.3, slideTo = 0, pan = 0, bus = null, delay = 0 }) {
    const c = this.ctx, t = c.currentTime + delay;
    const o = c.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(Math.max(20, slideTo), t + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, gain), t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g); g.connect(this._out(1, pan, bus));
    o.start(t); o.stop(t + dur + 0.02);
  }

  /* ------------------------------------------------------------ gameplay */

  footstep(speed, surface, pos) {
    if (!this.ready) return;
    const { gain, pan } = this._spatial(pos, 200);
    if (gain < 0.02) return;
    const t = speedT(speed);
    const hard = surface === 'terrain' ? 0.75 : 1.1;
    this._noiseBurst({
      dur: 0.07, type: 'bandpass', freq: (900 + t * 1500) * hard, q: 1.4,
      gain: (0.10 + t * 0.20) * gain, sweep: 0.4, pan,
    });
  }

  swing(speed, pos, iai) {
    if (!this.ready) return;
    const { gain, pan } = this._spatial(pos, 420);
    if (gain < 0.01) return;
    const t = speedT(speed);
    this._noiseBurst({
      dur: 0.16 + t * 0.05, type: 'bandpass',
      freq: 1500 + t * 3400, q: 3.4 + t * 5,
      gain: (0.30 + t * 0.30) * gain, sweep: 0.22, pan,
    });
    this._tone({ freq: 2200 + t * 2600, slideTo: 500 + t * 900, dur: 0.16, type: 'triangle', gain: 0.07 * gain, pan });
    if (iai) this._tone({ freq: 3400, slideTo: 1200, dur: 0.22, type: 'sine', gain: 0.10 * gain, pan });
  }

  draw(pos) {
    if (!this.ready) return;
    const { gain, pan } = this._spatial(pos, 300);
    this._tone({ freq: 900, slideTo: 3200, dur: 0.30, type: 'sawtooth', gain: 0.055 * gain, pan });
    this._noiseBurst({ dur: 0.28, type: 'highpass', freq: 2400, gain: 0.10 * gain, sweep: 1.6, pan });
  }

  sheathe(pos) {
    if (!this.ready) return;
    const { gain, pan } = this._spatial(pos, 300);
    this._noiseBurst({ dur: 0.22, type: 'bandpass', freq: 2600, q: 2, gain: 0.10 * gain, sweep: 0.25, pan });
    this._tone({ freq: 240, slideTo: 120, dur: 0.12, type: 'sine', gain: 0.10 * gain, pan, delay: 0.19 });
  }

  impact(dmg, speed, pos, local) {
    if (!this.ready) return;
    const { gain, pan } = this._spatial(pos, 520);
    const t = clamp01(dmg / 250);
    // Transient: steel on plate.
    this._noiseBurst({ dur: 0.05, type: 'highpass', freq: 3000, gain: (0.35 + t * 0.4) * gain, pan });
    // Body: a low thud that gets heavier with damage.
    this._tone({ freq: 160 - t * 60, slideTo: 48, dur: 0.24 + t * 0.2, type: 'sine', gain: (0.30 + t * 0.35) * gain, pan });
    // Ring: the blade itself.
    this._tone({ freq: 1800 + t * 900, slideTo: 900, dur: 0.30, type: 'triangle', gain: 0.10 * gain, pan });
    if (local) this.hitmarker(t);
  }

  hitmarker(t) {
    if (!this.ready) return;
    this._tone({ freq: 1500 + t * 900, dur: 0.05, type: 'square', gain: 0.10, bus: this.uiBus });
    this._tone({ freq: 2400 + t * 1400, dur: 0.07, type: 'square', gain: 0.07, bus: this.uiBus, delay: 0.035 });
  }

  killConfirm() {
    if (!this.ready) return;
    const base = 440;
    [0, 4, 7, 12].forEach((s, i) => this._tone({
      freq: base * Math.pow(2, s / 12), dur: 0.30, type: 'triangle', gain: 0.12, bus: this.uiBus, delay: i * 0.055,
    }));
  }

  death() {
    if (!this.ready) return;
    this._tone({ freq: 320, slideTo: 60, dur: 1.0, type: 'sawtooth', gain: 0.16, bus: this.uiBus });
    this._noiseBurst({ dur: 0.7, type: 'lowpass', freq: 800, gain: 0.25, sweep: 0.12, bus: this.uiBus });
  }

  jump(pos) { if (this.ready) this._noiseBurst({ dur: 0.1, type: 'bandpass', freq: 500, gain: 0.12 * this._spatial(pos).gain, sweep: 2.0, pan: this._spatial(pos).pan }); }

  land(power, pos) {
    if (!this.ready) return;
    const { gain, pan } = this._spatial(pos, 300);
    const t = clamp01(power / 300);
    this._noiseBurst({ dur: 0.16, type: 'lowpass', freq: 400 + t * 700, gain: (0.12 + t * 0.3) * gain, sweep: 0.3, pan });
    this._tone({ freq: 110, slideTo: 50, dur: 0.18, type: 'sine', gain: (0.1 + t * 0.25) * gain, pan });
  }

  whiff(pos) {
    if (!this.ready) return;
    const { gain, pan } = this._spatial(pos, 300);
    this._tone({ freq: 220, slideTo: 130, dur: 0.22, type: 'sawtooth', gain: 0.07 * gain, pan });
  }

  /* ------------------------------------------------------------------ UI */

  ui(kind) {
    if (!this.ready) return;
    const B = this.uiBus;
    switch (kind) {
      case 'hover': this._tone({ freq: 900, dur: 0.05, type: 'square', gain: 0.035, bus: B }); break;
      case 'click': this._tone({ freq: 1400, dur: 0.06, type: 'square', gain: 0.08, bus: B });
        this._tone({ freq: 700, dur: 0.09, type: 'square', gain: 0.05, bus: B, delay: 0.03 }); break;
      case 'back': this._tone({ freq: 700, slideTo: 380, dur: 0.12, type: 'square', gain: 0.07, bus: B }); break;
      case 'error': this._tone({ freq: 200, dur: 0.18, type: 'sawtooth', gain: 0.12, bus: B }); break;
      case 'equip': [0, 7, 12].forEach((s, i) => this._tone({ freq: 523 * Math.pow(2, s / 12), dur: 0.16, type: 'triangle', gain: 0.09, bus: B, delay: i * 0.04 })); break;
      case 'buy': this._tone({ freq: 300, slideTo: 900, dur: 0.22, type: 'triangle', gain: 0.12, bus: B }); break;
    }
  }

  crateTick(pitch = 1) {
    if (!this.ready) return;
    this._noiseBurst({ dur: 0.035, type: 'bandpass', freq: 2600 * pitch, q: 6, gain: 0.16, bus: this.uiBus });
  }

  crateOpen() {
    if (!this.ready) return;
    this._noiseBurst({ dur: 0.5, type: 'lowpass', freq: 900, gain: 0.25, sweep: 0.3, bus: this.uiBus });
    this._tone({ freq: 120, slideTo: 420, dur: 0.6, type: 'sawtooth', gain: 0.12, bus: this.uiBus });
  }

  /** Rarity reveal stings. Each tier gets its own harmonic identity. */
  reveal(rarity) {
    if (!this.ready) return;
    const B = this.uiBus;
    const chord = (root, steps, dur, gain, type, spacing = 0.05) =>
      steps.forEach((s, i) => this._tone({ freq: root * Math.pow(2, s / 12), dur, type, gain, bus: B, delay: i * spacing }));

    switch (rarity) {
      case 'COMMON': chord(392, [0, 7], 0.22, 0.09, 'triangle'); break;
      case 'UNCOMMON': chord(440, [0, 4, 7], 0.3, 0.10, 'triangle'); break;
      case 'RARE': chord(494, [0, 4, 7, 11], 0.42, 0.11, 'triangle', 0.06); break;
      case 'EPIC':
        chord(523, [0, 5, 9, 12], 0.6, 0.12, 'sawtooth', 0.07);
        this._noiseBurst({ dur: 0.5, type: 'highpass', freq: 2000, gain: 0.14, sweep: 2, bus: B });
        break;
      case 'LEGENDARY':
        chord(587, [0, 4, 7, 12, 16], 0.9, 0.13, 'sawtooth', 0.075);
        this._tone({ freq: 70, slideTo: 40, dur: 1.4, type: 'sine', gain: 0.35, bus: B });
        this._noiseBurst({ dur: 0.9, type: 'highpass', freq: 1600, gain: 0.2, sweep: 2.4, bus: B });
        break;
      case 'MYTHIC':
        chord(659, [0, 7, 12, 19, 24], 1.5, 0.12, 'sawtooth', 0.09);
        this._tone({ freq: 55, slideTo: 33, dur: 2.2, type: 'sine', gain: 0.4, bus: B });
        this._noiseBurst({ dur: 1.6, type: 'bandpass', freq: 3200, q: 2, gain: 0.18, sweep: 0.4, bus: B });
        break;
      case 'SECRET':
        // No chord. A single sine that should not be there, and a heartbeat.
        this._tone({ freq: 41, dur: 4.5, type: 'sine', gain: 0.45, bus: B });
        this._tone({ freq: 1567.98, dur: 3.0, type: 'sine', gain: 0.05, bus: B, delay: 1.2 });
        for (let i = 0; i < 4; i++) this._tone({ freq: 62, slideTo: 44, dur: 0.35, type: 'sine', gain: 0.3, bus: B, delay: 0.6 + i * 0.75 });
        break;
    }
  }

  /** The tick before the ??? reveal — one clock, very close to your ear. */
  secretTick(i) {
    if (!this.ready) return;
    this._noiseBurst({ dur: 0.04, type: 'bandpass', freq: 3800, q: 10, gain: 0.22, bus: this.uiBus });
    this._tone({ freq: i % 2 ? 1046 : 880, dur: 0.06, type: 'sine', gain: 0.08, bus: this.uiBus });
  }
}

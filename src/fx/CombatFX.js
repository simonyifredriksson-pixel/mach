/**
 * [MACH] — combat feedback.
 *
 * Feedback is the contract: if the authority says you connected at 412 speed,
 * the screen must tell you that in under 80 ms and it must feel like 206 damage.
 *
 *   BladeTrail  — the real swept arc of the blade, sampled from the weapon
 *   CombatFX    — impact sparks, cosmetic slash flourish, kill/spawn effects
 *   DamageNumbers — projected, weight-scaled, colour-coded by how hard it hit
 */

import * as THREE from '../../lib/three.module.js';
import { CFG } from '../core/Config.js';
import { clamp, clamp01, lerp } from '../core/Util.js';
import { ParticleSystem } from './Particles.js';
import { glowTexture, sparkTexture } from '../world/Materials.js';

/* ---------------------------------------------------------- blade trail */

const TRAIL_LEN = 18;

export class BladeTrail {
  constructor(scene, color = 0xffffff) {
    this.n = TRAIL_LEN;
    this.samples = [];
    this.pos = new Float32Array(this.n * 2 * 3);
    this.alp = new Float32Array(this.n * 2);
    const idx = [];
    for (let i = 0; i < this.n - 1; i++) {
      const a = i * 2;
      idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alp, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      vertexShader: `attribute float aAlpha; varying float vA;
        void main(){ vA = aAlpha; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`,
      fragmentShader: `varying float vA; uniform vec3 uColor;
        void main(){ if (vA <= 0.003) discard; gl_FragColor = vec4(uColor, vA); }`,
      uniforms: { uColor: { value: new THREE.Color(color) } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
      blending: THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 13;
    this.mesh.visible = false;
    scene.add(this.mesh);
    this.fade = 0;
  }

  setColor(c) { this.material.uniforms.uColor.value.set(c); }

  /** Feed the current blade line; call every frame while swinging. */
  push(tip, base) {
    this.samples.unshift({
      tx: tip.x, ty: tip.y, tz: tip.z,
      bx: base.x, by: base.y, bz: base.z,
    });
    while (this.samples.length > this.n) this.samples.pop();
    this.fade = 1;
  }

  update(dt, active) {
    if (!active) {
      this.fade -= dt * 4.5;
      if (this.fade <= 0) { this.mesh.visible = false; this.samples.length = 0; return; }
      if (this.samples.length) this.samples.pop();
    }
    if (this.samples.length < 2) { this.mesh.visible = false; return; }
    this.mesh.visible = true;
    for (let i = 0; i < this.n; i++) {
      const s = this.samples[Math.min(i, this.samples.length - 1)];
      const i6 = i * 6, i2 = i * 2;
      this.pos[i6] = s.tx; this.pos[i6 + 1] = s.ty; this.pos[i6 + 2] = s.tz;
      this.pos[i6 + 3] = s.bx; this.pos[i6 + 4] = s.by; this.pos[i6 + 5] = s.bz;
      const f = i / (this.n - 1);
      const a = Math.pow(1 - f, 1.6) * this.fade;
      this.alp[i2] = a * 0.95;
      this.alp[i2 + 1] = a * 0.25;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }

  dispose() { this.mesh.parent?.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); }
}

/* ----------------------------------------------------------- flourishes */

function arcGeometry(shape) {
  const g = new THREE.BufferGeometry();
  const pos = [], uv = [];
  const steps = 26;
  const span = shape === 'gate' ? Math.PI * 1.25 : Math.PI * 0.95;
  const inner = shape === 'gate' ? 0.55 : 0.62;
  for (let i = 0; i < steps; i++) {
    const a0 = -span / 2 + (i / steps) * span;
    const a1 = -span / 2 + ((i + 1) / steps) * span;
    const bulge = (t) => {
      const c = Math.cos(t / span * Math.PI);
      if (shape === 'crescent') return 1 + 0.22 * c;
      if (shape === 'flare') return 1 + 0.32 * Math.abs(c);
      return 1;
    };
    const r0o = bulge(a0), r1o = bulge(a1);
    const p = (a, r) => [Math.cos(a) * r, Math.sin(a) * r, 0];
    const A = p(a0, inner * r0o), B = p(a0, 1 * r0o), C = p(a1, inner * r1o), D = p(a1, 1 * r1o);
    pos.push(...A, ...B, ...C, ...B, ...D, ...C);
    const u0 = i / steps, u1 = (i + 1) / steps;
    uv.push(u0, 0, u0, 1, u1, 0, u0, 1, u1, 1, u1, 0);
  }
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  return g;
}

const ARC_FRAG = `
varying vec2 vUv;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uShape;
void main(){
  float edge = smoothstep(0.0, 0.25, vUv.y) * (1.0 - smoothstep(0.75, 1.0, vUv.y));
  float ends = smoothstep(0.0, 0.14, vUv.x) * (1.0 - smoothstep(0.86, 1.0, vUv.x));
  float a = edge * ends;
  if (uShape > 1.5) {          // split / shatter: break the band up
    a *= step(0.35, fract(vUv.x * 7.0)) ;
  }
  gl_FragColor = vec4(uColor, a * uOpacity);
}`;
const ARC_VERT = `varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }`;

/* ------------------------------------------------------------- manager */

export class CombatFX {
  constructor(scene, camera, container) {
    this.scene = scene;
    this.camera = camera;
    this.container = container;
    this.sparks = new ParticleSystem(scene, sparkTexture(), { capacity: 800, additive: true, scale: 1100 });
    this.smoke = new ParticleSystem(scene, glowTexture(), { capacity: 900, additive: false, scale: 900 });
    this.glow = new ParticleSystem(scene, glowTexture(), { capacity: 500, additive: true, scale: 1000 });

    this.arcs = [];
    this.arcGeoms = {};
    for (const s of ['arc', 'crescent', 'split', 'shatter', 'flare', 'gate']) this.arcGeoms[s] = arcGeometry(s);

    this.numbers = new DamageNumbers(container, camera);
    this._v = new THREE.Vector3();
    this._q = new THREE.Quaternion();
  }

  /* --------------------------------------------------------------- arcs */

  spawnArc(pos, yaw, slashDef, scale, roll = 0) {
    const spec = slashDef?.spec ?? { color: 0xffffff, shape: 'arc', width: 1 };
    let a = this.arcs.find((x) => !x.alive);
    if (!a) {
      const mat = new THREE.ShaderMaterial({
        vertexShader: ARC_VERT, fragmentShader: ARC_FRAG,
        uniforms: { uColor: { value: new THREE.Color(0xffffff) }, uOpacity: { value: 1 }, uShape: { value: 0 } },
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      });
      const mesh = new THREE.Mesh(this.arcGeoms.arc, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 15;
      this.scene.add(mesh);
      a = { mesh, mat, alive: false, life: 0, maxLife: 0.3, scale: 1 };
      this.arcs.push(a);
    }
    a.mesh.geometry = this.arcGeoms[spec.shape] || this.arcGeoms.arc;
    a.mat.uniforms.uColor.value.set(spec.color);
    a.mat.uniforms.uShape.value = spec.shape === 'split' || spec.shape === 'shatter' ? 2 : 0;
    a.mesh.position.copy(pos);
    a.mesh.rotation.set(0, 0, 0);
    a.mesh.rotateY(yaw);
    a.mesh.rotateX(-Math.PI / 2);
    a.mesh.rotateZ(roll);
    a.scale = scale * (spec.width || 1);
    a.mesh.scale.setScalar(a.scale * 0.6);
    a.mesh.visible = true;
    a.alive = true;
    a.life = a.maxLife = spec.shape === 'gate' ? 0.42 : 0.26;
    return a;
  }

  /* ------------------------------------------------------------ impacts */

  impact(pos, dmg, speedT, slashDef, dirYaw) {
    const c = new THREE.Color().setHSL(lerp(0.13, 0.0, clamp01(speedT)), 0.95, 0.62);
    const n = 14 + Math.floor(speedT * 26);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI - Math.PI / 2;
      const s = 60 + Math.random() * (160 + speedT * 420);
      this.sparks.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: Math.cos(a) * Math.cos(e) * s, vy: Math.sin(e) * s + 40, vz: Math.sin(a) * Math.cos(e) * s,
        color: c, size: 12 + Math.random() * 22, life: 0.18 + Math.random() * 0.35,
        gravity: -220, drag: 2.6, alpha: 1,
      });
    }
    this.glow.emit({
      x: pos.x, y: pos.y, z: pos.z, color: new THREE.Color(0xffffff),
      size: 90 + speedT * 190, life: 0.16, gravity: 0, drag: 6, grow: 260, alpha: 0.95,
    });
    this.spawnArc(pos, dirYaw, slashDef, 9 + speedT * 16, Math.random() * 0.6 - 0.3);
  }

  /**
   * The >350 speed connect. Deliberately a different event from a normal hit:
   * a wider ring, a brighter core and a harder spark cone — but still clean,
   * still short, and it never obscures the centre of the screen.
   */
  heavyImpact(pos, speed, slashDef, dirYaw) {
    const t = clamp01((speed - 350) / 150);
    const hot = new THREE.Color().setHSL(lerp(0.09, 0.02, t), 1.0, 0.68);
    const white = new THREE.Color(0xffffff);

    // Directional spark cone along the blade line, not a spherical puff.
    const fx = -Math.sin(dirYaw), fz = -Math.cos(dirYaw);
    const n = 30 + Math.floor(t * 26);
    for (let i = 0; i < n; i++) {
      const spread = 0.9;
      const a = (Math.random() - 0.5) * spread;
      const e = (Math.random() - 0.5) * spread;
      const s = 220 + Math.random() * (420 + t * 460);
      const cx = fx * Math.cos(a) - fz * Math.sin(a);
      const cz = fx * Math.sin(a) + fz * Math.cos(a);
      this.sparks.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: cx * s, vy: e * s * 0.55 + 60, vz: cz * s,
        color: Math.random() < 0.35 ? white : hot,
        size: 14 + Math.random() * 20, life: 0.16 + Math.random() * 0.3,
        gravity: 280, drag: 3.0, alpha: 1,
      });
    }
    // Two-stage flash: a hard core and an expanding shock ring.
    this.glow.emit({ x: pos.x, y: pos.y, z: pos.z, color: white, size: 120 + t * 130, life: 0.11, drag: 8, grow: 340, alpha: 1 });
    this.glow.emit({ x: pos.x, y: pos.y, z: pos.z, color: hot, size: 40, life: 0.30, drag: 2.5, grow: 900 + t * 700, alpha: 0.75 });

    this.spawnArc(pos, dirYaw, slashDef, 16 + t * 18, Math.random() * 0.5 - 0.25);
  }

  /** Blocked by spawn protection — deliberately flat and unsatisfying. */
  blocked(pos) {
    const c = new THREE.Color(0x9fd8ff);
    for (let i = 0; i < 10; i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparks.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: Math.cos(a) * 60, vy: Math.random() * 60, vz: Math.sin(a) * 60,
        color: c, size: 10, life: 0.2, gravity: 0, drag: 4, alpha: 0.7,
      });
    }
  }

  /* -------------------------------------------------------- kill/spawn */

  killEffect(pos, killDef, color = 0xffffff) {
    const style = killDef?.spec?.style || 'shards';
    const c = new THREE.Color(killDef?.spec?.color ?? color);
    const P = this.sparks, S = this.smoke, G = this.glow;
    switch (style) {
      case 'petals':
        for (let i = 0; i < 40; i++) {
          const a = Math.random() * Math.PI * 2;
          S.emit({ x: pos.x, y: pos.y + 10, z: pos.z, vx: Math.cos(a) * 45, vy: 60 + Math.random() * 50, vz: Math.sin(a) * 45,
            color: c, size: 14 + Math.random() * 12, life: 1.6 + Math.random(), gravity: 34, drag: 0.9, alpha: 0.95 });
        }
        break;
      case 'ash':
        for (let i = 0; i < 46; i++) {
          S.emit({ x: pos.x + (Math.random() - 0.5) * 16, y: pos.y + 6 + Math.random() * 14, z: pos.z + (Math.random() - 0.5) * 16,
            vx: (Math.random() - 0.5) * 30, vy: 12 + Math.random() * 26, vz: (Math.random() - 0.5) * 30,
            color: c, size: 20 + Math.random() * 30, life: 1.5 + Math.random() * 1.2, gravity: 8, drag: 1.1, alpha: 0.6, grow: 22 });
        }
        break;
      case 'bolt':
        for (let i = 0; i < 60; i++) {
          const a = Math.random() * Math.PI * 2;
          P.emit({ x: pos.x, y: pos.y + 8, z: pos.z, vx: Math.cos(a) * 200, vy: (Math.random() - 0.3) * 320, vz: Math.sin(a) * 200,
            color: c, size: 8 + Math.random() * 16, life: 0.25 + Math.random() * 0.3, gravity: 0, drag: 3.5, alpha: 1 });
        }
        G.emit({ x: pos.x, y: pos.y + 10, z: pos.z, color: c, size: 320, life: 0.22, drag: 8, grow: 400, alpha: 1 });
        break;
      case 'implode':
        for (let i = 0; i < 56; i++) {
          const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI;
          const r = 60 + Math.random() * 70;
          const x = pos.x + Math.cos(a) * Math.sin(e) * r, y = pos.y + 10 + Math.cos(e) * r, z = pos.z + Math.sin(a) * Math.sin(e) * r;
          P.emit({ x, y, z, vx: (pos.x - x) * 4.5, vy: (pos.y + 10 - y) * 4.5, vz: (pos.z - z) * 4.5,
            color: c, size: 14, life: 0.34, gravity: 0, drag: 0.4, alpha: 1 });
        }
        G.emit({ x: pos.x, y: pos.y + 10, z: pos.z, color: new THREE.Color(0xffffff), size: 260, life: 0.5, drag: 1, grow: -420, alpha: 1 });
        break;
      case 'kanji':
        G.emit({ x: pos.x, y: pos.y + 20, z: pos.z, color: c, size: 420, life: 0.9, drag: 9, grow: -120, alpha: 0.9 });
        for (let i = 0; i < 30; i++) {
          P.emit({ x: pos.x, y: pos.y + 16, z: pos.z, vx: (Math.random() - 0.5) * 140, vy: (Math.random() - 0.2) * 140, vz: (Math.random() - 0.5) * 140,
            color: c, size: 16, life: 0.6, gravity: 60, drag: 2, alpha: 1 });
        }
        break;
      default:
        for (let i = 0; i < 34; i++) {
          const a = Math.random() * Math.PI * 2, e = Math.random() * Math.PI - Math.PI / 2;
          const s = 90 + Math.random() * 220;
          P.emit({ x: pos.x, y: pos.y + 9, z: pos.z, vx: Math.cos(a) * Math.cos(e) * s, vy: Math.sin(e) * s + 70, vz: Math.sin(a) * Math.cos(e) * s,
            color: c, size: 14 + Math.random() * 18, life: 0.5 + Math.random() * 0.4, gravity: 280, drag: 1.4, alpha: 1 });
        }
    }
  }

  spawnEffect(pos, spawnDef) {
    const style = spawnDef?.spec?.style || 'drop';
    const c = new THREE.Color(spawnDef?.spec?.color ?? 0xffffff);
    if (style === 'boom') {
      this.glow.emit({ x: pos.x, y: pos.y + 9, z: pos.z, color: c, size: 60, life: 0.5, drag: 0.5, grow: 900, alpha: 0.9 });
    }
    if (style === 'flash') {
      for (let i = 0; i < 30; i++) {
        const a = (i / 30) * Math.PI * 2;
        this.sparks.emit({ x: pos.x, y: pos.y + 9, z: pos.z, vx: Math.cos(a) * 190, vy: 20, vz: Math.sin(a) * 190,
          color: c, size: 14, life: 0.3, drag: 3, alpha: 1 });
      }
    }
    if (style === 'fold') {
      for (let i = 0; i < 26; i++) {
        this.smoke.emit({ x: pos.x + (Math.random() - 0.5) * 24, y: pos.y + 30 + Math.random() * 20, z: pos.z + (Math.random() - 0.5) * 24,
          vx: (Math.random() - 0.5) * 30, vy: -40, vz: (Math.random() - 0.5) * 30, color: c, size: 18, life: 0.9, gravity: 30, drag: 1.2, alpha: 0.9 });
      }
    }
    for (let i = 0; i < 18; i++) {
      const a = Math.random() * Math.PI * 2;
      this.smoke.emit({ x: pos.x, y: pos.y + 2, z: pos.z, vx: Math.cos(a) * 90, vy: 30 + Math.random() * 40, vz: Math.sin(a) * 90,
        color: c, size: 26, life: 0.55, gravity: -30, drag: 2.4, grow: 60, alpha: 0.55 });
    }
  }

  /* -------------------------------------------------------------- frame */

  update(dt) {
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.glow.update(dt);
    for (const a of this.arcs) {
      if (!a.alive) continue;
      a.life -= dt;
      if (a.life <= 0) { a.alive = false; a.mesh.visible = false; continue; }
      const f = 1 - a.life / a.maxLife;
      a.mesh.scale.setScalar(a.scale * (0.6 + f * 0.75));
      a.mat.uniforms.uOpacity.value = Math.pow(1 - f, 1.5);
    }
    this.numbers.update(dt);
  }
}

/* ------------------------------------------------------- damage numbers */

export class DamageNumbers {
  constructor(container, camera) {
    this.camera = camera;
    this.root = document.createElement('div');
    this.root.className = 'dmg-layer';
    container.appendChild(this.root);
    this.pool = [];
    this.active = [];
    this._v = new THREE.Vector3();
  }

  _get() {
    let el = this.pool.pop();
    if (!el) {
      el = document.createElement('div');
      el.className = 'dmg-num';
      this.root.appendChild(el);
    }
    el.style.display = 'block';
    return el;
  }

  /**
   * @param {THREE.Vector3|object} pos world position
   * @param {number} dmg
   * @param {object} opts {crit, taken, speed}
   */
  spawn(pos, dmg, opts = {}) {
    const el = this._get();
    const t = clamp01(dmg / (CFG.MAX_SPEED * CFG.DAMAGE_MULTIPLIER));
    el.textContent = Math.round(dmg);
    el.className = 'dmg-num' + (opts.taken ? ' taken' : '') + (t > 0.78 ? ' huge' : t > 0.45 ? ' big' : '');
    el.style.setProperty('--t', t.toFixed(3));
    this.active.push({
      el, x: pos.x, y: pos.y, z: pos.z,
      life: 1.15, max: 1.15,
      vx: (Math.random() - 0.5) * 16, vy: 34 + t * 34, vz: (Math.random() - 0.5) * 16,
      scale: 0.8 + t * 0.9,
    });
    if (this.active.length > 24) this._retire(this.active.shift());
  }

  /** Floating label, e.g. "+120" credits or a callout. */
  spawnLabel(pos, text, cls) {
    const el = this._get();
    el.textContent = text;
    el.className = 'dmg-num label ' + (cls || '');
    this.active.push({ el, x: pos.x, y: pos.y, z: pos.z, life: 1.4, max: 1.4, vx: 0, vy: 26, vz: 0, scale: 0.9 });
  }

  _retire(a) { a.el.style.display = 'none'; this.pool.push(a.el); }

  update(dt) {
    const cam = this.camera;
    const w = window.innerWidth, h = window.innerHeight;
    for (let i = this.active.length - 1; i >= 0; i--) {
      const a = this.active[i];
      a.life -= dt;
      if (a.life <= 0) { this._retire(a); this.active.splice(i, 1); continue; }
      a.x += a.vx * dt; a.y += a.vy * dt; a.z += a.vz * dt;
      a.vy -= 26 * dt;
      this._v.set(a.x, a.y, a.z).project(cam);
      if (this._v.z > 1) { a.el.style.opacity = '0'; continue; }
      const f = a.life / a.max;
      const sx = (this._v.x * 0.5 + 0.5) * w;
      const sy = (-this._v.y * 0.5 + 0.5) * h;
      const pop = a.life > a.max - 0.08 ? 1.35 : 1;
      a.el.style.transform = `translate(-50%,-50%) translate(${sx.toFixed(1)}px, ${sy.toFixed(1)}px) scale(${(a.scale * pop).toFixed(3)})`;
      a.el.style.opacity = String(clamp01(f * 2.2));
    }
  }
}

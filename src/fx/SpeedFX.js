/**
 * [MACH] — velocity language in world space.
 *
 *   WindField  : air streaks tearing past the camera, aligned to your velocity
 *   SpeedTrail : the cosmetic ribbon behind each runner
 *   GroundWake : dust and grit kicked off the surface you are actually on
 *
 * All three are driven from one number: speed. Below 150 they are invisible.
 */

import * as THREE from '../../lib/three.module.js';
import { speedT } from '../core/Config.js';
import { clamp01, lerp } from '../core/Util.js';

/* --------------------------------------------------------------- wind */

const WIND_VERT = `
attribute float aAlpha;
varying float vAlpha;
void main(){
  vAlpha = aAlpha;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;
const WIND_FRAG = `
varying float vAlpha;
uniform vec3 uColor;
uniform float uOpacity;
void main(){
  gl_FragColor = vec4(uColor, vAlpha * uOpacity);
}`;

export class WindField {
  constructor(scene, count = 190) {
    this.count = count;
    this.radius = 150;
    this.pos = new Float32Array(count * 6);
    this.alpha = new Float32Array(count * 2);
    this.seed = new Float32Array(count * 3);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = g;
    this.material = new THREE.ShaderMaterial({
      vertexShader: WIND_VERT,
      fragmentShader: WIND_FRAG,
      uniforms: { uColor: { value: new THREE.Color(0xdff0ff) }, uOpacity: { value: 0 } },
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.lines = new THREE.LineSegments(g, this.material);
    this.lines.frustumCulled = false;
    this.lines.renderOrder = 14;
    scene.add(this.lines);

    for (let i = 0; i < count; i++) this._respawn(i, new THREE.Vector3());
  }

  _respawn(i, origin) {
    const a = Math.random() * Math.PI * 2;
    const r = 18 + Math.random() * this.radius;
    const s = i * 3;
    this.seed[s] = origin.x + Math.cos(a) * r;
    this.seed[s + 1] = origin.y + (Math.random() - 0.5) * 120;
    this.seed[s + 2] = origin.z + Math.sin(a) * r;
  }

  update(dt, camPos, vel, speed) {
    const t = speedT(speed);
    const vis = clamp01((t - 0.22) / 0.5);
    this.material.uniforms.uOpacity.value = vis * 0.85;
    if (vis <= 0.001) return;

    const sp = Math.max(1, speed);
    const dx = -vel.x / sp, dy = -(vel.y || 0) / sp * 0.4, dz = -vel.z / sp;
    const len = lerp(14, 90, t);
    const move = speed * dt * 1.35;

    for (let i = 0; i < this.count; i++) {
      const s = i * 3, p = i * 6;
      this.seed[s] += dx * move;
      this.seed[s + 1] += dy * move;
      this.seed[s + 2] += dz * move;
      const ox = this.seed[s] - camPos.x, oy = this.seed[s + 1] - camPos.y, oz = this.seed[s + 2] - camPos.z;
      if (ox * ox + oz * oz > (this.radius + 60) * (this.radius + 60) || Math.abs(oy) > 130) {
        // Respawn in front of the camera, biased along the travel axis.
        const a = Math.random() * Math.PI * 2;
        const r = 20 + Math.random() * this.radius;
        this.seed[s] = camPos.x - dx * 110 + Math.cos(a) * r;
        this.seed[s + 1] = camPos.y + (Math.random() - 0.5) * 110;
        this.seed[s + 2] = camPos.z - dz * 110 + Math.sin(a) * r;
      }
      const jitter = 0.65 + ((i * 37) % 11) / 16;
      const l = len * jitter;
      this.pos[p] = this.seed[s];
      this.pos[p + 1] = this.seed[s + 1];
      this.pos[p + 2] = this.seed[s + 2];
      this.pos[p + 3] = this.seed[s] + dx * l;
      this.pos[p + 4] = this.seed[s + 1] + dy * l;
      this.pos[p + 5] = this.seed[s + 2] + dz * l;
      const near = clamp01(1 - Math.sqrt(ox * ox + oy * oy + oz * oz) / (this.radius + 40));
      this.alpha[i * 2] = 0;
      this.alpha[i * 2 + 1] = near * 0.9;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

/* -------------------------------------------------------------- trail */

const TRAIL_SEGMENTS = 30;

export class SpeedTrail {
  constructor(scene, trailDef) {
    this.def = trailDef;
    this.spec = trailDef.spec;
    this.n = TRAIL_SEGMENTS;
    this.history = [];
    this.time = 0;

    const verts = this.n * 2;
    this.pos = new Float32Array(verts * 3);
    this.col = new Float32Array(verts * 3);
    this.alp = new Float32Array(verts);
    const idx = [];
    for (let i = 0; i < this.n - 1; i++) {
      const a = i * 2, b = a + 1, c = a + 2, d = a + 3;
      idx.push(a, b, c, b, d, c);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alp, 1));
    g.setIndex(idx);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = g;

    this.material = new THREE.ShaderMaterial({
      vertexShader: `
        attribute vec3 aColor; attribute float aAlpha;
        varying vec3 vC; varying float vA;
        void main(){ vC = aColor; vA = aAlpha;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: `
        varying vec3 vC; varying float vA;
        void main(){ if (vA <= 0.002) discard; gl_FragColor = vec4(vC, vA); }`,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: this.spec.style === 'ribbon' ? THREE.NormalBlending : THREE.AdditiveBlending,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 11;
    this.visible = this.spec.style !== 'none';
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.baseColor = new THREE.Color(this.spec.color);
    this._up = new THREE.Vector3(0, 1, 0);
    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._side = new THREE.Vector3();
  }

  update(dt, pos, vel, speed, particles) {
    if (!this.visible) return;
    this.time += dt;
    const t = speedT(speed);
    const strength = clamp01((t - 0.14) / 0.45);
    if (strength <= 0.001) { this.mesh.visible = false; this.history.length = 0; return; }
    this.mesh.visible = true;

    this.history.unshift({ x: pos.x, y: pos.y + 9, z: pos.z, t: this.time });
    while (this.history.length > this.n) this.history.pop();
    if (this.history.length < 3) return;

    const w0 = (this.spec.width || 1) * lerp(1.5, 6.5, t);
    const style = this.spec.style;

    for (let i = 0; i < this.n; i++) {
      const h = this.history[Math.min(i, this.history.length - 1)];
      const hn = this.history[Math.min(i + 1, this.history.length - 1)];
      this._a.set(h.x - hn.x, 0, h.z - hn.z);
      if (this._a.lengthSq() < 1e-6) this._a.set(-vel.x, 0, -vel.z);
      this._side.crossVectors(this._a.normalize(), this._up).normalize();

      const f = i / (this.n - 1);
      let w = w0 * (1 - f * 0.85);
      // Fade the head in, or the ribbon wraps the runner in a white blob and
      // you cannot read their pose — which is how you read their next move.
      let a = (this.spec.opacity ?? 0.7) * (1 - f) * strength * clamp01((f - 0.04) / 0.14);

      if (style === 'dash') a *= (Math.floor(i * 0.5 + this.time * 14) % 2) ? 1 : 0.06;
      if (style === 'comet') { w = w0 * Math.pow(1 - f, 0.55) * 1.6; a *= 1 - f * 0.4; }
      if (style === 'prism') w = w0 * (1 - f * 0.6);
      if (style === 'timestamp') a *= (Math.floor(i * 0.34 + this.time * 6) % 3) ? 0.25 : 1;

      const c = this.baseColor;
      let r = c.r, g = c.g, b = c.b;
      if (style === 'prism') {
        const hue = (f * 0.9 + this.time * 0.2) % 1;
        const tmp = new THREE.Color().setHSL(hue, 0.85, 0.6);
        r = tmp.r; g = tmp.g; b = tmp.b;
      }
      if (style === 'comet') { r = lerp(1, c.r, f); g = lerp(0.95, c.g, f); b = lerp(0.8, c.b, f); }

      const i6 = i * 6, i2 = i * 2;
      this.pos[i6] = h.x + this._side.x * w;
      this.pos[i6 + 1] = h.y + (style === 'comet' ? (1 - f) * 2 : 0);
      this.pos[i6 + 2] = h.z + this._side.z * w;
      this.pos[i6 + 3] = h.x - this._side.x * w;
      this.pos[i6 + 4] = h.y;
      this.pos[i6 + 5] = h.z - this._side.z * w;
      this.col[i6] = r; this.col[i6 + 1] = g; this.col[i6 + 2] = b;
      this.col[i6 + 3] = r; this.col[i6 + 4] = g; this.col[i6 + 5] = b;
      this.alp[i2] = a; this.alp[i2 + 1] = a;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;

    // Particle-flavoured styles.
    if (particles && (style === 'spark' || style === 'timestamp') && Math.random() < strength * 0.9) {
      particles.emit({
        x: pos.x + (Math.random() - 0.5) * 6, y: pos.y + 4 + Math.random() * 10, z: pos.z + (Math.random() - 0.5) * 6,
        vx: -vel.x * 0.12 + (Math.random() - 0.5) * 30,
        vy: 10 + Math.random() * 30,
        vz: -vel.z * 0.12 + (Math.random() - 0.5) * 30,
        color: this.baseColor, size: style === 'timestamp' ? 16 : 10 + Math.random() * 10,
        life: 0.35 + Math.random() * 0.4, gravity: -60, drag: 1.4, alpha: 0.9,
      });
    }
  }

  dispose() { this.mesh.parent?.remove(this.mesh); this.geometry.dispose(); this.material.dispose(); }
}

/* --------------------------------------------------------- ground wake */

const SURFACE_COLOR = {
  terrain: 0x8a8272, road: 0x6f7480, container: 0x9aa2ad, deck: 0x9aa2ad,
  tower: 0x9aa2ad, bridge: 0x9aa2ad, ramp: 0x9aa2ad, default: 0x8a8272,
};

export class GroundWake {
  constructor(particles) {
    this.p = particles;
    this.acc = 0;
    this.color = new THREE.Color();
  }

  update(dt, pos, vel, speed, grounded, kind) {
    if (!grounded || speed < 120) return;
    const t = speedT(speed);
    this.acc += dt * (8 + t * 46);
    const hex = SURFACE_COLOR[kind] || SURFACE_COLOR.default;
    while (this.acc >= 1) {
      this.acc -= 1;
      this.color.setHex(hex).offsetHSL(0, 0, (Math.random() - 0.5) * 0.15);
      this.p.emit({
        x: pos.x + (Math.random() - 0.5) * 10,
        y: pos.y + 1.5,
        z: pos.z + (Math.random() - 0.5) * 10,
        vx: -vel.x * 0.16 + (Math.random() - 0.5) * 45,
        vy: 18 + Math.random() * 42 * t,
        vz: -vel.z * 0.16 + (Math.random() - 0.5) * 45,
        color: this.color,
        size: 16 + Math.random() * 26 + t * 26,
        life: 0.4 + Math.random() * 0.55,
        gravity: -35, drag: 1.5, grow: 30, alpha: 0.5 + t * 0.3,
      });
    }
  }

  burst(pos, power, kind) {
    const hex = SURFACE_COLOR[kind] || SURFACE_COLOR.default;
    const n = Math.min(26, 6 + power * 0.08);
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const s = 40 + Math.random() * power * 0.5;
      this.color.setHex(hex).offsetHSL(0, 0, (Math.random() - 0.5) * 0.18);
      this.p.emit({
        x: pos.x, y: pos.y + 2, z: pos.z,
        vx: Math.cos(a) * s, vy: 25 + Math.random() * 60, vz: Math.sin(a) * s,
        color: this.color, size: 24 + Math.random() * 34,
        life: 0.5 + Math.random() * 0.5, gravity: -60, drag: 1.9, grow: 44, alpha: 0.7,
      });
    }
  }
}

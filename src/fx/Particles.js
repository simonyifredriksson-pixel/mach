/**
 * Pooled GPU particle system. One draw call per blend mode, fixed capacity,
 * zero allocation after construction — at 500 speed there is no budget for
 * garbage collection hitches.
 */

import * as THREE from '../../lib/three.module.js';

const VERT = `
attribute float aSize;
attribute float aAlpha;
attribute vec3 aColor;
varying float vAlpha;
varying vec3 vColor;
uniform float uScale;
void main(){
  vAlpha = aAlpha;
  vColor = aColor;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * uScale / max(1.0, -mv.z);
  gl_Position = projectionMatrix * mv;
}`;

const FRAG = `
varying float vAlpha;
varying vec3 vColor;
uniform sampler2D uMap;
void main(){
  if (vAlpha <= 0.001) discard;
  vec4 t = texture2D(uMap, gl_PointCoord);
  gl_FragColor = vec4(vColor, t.a * vAlpha);
}`;

export class ParticleSystem {
  constructor(scene, texture, { capacity = 900, additive = false, scale = 900 } = {}) {
    this.capacity = capacity;
    this.count = 0;
    this.head = 0;

    this.pos = new Float32Array(capacity * 3);
    this.col = new Float32Array(capacity * 3);
    this.size = new Float32Array(capacity);
    this.alpha = new Float32Array(capacity);
    this.vel = new Float32Array(capacity * 3);
    this.life = new Float32Array(capacity);
    this.maxLife = new Float32Array(capacity);
    this.grav = new Float32Array(capacity);
    this.drag = new Float32Array(capacity);
    this.grow = new Float32Array(capacity);

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    g.setAttribute('aColor', new THREE.BufferAttribute(this.col, 3));
    g.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));
    g.setAttribute('aAlpha', new THREE.BufferAttribute(this.alpha, 1));
    g.setDrawRange(0, capacity);
    g.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 1e6);
    this.geometry = g;

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      uniforms: { uMap: { value: texture }, uScale: { value: scale } },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });

    this.points = new THREE.Points(g, this.material);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 12 : 10;
    scene.add(this.points);
  }

  emit(o) {
    const i = this.head;
    this.head = (this.head + 1) % this.capacity;
    const i3 = i * 3;
    this.pos[i3] = o.x; this.pos[i3 + 1] = o.y; this.pos[i3 + 2] = o.z;
    this.vel[i3] = o.vx || 0; this.vel[i3 + 1] = o.vy || 0; this.vel[i3 + 2] = o.vz || 0;
    const c = o.color;
    this.col[i3] = c.r; this.col[i3 + 1] = c.g; this.col[i3 + 2] = c.b;
    this.size[i] = o.size || 20;
    this.alpha[i] = o.alpha ?? 1;
    this.life[i] = this.maxLife[i] = o.life || 0.6;
    this.grav[i] = o.gravity ?? 0;
    this.drag[i] = o.drag ?? 1.8;
    this.grow[i] = o.grow ?? 0;
    return i;
  }

  update(dt) {
    const { pos, vel, life, maxLife, alpha, size, grav, drag, grow } = this;
    for (let i = 0; i < this.capacity; i++) {
      if (life[i] <= 0) { if (alpha[i] !== 0) alpha[i] = 0; continue; }
      life[i] -= dt;
      if (life[i] <= 0) { alpha[i] = 0; continue; }
      const i3 = i * 3;
      const d = Math.exp(-drag[i] * dt);
      vel[i3] *= d; vel[i3 + 2] *= d;
      vel[i3 + 1] = vel[i3 + 1] * d - grav[i] * dt;
      pos[i3] += vel[i3] * dt;
      pos[i3 + 1] += vel[i3 + 1] * dt;
      pos[i3 + 2] += vel[i3 + 2] * dt;
      const f = life[i] / maxLife[i];
      alpha[i] = f * f;
      size[i] += grow[i] * dt;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aColor.needsUpdate = true;
    this.geometry.attributes.aSize.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;
  }
}

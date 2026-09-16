/**
 * VELOCITY RONIN — grapple cable rendering.
 *
 * The cable is drawn as a camera-facing ribbon through a sagging curve, so it
 * reads as a real line under tension rather than a laser. Sag scales inversely
 * with how hard the rope is pulling: slack when the hook is still flying, taut
 * the moment it bites.
 *
 * One ribbon + one hook head per player, pooled and reused.
 */

import * as THREE from '../../lib/three.module.js';
import { clamp01, lerp } from '../core/Util.js';
import { GSTATE } from '../shared/Grapple.js';

const SEGMENTS = 14;

function hookGeometry() {
  const parts = [];
  const push = (g, m) => { g.applyMatrix4(m); parts.push(g); };
  const body = new THREE.CylinderGeometry(0.55, 0.75, 3.2, 6);
  push(body, new THREE.Matrix4().makeRotationX(Math.PI / 2));
  for (let i = 0; i < 3; i++) {
    const claw = new THREE.BoxGeometry(0.34, 2.0, 0.34);
    const a = (i / 3) * Math.PI * 2;
    const m = new THREE.Matrix4()
      .makeTranslation(Math.cos(a) * 0.75, Math.sin(a) * 0.75, -1.6)
      .multiply(new THREE.Matrix4().makeRotationZ(-a))
      .multiply(new THREE.Matrix4().makeRotationX(0.55));
    push(claw, m);
  }
  const pos = [], nrm = [];
  for (const g of parts) {
    const ng = g.index ? g.toNonIndexed() : g;
    ng.computeVertexNormals();
    const p = ng.attributes.position.array, n = ng.attributes.normal.array;
    for (let i = 0; i < p.length; i++) { pos.push(p[i]); nrm.push(n[i]); }
    ng.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return out;
}

class Cable {
  constructor(scene, color) {
    const verts = SEGMENTS * 2;
    this.pos = new Float32Array(verts * 3);
    this.alp = new Float32Array(verts);
    const idx = [];
    for (let i = 0; i < SEGMENTS - 1; i++) {
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
        void main(){ if (vA <= 0.004) discard; gl_FragColor = vec4(uColor, vA); }`,
      uniforms: { uColor: { value: new THREE.Color(color) } },
      transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
    this.mesh = new THREE.Mesh(g, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 9;
    this.mesh.visible = false;
    scene.add(this.mesh);

    this.hook = new THREE.Mesh(hookGeometry(), new THREE.MeshStandardMaterial({
      color: 0xb9c0cb, metalness: 0.9, roughness: 0.3,
    }));
    this.hook.castShadow = true;
    this.hook.visible = false;
    scene.add(this.hook);

    this._a = new THREE.Vector3();
    this._b = new THREE.Vector3();
    this._dir = new THREE.Vector3();
    this._side = new THREE.Vector3();
    this._toCam = new THREE.Vector3();
  }

  hide() { this.mesh.visible = false; this.hook.visible = false; }

  /**
   * @param {THREE.Vector3} from muzzle
   * @param {THREE.Vector3} to   hook head (flying) or anchor (attached)
   * @param {number} tension 0 = slack (in flight), 1 = taut (attached)
   */
  update(from, to, tension, camera, width) {
    this.mesh.visible = true;
    this.hook.visible = true;

    const sag = lerp(0.14, 0.012, clamp01(tension));
    const dist = from.distanceTo(to);
    const drop = dist * sag;

    camera.getWorldPosition(this._toCam);
    for (let i = 0; i < SEGMENTS; i++) {
      const f = i / (SEGMENTS - 1);
      this._a.lerpVectors(from, to, f);
      this._a.y -= Math.sin(f * Math.PI) * drop;

      // Segment direction for the ribbon frame.
      const f2 = Math.min(1, f + 1 / (SEGMENTS - 1));
      this._b.lerpVectors(from, to, f2);
      this._b.y -= Math.sin(f2 * Math.PI) * drop;
      this._dir.subVectors(this._b, this._a);
      if (this._dir.lengthSq() < 1e-8) this._dir.subVectors(to, from);
      this._dir.normalize();

      // Ribbon frame. Facing the camera is ideal, but when you are looking
      // straight down your own rope that cross product collapses to zero and
      // the cable vanishes — which is exactly when you are using it. Fall back
      // to world up, then to world right.
      this._side.subVectors(this._a, this._toCam).cross(this._dir);
      if (this._side.lengthSq() < 1e-4) this._side.set(0, 1, 0).cross(this._dir);
      if (this._side.lengthSq() < 1e-4) this._side.set(1, 0, 0).cross(this._dir);
      this._side.normalize().multiplyScalar(width);

      const i6 = i * 6, i2 = i * 2;
      this.pos[i6] = this._a.x + this._side.x;
      this.pos[i6 + 1] = this._a.y + this._side.y;
      this.pos[i6 + 2] = this._a.z + this._side.z;
      this.pos[i6 + 3] = this._a.x - this._side.x;
      this.pos[i6 + 4] = this._a.y - this._side.y;
      this.pos[i6 + 5] = this._a.z - this._side.z;
      // Fade the very first segment so it disappears into the launcher.
      const a = Math.min(1, f * 6) * 0.95;
      this.alp[i2] = a; this.alp[i2 + 1] = a;
    }
    this.geometry.attributes.position.needsUpdate = true;
    this.geometry.attributes.aAlpha.needsUpdate = true;

    this.hook.position.copy(to);
    this.hook.lookAt(from);
    this.hook.rotateZ(performance.now() * 0.004);
  }

  dispose() {
    this.mesh.parent?.remove(this.mesh);
    this.hook.parent?.remove(this.hook);
    this.geometry.dispose();
    this.material.dispose();
    this.hook.geometry.dispose();
  }
}

export class GrappleFX {
  constructor(scene, camera) {
    this.scene = scene;
    this.camera = camera;
    this.cables = new Map();
    this._from = new THREE.Vector3();
    this._to = new THREE.Vector3();
  }

  _cable(id) {
    let c = this.cables.get(id);
    if (!c) { c = new Cable(this.scene, 0xf2f5f9); this.cables.set(id, c); }
    return c;
  }

  /**
   * @param {number} id
   * @param {object} g   grapple state {state, ax, ay, az, hx, hy, hz, travel, total}
   * @param {Avatar} avatar
   */
  show(id, g, avatar) {
    if (!g || g.state === GSTATE.IDLE) { this.cables.get(id)?.hide(); return; }
    const c = this._cable(id);
    avatar.grappleOrigin(this._from);

    if (g.state === GSTATE.FIRING) {
      // Remote players only send the anchor and a travel fraction.
      if (g.hx !== undefined && g.travel !== undefined) {
        this._to.set(g.hx, g.hy, g.hz);
      } else {
        const f = clamp01(g.t ?? 1);
        this._to.set(
          lerp(this._from.x, g.ax, f),
          lerp(this._from.y, g.ay, f),
          lerp(this._from.z, g.az, f),
        );
      }
      c.update(this._from, this._to, 0.15, this.camera, 0.95);
    } else {
      this._to.set(g.ax, g.ay, g.az);
      c.update(this._from, this._to, 1, this.camera, 0.80);
    }
  }

  hide(id) { this.cables.get(id)?.hide(); }

  remove(id) {
    const c = this.cables.get(id);
    if (c) { c.dispose(); this.cables.delete(id); }
  }
}

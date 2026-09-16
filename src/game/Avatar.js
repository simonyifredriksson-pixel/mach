/**
 * VELOCITY RONIN — the runner.
 *
 * A hand-built rig with a real blend tree. No pose is ever switched on: every
 * state contributes a WEIGHT to a shared set of pose parameters, the weights
 * are continuous functions of speed / grounded / airtime / grapple, and the
 * result is then critically damped. There is no frame anywhere in this file
 * where the character can snap.
 *
 *   idle ─┐
 *   walk ─┼─► weighted pose params ─► damped ─► joints ─► additive layers
 *  sprint─┤                                              (swing, land, aim)
 *  blitz ─┤
 *   air  ─┤
 * grapple─┘
 *
 * Foot skating is solved properly: stride frequency is derived from ground
 * speed divided by stride LENGTH, and stride length grows with speed, so at
 * 500 the character is taking 6.5-metre bounds at 7 Hz rather than running a
 * 20 Hz cycle in place.
 *
 * Geometry is merged per body part — one mesh per limb, two materials per
 * character — so a full lobby of ronin is still cheap to draw.
 */

import * as THREE from '../../lib/three.module.js';
import { CFG, speedT } from '../core/Config.js';
import { clamp, clamp01, lerp, damp, smoothstep, angleDelta } from '../core/Util.js';
import { WSTATE, ATTACK } from '../shared/Combat.js';
import { GSTATE } from '../shared/Grapple.js';
import { buildKatana } from '../economy/Cosmetics.js';
import { gradient } from '../world/Materials.js';

/* ------------------------------------------------------- merge helpers */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

/** A box piece: size, offset, colour, optional rotation and taper. */
function piece(w, h, d, x, y, z, color, rx = 0, ry = 0, rz = 0) {
  return { g: new THREE.BoxGeometry(w, h, d), x, y, z, color, rx, ry, rz };
}
function cylPiece(rt, rb, h, seg, x, y, z, color, rx = 0, ry = 0, rz = 0) {
  return { g: new THREE.CylinderGeometry(rt, rb, h, seg), x, y, z, color, rx, ry, rz };
}

/** Merge pieces into one geometry with vertex colours. */
function merge(pieces) {
  const pos = [], nrm = [], col = [];
  const c = new THREE.Color();
  for (const p of pieces) {
    const g = p.g.index ? p.g.toNonIndexed() : p.g;
    _e.set(p.rx, p.ry, p.rz);
    _q.setFromEuler(_e);
    _m.compose(_v.set(p.x, p.y, p.z), _q, new THREE.Vector3(1, 1, 1));
    g.applyMatrix4(_m);
    if (!g.attributes.normal) g.computeVertexNormals();
    const a = g.attributes.position.array, n = g.attributes.normal.array;
    c.setHex(p.color);
    for (let i = 0; i < a.length; i += 3) {
      pos.push(a[i], a[i + 1], a[i + 2]);
      nrm.push(n[i], n[i + 1], n[i + 2]);
      col.push(c.r, c.g, c.b);
    }
    g.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return out;
}

/** Joint node with a merged mesh hanging off it. */
function joint(parent, pieces, mat, y = 0) {
  const node = new THREE.Object3D();
  node.position.y = y;
  if (pieces.length) {
    const mesh = new THREE.Mesh(merge(pieces), mat);
    mesh.castShadow = true;
    node.add(mesh);
  }
  parent.add(node);
  return node;
}

/* ------------------------------------------------------------ pose sets */

// Every field is blended. Nothing here is ever assigned directly to a joint.
const POSE = {
  idle: { lean: 0.02, crouch: 0.00, stride: 0.10, armPump: 0.18, armSweep: 0, splay: 0.05, twist: 1.0, head: 0.00, bob: 0.25, tuck: 0 },
  walk: { lean: 0.09, crouch: 0.02, stride: 0.62, armPump: 0.75, armSweep: 0, splay: 0.05, twist: 1.0, head: 0.02, bob: 0.70, tuck: 0 },
  sprint: { lean: 0.34, crouch: 0.11, stride: 1.00, armPump: 1.00, armSweep: 0.10, splay: 0.10, twist: 0.9, head: 0.10, bob: 1.00, tuck: 0 },
  blitz: { lean: 0.66, crouch: 0.26, stride: 0.72, armPump: 0.15, armSweep: 1.00, splay: 0.22, twist: 0.5, head: 0.30, bob: 0.55, tuck: 0 },
  rise: { lean: 0.16, crouch: 0.00, stride: 0.00, armPump: 0.10, armSweep: 0.45, splay: 0.18, twist: 0.4, head: 0.00, bob: 0, tuck: 1.0 },
  fall: { lean: 0.08, crouch: 0.00, stride: 0.00, armPump: 0.05, armSweep: 0.30, splay: 0.30, twist: 0.4, head: -0.10, bob: 0, tuck: 0.35 },
  grapple: { lean: 0.30, crouch: 0.00, stride: 0.00, armPump: 0.00, armSweep: 0.75, splay: 0.20, twist: 0.6, head: 0.12, bob: 0, tuck: 0.65 },
};
const POSE_KEYS = Object.keys(POSE.idle);

export class Avatar {
  constructor(skinDef, katanaDef, sheathDef, opts = {}) {
    this.skin = skinDef;
    this.root = new THREE.Group();
    this.isLocal = !!opts.local;

    this.phase = Math.random() * 10;
    this.swing = 0;
    this.hurt = 0;
    this.landSquash = 0;
    this.landVel = 0;
    this.aimBlend = 0;
    this.prevYaw = 0;
    this.turnLean = 0;
    this.groundW = 1;
    this.blitzW = 0;

    // Live pose parameters (smoothed every frame).
    this.p = {};
    for (const k of POSE_KEYS) this.p[k] = POSE.idle[k];

    this._materials(skinDef.spec);
    this._build(skinDef.spec);
    this.setKatana(katanaDef, sheathDef);
    if (skinDef.spec.ghost) this._buildGhosts();
  }

  /* --------------------------------------------------------- materials */

  _materials(s) {
    this.matBody = new THREE.MeshToonMaterial({
      gradientMap: gradient(),
      vertexColors: true,
      transparent: !!s.translucent,
      opacity: s.translucent ?? 1,
    });
    this.matGlow = new THREE.MeshBasicMaterial({
      color: s.visor, toneMapped: false, transparent: true, opacity: 0.95,
    });
    this.matVent = new THREE.MeshBasicMaterial({
      color: s.trim, toneMapped: false, transparent: true, opacity: 0,
    });
  }

  /* ------------------------------------------------------------- build */

  _build(s) {
    const SUIT = s.suit, ACC = s.accent, TRIM = s.trim, CLOTH = s.cloth;
    const DARK = new THREE.Color(SUIT).multiplyScalar(0.72).getHex();
    const LEATHER = new THREE.Color(TRIM).multiplyScalar(0.92).getHex();

    this.body = new THREE.Object3D();
    this.root.add(this.body);

    /* ---- hips: narrow, with a working belt ---- */
    this.hips = joint(this.body, [
      piece(4.9, 3.0, 3.0, 0, 0, 0, SUIT),
      piece(5.2, 0.9, 3.3, 0, 1.2, 0, LEATHER),            // belt
      piece(1.5, 1.1, 0.7, 1.9, 1.2, 1.5, ACC),            // buckle
      piece(1.3, 1.6, 1.0, -2.0, 0.2, 1.2, LEATHER),       // pouch
      piece(1.1, 1.4, 0.9, 1.6, -0.1, -1.4, LEATHER),      // rear pouch
    ], this.matBody, 8.7);

    /* ---- chest: tapered, with a rig ---- */
    // Deliberately lean: a runner, not a tank. Width comes from the pauldron
    // and the coat, never from the torso itself.
    this.chest = joint(this.hips, [
      piece(4.7, 4.6, 2.8, 0, 2.5, 0, SUIT),               // ribcage
      piece(5.2, 1.6, 3.0, 0, 4.6, 0, SUIT),               // upper chest
      piece(2.3, 1.7, 0.45, 0, 3.1, 1.55, ACC),            // sternum plate
      piece(3.4, 0.5, 0.4, 0, 1.9, 1.5, LEATHER),          // lower rib strap
      piece(0.7, 4.4, 0.4, -1.4, 3.0, 1.55, LEATHER, 0, 0, 0.30),  // rig strap
      piece(0.7, 4.4, 0.4, 1.4, 3.0, 1.55, LEATHER, 0, 0, -0.30),
      piece(2.6, 2.2, 0.9, 0, 3.4, -1.7, DARK),            // compact back pack
      piece(0.6, 0.6, 2.0, 0, 4.4, -2.0, TRIM),            // hook mount
    ], this.matBody, 1.4);

    if (s.vents) {
      this.vents = [];
      for (let i = 0; i < 3; i++) {
        const v = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.8, 0.35), this.matVent);
        v.position.set(-1.9 + i * 1.9, 3.2, -1.8);
        this.chest.add(v);
        this.vents.push(v);
      }
    }

    /* ---- head: hood + mask, distinct silhouette ---- */
    this.neck = joint(this.chest, [
      piece(2.6, 2.6, 2.6, 0, 1.5, 0, SUIT),               // skull
      piece(2.9, 1.2, 2.9, 0, 2.6, -0.1, CLOTH),           // hood crown
      piece(3.2, 2.2, 1.4, 0, 1.6, -1.2, CLOTH),           // hood back
      piece(2.4, 1.3, 0.6, 0, 0.9, 1.25, DARK),            // face mask
      piece(0.45, 0.8, 0.45, 1.1, 2.7, -0.7, ACC, 0.5, 0, 0.35),    // topknot tie
      piece(0.34, 1.9, 0.34, 1.25, 3.2, -1.15, TRIM, 0.9, 0, 0.35),
    ], this.matBody, 5.3);
    this.visor = new THREE.Mesh(new THREE.BoxGeometry(2.45, 0.55, 0.42), this.matGlow);
    this.visor.position.set(0, 1.75, 1.35);
    this.neck.add(this.visor);

    if (s.lantern) {
      const lamp = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 3.2, 10), this.matGlow);
      lamp.position.y = 1.6;
      this.neck.add(lamp);
      this.lantern = lamp;
    }

    /* ---- arms ---- */
    // Right side carries the blade and hangs off a chest pivot, so the whole
    // body drives a cut instead of just the shoulder.
    this.swingPivot = new THREE.Object3D();
    this.swingPivot.position.set(0, 4.4, 0);
    this.chest.add(this.swingPivot);

    this.shoulderR = new THREE.Object3D();
    this.shoulderR.position.set(2.75, 0, 0);
    this.swingPivot.add(this.shoulderR);
    const pauldron = new THREE.Mesh(merge([
      piece(2.4, 1.5, 2.8, 0.25, 0.25, 0, ACC),
      piece(2.0, 0.6, 2.4, 0.35, 1.05, 0, TRIM),
    ]), this.matBody);
    pauldron.castShadow = true;
    this.shoulderR.add(pauldron);
    this.armR = joint(this.shoulderR, [piece(1.35, 3.4, 1.35, 0, -1.7, 0, SUIT)], this.matBody);
    this.foreR = joint(this.armR, [
      piece(1.2, 3.2, 1.2, 0, -1.6, 0, SUIT),
      piece(1.45, 1.5, 1.45, 0, -2.5, 0, LEATHER),         // bracer
    ], this.matBody, -3.4);
    this.handR = joint(this.foreR, [piece(1.1, 1.1, 1.3, 0, -0.45, 0.1, DARK)], this.matBody, -3.2);

    // Left side carries the grapple launcher.
    this.shoulderL = new THREE.Object3D();
    this.shoulderL.position.set(-2.75, 4.4, 0);
    this.chest.add(this.shoulderL);
    const strap = new THREE.Mesh(merge([piece(1.9, 0.9, 2.5, -0.2, 0.3, 0, TRIM)]), this.matBody);
    this.shoulderL.add(strap);
    this.armL = joint(this.shoulderL, [piece(1.35, 3.4, 1.35, 0, -1.7, 0, SUIT)], this.matBody);
    this.foreL = joint(this.armL, [
      piece(1.2, 3.2, 1.2, 0, -1.6, 0, SUIT),
      // grapple launcher: block, spool, muzzle
      piece(1.7, 1.9, 2.4, -0.15, -2.3, 0.5, DARK),
      cylPiece(0.75, 0.75, 0.5, 10, -0.15, -2.3, 1.0, TRIM, 0, 0, Math.PI / 2),
      cylPiece(0.34, 0.34, 1.5, 8, -0.15, -2.9, 1.5, ACC, Math.PI / 2, 0, 0),
    ], this.matBody, -3.4);
    this.handL = joint(this.foreL, [piece(1.1, 1.1, 1.3, 0, -0.45, 0.1, DARK)], this.matBody, -3.2);
    // Muzzle marker: where the cable is drawn from.
    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(-0.15, -3.6, 2.1);
    this.foreL.add(this.muzzle);
    this.launcherLight = new THREE.Mesh(new THREE.SphereGeometry(0.30, 6, 5), this.matGlow);
    this.launcherLight.position.set(-0.15, -2.3, 1.35);
    this.foreL.add(this.launcherLight);

    /* ---- legs: thigh, shin, knee pad, boot ---- */
    const leg = (side) => {
      const hip = new THREE.Object3D();
      hip.position.set(side * 1.45, -1.4, 0);
      this.hips.add(hip);
      const thigh = joint(hip, [
        piece(1.75, 4.3, 1.75, 0, -2.15, 0, SUIT),
        piece(1.95, 0.7, 1.95, 0, -3.3, 0, LEATHER),       // thigh strap
      ], this.matBody);
      const shin = joint(thigh, [
        piece(1.5, 4.0, 1.5, 0, -2.0, 0, DARK),
        piece(1.7, 1.2, 0.8, 0, -0.35, 0.65, ACC),         // knee pad
        piece(1.75, 1.6, 1.9, 0, -3.5, 0.15, LEATHER),     // boot upper
        piece(1.9, 0.6, 3.1, 0, -4.25, 0.55, TRIM),        // sole
      ], this.matBody, -4.3);
      return { hip, thigh, shin };
    };
    const L = leg(-1), R = leg(1);
    this.thighL = L.thigh; this.shinL = L.shin;
    this.thighR = R.thigh; this.shinR = R.shin;

    /* ---- cloth: scarf and coat tails ---- */
    this.scarf = [];
    {
      let parent = this.neck;
      for (let i = 0; i < 5; i++) {
        const seg = new THREE.Object3D();
        seg.position.set(0, i === 0 ? 0.5 : 0, i === 0 ? -1.1 : -2.1);
        const mesh = new THREE.Mesh(merge([
          piece(1.9 - i * 0.24, 0.42, 2.2, 0, 0, -1.1, CLOTH),
        ]), this.matBody);
        seg.add(mesh);
        parent.add(seg);
        parent = seg;
        this.scarf.push(seg);
      }
    }
    this.tails = [];
    for (const side of [-1, 1]) {
      let parent = this.hips;
      const chain = [];
      for (let i = 0; i < 3; i++) {
        const seg = new THREE.Object3D();
        seg.position.set(i === 0 ? side * 1.5 : 0, i === 0 ? 0.6 : -2.6, i === 0 ? -1.4 : 0);
        const mesh = new THREE.Mesh(merge([
          piece(2.3 - i * 0.35, 2.8, 0.42, 0, -1.4, 0, CLOTH),
        ]), this.matBody);
        seg.add(mesh);
        parent.add(seg);
        parent = seg;
        chain.push(seg);
      }
      this.tails.push(chain);
    }

    /* ---- saya on the hip ---- */
    this.sheathNode = new THREE.Object3D();
    this.sheathNode.position.set(-2.7, 0.2, -0.5);
    this.sheathNode.rotation.set(-1.32, 0.22, 0.30);
    this.hips.add(this.sheathNode);
  }

  _buildGhosts() {
    this.ghostHistory = [];
    this.ghosts = [];
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.15, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < 3; i++) {
      const clone = this.body.clone(true);
      clone.traverse((o) => { if (o.isMesh) o.material = mat; o.castShadow = false; });
      const holder = new THREE.Group();
      holder.add(clone);
      this.ghosts.push({ holder, nodes: collectNodes(clone), delay: 0.07 + i * 0.07 });
    }
    this.selfNodes = collectNodes(this.body);
    this._ghostParentPending = true;
  }

  /* ------------------------------------------------------------ katana */

  setKatana(katanaDef, sheathDef) {
    if (this.katana) {
      this.katana.group.parent?.remove(this.katana.group);
      this.katana.group.traverse((o) => { if (o.isMesh) o.geometry.dispose?.(); });
    }
    this.katanaDef = katanaDef;
    this.katana = buildKatana(katanaDef);
    this.handR.add(this.katana.group);
    this.katana.group.position.set(0, -0.3, 0);
    this.katanaHeld = true;

    if (this.sheathMesh) this.sheathNode.remove(this.sheathMesh);
    const sp = sheathDef?.spec ?? { color: 0x101014, trim: 0x3d434f };
    const len = (katanaDef.spec.blade.len ?? 11) + 1.6;
    const saya = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.60, 0.50, len, 8),
      new THREE.MeshStandardMaterial({ color: sp.color, metalness: sp.metal ?? 0.3, roughness: sp.metal ? 0.1 : 0.55 }),
    );
    body.position.y = len / 2;
    body.castShadow = true;
    saya.add(body);
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.63, 0.1, 5, 10),
        new THREE.MeshStandardMaterial({ color: sp.trim, metalness: 0.8, roughness: 0.3, emissive: sp.glow ? sp.trim : 0x000000 }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 1.2 + i * (len - 3) / 2;
      saya.add(ring);
    }
    this.sheathMesh = saya;
    this.sheathNode.add(saya);
  }

  setWeaponSheathed(sheathed) {
    if (sheathed === !this.katanaHeld) return;
    this.katanaHeld = !sheathed;
    const g = this.katana.group;
    g.parent?.remove(g);
    if (sheathed) {
      this.sheathNode.add(g);
      g.position.set(0, 0, 0);
      g.rotation.set(0, 0, 0);
    } else {
      this.handR.add(g);
      g.position.set(0, -0.3, 0);
      g.rotation.set(0, 0, 0);
    }
  }

  bladePoints(tip, base) {
    this.katana.group.updateWorldMatrix(true, false);
    tip.copy(this.katana.tipLocal).applyMatrix4(this.katana.group.matrixWorld);
    base.copy(this.katana.baseLocal).applyMatrix4(this.katana.group.matrixWorld);
  }

  /** World position of the grapple launcher muzzle — where the cable starts. */
  grappleOrigin(out) {
    this.muzzle.updateWorldMatrix(true, false);
    return out.setFromMatrixPosition(this.muzzle.matrixWorld);
  }

  /* ------------------------------------------------------------ update */

  /**
   * @param {object} st {speed, grounded, yaw, pitch, combatState, phase,
   *   swingIndex, attackType, alive, velY, grapple:{state,ax,ay,az}, turnRate}
   */
  update(dt, st) {
    const speed = st.speed;
    const t = speedT(speed);
    const grounded = st.grounded;
    const gs = st.grapple ? st.grapple.state : GSTATE.IDLE;
    const hooked = gs === GSTATE.ATTACHED;

    /* ------------------------------------------------- blend weights */
    // Grounded-ness itself is smoothed, so touching down is a transition and
    // not a switch.
    this.groundW = damp(this.groundW, grounded ? 1 : 0, 14, dt);
    const air = 1 - this.groundW;

    const wBlitz = clamp01((speed - 290) / 190);
    const wSprint = clamp01((speed - 85) / 140) * (1 - wBlitz);
    const wWalk = clamp01((speed - 6) / 70) * (1 - wSprint - wBlitz);
    const wIdle = Math.max(0, 1 - wWalk - wSprint - wBlitz);
    this.blitzW = wBlitz;

    const rising = (st.velY || 0) > 20;
    const wGrapple = hooked ? 1 : 0;
    const airPart = air * (1 - wGrapple);

    const W = {
      idle: this.groundW * wIdle * (1 - wGrapple),
      walk: this.groundW * wWalk * (1 - wGrapple),
      sprint: this.groundW * wSprint * (1 - wGrapple),
      blitz: this.groundW * wBlitz * (1 - wGrapple),
      rise: airPart * (rising ? 1 : 0),
      fall: airPart * (rising ? 0 : 1),
      grapple: wGrapple,
    };
    let total = 0;
    for (const k in W) total += W[k];
    if (total < 1e-4) { W.idle = 1; total = 1; }

    // Weighted sum of every pose set, then damp. Double-smoothed on purpose.
    const tgt = {};
    for (const key of POSE_KEYS) tgt[key] = 0;
    for (const name in W) {
      const w = W[name] / total;
      if (w <= 0) continue;
      const pose = POSE[name];
      for (const key of POSE_KEYS) tgt[key] += pose[key] * w;
    }
    for (const key of POSE_KEYS) this.p[key] = damp(this.p[key], tgt[key], 11, dt);
    const P = this.p;

    /* ------------------------------------------------------ gait clock */
    // Stride LENGTH grows with speed, so frequency stays human and the feet
    // never skate: at 500 this is a 6.5 m bound at about 7 Hz.
    const strideLen = lerp(16, 68, Math.pow(t, 0.9));
    const freq = clamp(speed / strideLen, 0.55, 7.6);
    if (this.groundW > 0.25 && speed > 4) this.phase += dt * freq * Math.PI * 2;
    else this.phase += dt * 1.4;                       // idle breathing
    const ph = this.phase;

    const amp = P.stride * (0.55 + t * 0.85);

    /* ---------------------------------------------------- body posture */
    const turn = st.turnRate || 0;
    this.turnLean = damp(this.turnLean, clamp(turn * 0.35, -0.42, 0.42) * (0.3 + t), 6, dt);

    this.body.rotation.x = P.lean;
    this.body.rotation.z = this.turnLean;
    this.body.position.y = -P.lean * 2.0 - P.crouch * 2.4;

    // Landing squash: a spring, so it recovers smoothly instead of popping.
    this.landVel += -this.landSquash * 190 * dt;
    this.landVel *= Math.exp(-12 * dt);
    this.landSquash += this.landVel * dt;
    if (Math.abs(this.landSquash) < 0.001) { this.landSquash = 0; this.landVel = 0; }

    const bob = Math.sin(ph * 2) * 0.34 * P.bob * this.groundW;
    this.hips.position.y = 8.7 + bob + this.landSquash * 3.2;
    this.hips.rotation.z = Math.sin(ph) * 0.055 * P.bob;
    this.hips.rotation.y = Math.sin(ph) * 0.17 * P.twist;
    this.chest.rotation.y = -this.hips.rotation.y * 0.75;
    this.chest.rotation.x = P.crouch * 0.5 + this.landSquash * 1.2;

    /* --------------------------------------------------------- legs */
    const tuck = P.tuck;
    const legL = Math.sin(ph), legR = Math.sin(ph + Math.PI);
    const groundLegL = legL * amp;
    const groundLegR = legR * amp;
    const kneeL = clamp(-Math.sin(ph - 0.75) * amp * 1.35, -2.1, 0.05);
    const kneeR = clamp(-Math.sin(ph + Math.PI - 0.75) * amp * 1.35, -2.1, 0.05);

    // Air/grapple legs trail and tuck; blended, never switched.
    const airLegL = lerp(-0.35, -1.15, tuck);
    const airLegR = lerp(0.25, -0.55, tuck);
    const airKneeL = lerp(-0.55, -1.65, tuck);
    const airKneeR = lerp(-0.35, -0.95, tuck);

    const gw = this.groundW;
    this.thighL.rotation.x = lerp(airLegL, groundLegL, gw) - P.crouch * 0.6;
    this.thighR.rotation.x = lerp(airLegR, groundLegR, gw) - P.crouch * 0.6;
    this.shinL.rotation.x = lerp(airKneeL, kneeL, gw) - P.crouch * 0.5;
    this.shinR.rotation.x = lerp(airKneeR, kneeR, gw) - P.crouch * 0.5;
    this.thighL.rotation.z = P.splay * 0.35;
    this.thighR.rotation.z = -P.splay * 0.35;

    /* --------------------------------------------------------- weapon */
    const cs = st.combatState;
    const attacking = cs === WSTATE.WINDUP || cs === WSTATE.ACTIVE;
    const recovering = cs === WSTATE.RECOVER;
    this.setWeaponSheathed(cs === WSTATE.SHEATHED || (cs === WSTATE.SHEATHING && st.phase > 0.6));

    const dir = st.swingIndex === 1 ? -1 : 1;
    let swingTarget = 0;
    if (cs === WSTATE.WINDUP) swingTarget = -1;
    else if (cs === WSTATE.ACTIVE) swingTarget = lerp(-0.4, 1, st.phase);
    else if (recovering) swingTarget = lerp(1, 0.12, clamp01(st.phase * 1.4));
    const rate = cs === WSTATE.ACTIVE ? 40 : cs === WSTATE.WINDUP ? 15 : 8;
    this.swing = damp(this.swing, swingTarget, rate, dt);

    const sw = this.swing * dir;
    const rising2 = st.swingIndex === 2;
    const iai = st.attackType === ATTACK.IAI;

    this.swingPivot.rotation.y = -sw * 1.7;
    this.swingPivot.rotation.z = rising2 ? sw * 0.5 - 0.28 : sw * 0.26;
    this.swingPivot.rotation.x = rising2 ? -0.65 - sw * 0.45 : (attacking || recovering ? -0.22 : 0);
    this.chest.rotation.y += -sw * 0.40;
    this.hips.rotation.y += -sw * 0.13;

    const pump = Math.sin(ph + Math.PI) * amp * 0.85 * P.armPump;
    const pumpL = Math.sin(ph) * amp * 0.85 * P.armPump;
    const sweep = P.armSweep;

    if (attacking || recovering) {
      const f = clamp01(this.swing * 0.5 + 0.5);
      this.armR.rotation.x = lerp(-1.3, -0.32, f);
      this.armR.rotation.z = iai ? -0.55 : -0.22;
      this.foreR.rotation.x = lerp(-1.5, -0.25, f);
      this.handR.rotation.z = rising2 ? -0.5 : 0.25;
      this.handR.rotation.x = iai ? -0.4 : -0.15;
    } else if (this.katanaHeld) {
      // Guard stance, tightening as you accelerate.
      this.armR.rotation.x = damp(this.armR.rotation.x, lerp(-0.30, -1.05, sweep) + pump * 0.5, 9, dt);
      this.armR.rotation.z = damp(this.armR.rotation.z, lerp(-0.20, -0.42, sweep), 9, dt);
      this.foreR.rotation.x = damp(this.foreR.rotation.x, lerp(-0.80, -1.25, sweep), 9, dt);
      this.handR.rotation.set(0.1, 0, 0.5);
    } else {
      // Sheathed: hand rides the saya, ready for the iai.
      const reach = cs === WSTATE.WINDUP ? 1 : 0;
      this.armR.rotation.x = damp(this.armR.rotation.x, lerp(pump, -1.0, Math.max(sweep, reach)), 9, dt);
      this.armR.rotation.z = damp(this.armR.rotation.z, lerp(-0.08, -0.7, reach), 9, dt);
      this.foreR.rotation.x = damp(this.foreR.rotation.x, lerp(-0.35, -1.5, reach), 9, dt);
      this.handR.rotation.set(0, 0, 0);
    }

    /* ---------------------------------------- left arm / grapple aim */
    // When the hook is out, the launcher arm points at the anchor. Blended in
    // and out, so the arm travels to the target rather than teleporting.
    const wantAim = gs !== GSTATE.IDLE ? 1 : 0;
    this.aimBlend = damp(this.aimBlend, wantAim, 12, dt);

    let aimPitch = 0, aimYaw = 0;
    if (this.aimBlend > 0.01 && st.grapple) {
      this.root.updateWorldMatrix(true, false);
      _v.set(st.grapple.ax, st.grapple.ay, st.grapple.az);
      this.root.worldToLocal(_v);
      const horiz = Math.hypot(_v.x, _v.z);
      aimPitch = clamp(Math.atan2(_v.y - 13, horiz), -1.2, 1.3);
      aimYaw = clamp(Math.atan2(_v.x, -_v.z), -1.1, 1.1);
    }

    const restL = lerp(pumpL, -2.0, sweep);
    const restLz = lerp(0.10, 0.44, sweep);
    this.armL.rotation.x = damp(this.armL.rotation.x, lerp(restL, -aimPitch - 1.35, this.aimBlend), 12, dt);
    this.armL.rotation.z = damp(this.armL.rotation.z, lerp(restLz, aimYaw * 0.6 + 0.2, this.aimBlend), 12, dt);
    this.armL.rotation.y = damp(this.armL.rotation.y, lerp(0, aimYaw * 0.5, this.aimBlend), 12, dt);
    this.foreL.rotation.x = damp(this.foreL.rotation.x, lerp(-0.45 - Math.max(0, pumpL) * 0.5, -0.12, this.aimBlend), 12, dt);

    this.launcherLight.material = this.matGlow;
    this.launcherLight.visible = this.aimBlend > 0.05;

    /* ---------------------------------------------------------- head */
    this.neck.rotation.x = damp(this.neck.rotation.x,
      clamp(-P.lean * 0.8 + P.head + (st.pitch || 0) * 0.3, -0.8, 0.7), 9, dt);
    this.neck.rotation.z = -this.turnLean * 0.4;

    /* --------------------------------------------------------- cloth */
    const wind = 0.35 + t * 1.5;
    const flutter = Math.sin(this.phase * 1.7) * 0.10 * (0.3 + t);
    for (let i = 0; i < this.scarf.length; i++) {
      const seg = this.scarf[i];
      const lag = wind + i * 0.10 - P.lean * 0.45;
      seg.rotation.x = damp(seg.rotation.x, lag + flutter * (i + 1), 9 - i * 1.1, dt);
      seg.rotation.y = damp(seg.rotation.y, Math.sin(this.phase * 1.15 + i * 0.7) * 0.22 * (0.35 + t) - this.turnLean * 0.5, 7, dt);
    }
    for (let s = 0; s < this.tails.length; s++) {
      const side = s === 0 ? -1 : 1;
      for (let i = 0; i < this.tails[s].length; i++) {
        const seg = this.tails[s][i];
        const lag = wind * 0.8 + i * 0.16;
        seg.rotation.x = damp(seg.rotation.x, lag + flutter * (i + 1) * 0.7, 8 - i, dt);
        seg.rotation.z = damp(seg.rotation.z, side * (0.10 + t * 0.30) + this.turnLean * 0.6, 7, dt);
      }
    }

    /* ------------------------------------------------------ specials */
    if (this.vents) {
      const heat = Math.pow(t, 1.5);
      for (const v of this.vents) { v.material.opacity = heat * 0.9; v.scale.y = 0.6 + heat; }
    }
    if (this.lantern) {
      this.lantern.material.opacity = 0.65 + Math.sin(performance.now() * 0.004) * 0.10 + t * 0.2;
    }
    if (this.katana?.extras) {
      const now = performance.now() * 0.001;
      for (const e of this.katana.extras) {
        if (e.type === 'speedGlow') e.mesh.material.opacity = 0.35 + t * 0.65;
        else if (e.type === 'pulse') e.mesh.material.opacity = 0.16 + Math.sin(now * e.rate * 6.28) * 0.1 + t * 0.2;
        else if (e.type === 'flicker') e.mesh.material.opacity = 0.12 + Math.random() * 0.14 + t * 0.25;
        else if (e.type === 'spin') e.mesh.rotation.z += dt * e.rate;
        else if (e.type === 'tick') e.mesh.rotation.y = -Math.floor(now) * (Math.PI / 30);
      }
    }

    /* ---------------------------------------------------- hit flash */
    this.hurt = Math.max(0, this.hurt - dt * 4);
    if (this.matBody.emissive) {
      const f = this.hurt;
      this.matBody.emissive.setRGB(f * 0.9, f * 0.12, f * 0.08);
    }

    if (this.ghosts) this._updateGhosts(dt);
  }

  /** Called on landing: kicks the squash spring. */
  land(power) {
    const t = clamp01(power / 420);
    this.landVel -= 0.9 + t * 3.4;
  }

  _updateGhosts(dt) {
    if (this._ghostParentPending && this.root.parent) {
      for (const g of this.ghosts) this.root.parent.add(g.holder);
      this._ghostParentPending = false;
    }
    const now = performance.now() * 0.001;
    this.ghostHistory.push({ t: now, p: this.root.position.clone(), r: this.root.rotation.y });
    while (this.ghostHistory.length > 60) this.ghostHistory.shift();
    for (const g of this.ghosts) {
      const want = now - g.delay;
      let s = this.ghostHistory[0];
      for (let i = this.ghostHistory.length - 1; i >= 0; i--) {
        if (this.ghostHistory[i].t <= want) { s = this.ghostHistory[i]; break; }
      }
      g.holder.position.copy(s.p);
      g.holder.rotation.y = s.r;
      for (let i = 0; i < g.nodes.length && i < this.selfNodes.length; i++) {
        g.nodes[i].quaternion.copy(this.selfNodes[i].quaternion);
        g.nodes[i].position.copy(this.selfNodes[i].position);
      }
    }
  }

  takeHit() { this.hurt = 1; }

  dispose() {
    this.root.parent?.remove(this.root);
    if (this.ghosts) for (const g of this.ghosts) g.holder.parent?.remove(g.holder);
  }
}

function collectNodes(root) {
  const out = [];
  root.traverse((o) => { if (!o.isMesh) out.push(o); });
  return out;
}

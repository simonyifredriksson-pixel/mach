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
import { PSTATE } from '../shared/Parkour.js';
import { buildKatana } from '../economy/Cosmetics.js';
import { gradient } from '../world/Materials.js';

/* ------------------------------------------------------- merge helpers */

const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _e = new THREE.Euler();
const _v = new THREE.Vector3();

/* ---------------------------------------------------------------------------
   Smooth body parts. Everything below is a rounded, smooth-shaded primitive —
   capsules, lathes, spheres and tori — rather than boxes, because a character
   built from cubes reads as a prototype no matter how well it is animated.
   Normals survive the merge, so limbs shade as continuous surfaces.
--------------------------------------------------------------------------- */

const _s1 = new THREE.Vector3(1, 1, 1);

/** Rounded limb / cloth segment. */
function capsule(r, len, color, x = 0, y = 0, z = 0, o = {}) {
  return {
    g: new THREE.CapsuleGeometry(r, len, 3, o.seg || 10),
    x, y, z, color,
    rx: o.rx || 0, ry: o.ry || 0, rz: o.rz || 0,
    sx: o.sx ?? 1, sy: o.sy ?? 1, sz: o.sz ?? 1,
  };
}
function ball(r, color, x = 0, y = 0, z = 0, o = {}) {
  return {
    g: new THREE.SphereGeometry(r, o.seg || 12, o.seg2 || 9),
    x, y, z, color,
    rx: o.rx || 0, ry: o.ry || 0, rz: o.rz || 0,
    sx: o.sx ?? 1, sy: o.sy ?? 1, sz: o.sz ?? 1,
  };
}
/** Body of revolution from [radius, height] pairs — torsos, hoods, skirts. */
function lathe(profile, color, x = 0, y = 0, z = 0, o = {}) {
  const pts = profile.map(([r, h]) => new THREE.Vector2(Math.max(0.001, r), h));
  return {
    g: new THREE.LatheGeometry(pts, o.seg || 14),
    x, y, z, color,
    rx: o.rx || 0, ry: o.ry || 0, rz: o.rz || 0,
    sx: o.sx ?? 1, sy: o.sy ?? 1, sz: o.sz ?? 1,
  };
}
function ring(r, tube, color, x = 0, y = 0, z = 0, o = {}) {
  return {
    g: new THREE.TorusGeometry(r, tube, 6, o.seg || 14),
    x, y, z, color,
    rx: o.rx ?? Math.PI / 2, ry: o.ry || 0, rz: o.rz || 0,
    sx: o.sx ?? 1, sy: o.sy ?? 1, sz: o.sz ?? 1,
  };
}
/** Straps, blades and plates, where a flat slab is genuinely the right shape. */
function slab(w, h, d, x, y, z, color, rx = 0, ry = 0, rz = 0) {
  return { g: new THREE.BoxGeometry(w, h, d), x, y, z, color, rx, ry, rz, sx: 1, sy: 1, sz: 1 };
}

/** Merge pieces into one geometry with vertex colours. */
function merge(pieces) {
  const pos = [], nrm = [], col = [];
  const c = new THREE.Color();
  for (const p of pieces) {
    const g = p.g.index ? p.g.toNonIndexed() : p.g;
    _e.set(p.rx, p.ry, p.rz);
    _q.setFromEuler(_e);
    _m.compose(_v.set(p.x, p.y, p.z), _q, new THREE.Vector3(p.sx ?? 1, p.sy ?? 1, p.sz ?? 1));
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
  // Parkour. Wall-running still cycles the legs — you are RUNNING on it, not
  // standing sideways on it — and the slide folds the body down over one leg.
  wallrun: { lean: 0.26, crouch: 0.06, stride: 0.88, armPump: 0.55, armSweep: 0.35, splay: 0.08, twist: 0.45, head: 0.06, bob: 0.45, tuck: 0 },
  wallclimb: { lean: -0.34, crouch: 0.00, stride: 0.95, armPump: 0.85, armSweep: 0.00, splay: 0.10, twist: 0.35, head: -0.25, bob: 0.30, tuck: 0 },
  slide: { lean: 0.30, crouch: 1.00, stride: 0.00, armPump: 0.00, armSweep: 0.85, splay: 0.45, twist: 0.3, head: 0.18, bob: 0, tuck: 0 },
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
    this.wallRoll = 0;
    this.slideW = 0;
    this.kickPulse = 0;

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

    /* ---- hips: a turned form, not a box ---- */
    this.hips = joint(this.body, [
      lathe([[1.3, -1.6], [2.1, -1.0], [2.45, -0.1], [2.35, 0.8], [1.95, 1.5]], SUIT, 0, 0, 0, { sz: 0.82 }),
      ring(2.3, 0.28, LEATHER, 0, 1.15, 0, { sz: 0.86 }),           // belt
      slab(1.2, 0.85, 0.45, 1.45, 1.15, 1.35, ACC),                 // buckle
      capsule(0.5, 0.8, LEATHER, -1.95, 0.1, 0.95, { sz: 0.7 }),    // pouch
      capsule(0.45, 0.6, LEATHER, 1.6, -0.1, -1.15, { sz: 0.7 }),
    ], this.matBody, 8.7);

    /* ---- torso: ONE continuous tapered form, waist to shoulders ---- */
    this.chest = joint(this.hips, [
      lathe([
        [1.85, 0.0], [2.25, 0.9], [2.55, 2.1], [2.7, 3.2],
        [2.65, 4.2], [2.3, 5.0], [1.45, 5.5],
      ], SUIT, 0, 0, 0, { sz: 0.76, seg: 16 }),
      // Chest piece curved to the body instead of a flat plate stuck on it.
      lathe([[1.35, 2.4], [1.6, 3.1], [1.4, 3.8]], ACC, 0, 0, 1.05, { sz: 0.34, seg: 12 }),
      slab(0.52, 4.2, 0.26, -1.45, 3.0, 1.2, LEATHER, 0, 0, 0.30),  // rig straps
      slab(0.52, 4.2, 0.26, 1.45, 3.0, 1.2, LEATHER, 0, 0, -0.30),
      ring(2.45, 0.15, LEATHER, 0, 1.9, 0, { sz: 0.8 }),
      capsule(1.05, 1.4, DARK, 0, 3.4, -1.85, { sz: 0.55 }),        // compact pack
      capsule(0.24, 1.4, TRIM, 0, 4.4, -1.95, { rx: Math.PI / 2 }), // hook mount
    ], this.matBody, 1.4);

    if (s.vents) {
      this.vents = [];
      for (let i = 0; i < 3; i++) {
        const v = new THREE.Mesh(new THREE.CapsuleGeometry(0.28, 1.2, 2, 8), this.matVent);
        v.position.set(-1.6 + i * 1.6, 3.2, -1.75);
        this.chest.add(v);
        this.vents.push(v);
      }
    }

    /* ---- head: rounded skull under a shaped hood ---- */
    this.neck = joint(this.chest, [
      capsule(0.52, 0.5, DARK, 0, 0.35, 0, { sz: 0.9 }),            // neck
      ball(1.32, SUIT, 0, 1.55, 0.05, { sx: 0.95, sy: 1.12, sz: 1.0 }),   // skull
      // Hood: a lathe shell that sits over the skull and flares at the back.
      lathe([[0.7, 2.75], [1.45, 2.1], [1.72, 1.2], [1.68, 0.35], [1.5, -0.1]],
        CLOTH, 0, 0, -0.15, { sz: 1.12, seg: 14 }),
      ball(1.1, CLOTH, 0, 1.15, -1.25, { sx: 1.25, sy: 1.15, sz: 0.85 }), // hood fall
      ball(0.95, DARK, 0, 1.15, 0.72, { sx: 1.05, sy: 0.72, sz: 0.55 }),  // face mask
      capsule(0.2, 1.5, TRIM, 1.0, 2.5, -0.95, { rx: 0.95, rz: 0.3 }),    // topknot
      ring(0.32, 0.12, ACC, 0.82, 2.45, -0.5, { rx: 1.1, rz: 0.3 }),      // tie
    ], this.matBody, 5.3);
    // Visor: a curved band, not a slab.
    this.visor = new THREE.Mesh(
      new THREE.SphereGeometry(1.24, 16, 8, Math.PI * 0.72, Math.PI * 0.56, Math.PI * 0.44, Math.PI * 0.16),
      this.matGlow,
    );
    this.visor.position.set(0, 1.55, 0.05);
    this.visor.scale.set(0.98, 1.12, 1.04);
    this.neck.add(this.visor);

    if (s.lantern) {
      const lamp = new THREE.Mesh(new THREE.SphereGeometry(1.5, 14, 10), this.matGlow);
      lamp.position.y = 1.5;
      lamp.scale.y = 1.15;
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
    // Curved pauldron: a sphere cap that wraps the shoulder.
    const pauldron = new THREE.Mesh(merge([
      ball(1.5, ACC, 0.3, 0.15, 0, { sx: 1.0, sy: 0.85, sz: 1.15 }),
      ring(1.25, 0.16, TRIM, 0.35, 0.55, 0, { rx: 0, rz: Math.PI / 2, sz: 1.1 }),
    ]), this.matBody);
    pauldron.castShadow = true;
    this.shoulderR.add(pauldron);
    this.armR = joint(this.shoulderR, [
      capsule(0.66, 2.5, SUIT, 0, -1.7, 0),
    ], this.matBody);
    this.foreR = joint(this.armR, [
      ball(0.62, SUIT, 0, 0, 0),                                    // elbow
      capsule(0.55, 2.3, SUIT, 0, -1.6, 0),
      capsule(0.68, 1.0, LEATHER, 0, -2.45, 0),                     // bracer
    ], this.matBody, -3.4);
    this.handR = joint(this.foreR, [
      ball(0.52, DARK, 0, -0.42, 0.08, { sx: 0.95, sy: 1.15, sz: 0.8 }),
    ], this.matBody, -3.2);

    // Left side carries the grapple launcher.
    this.shoulderL = new THREE.Object3D();
    this.shoulderL.position.set(-2.75, 4.4, 0);
    this.chest.add(this.shoulderL);
    const strap = new THREE.Mesh(merge([
      ball(1.05, TRIM, -0.2, 0.15, 0, { sx: 0.9, sy: 0.8, sz: 1.15 }),
    ]), this.matBody);
    this.shoulderL.add(strap);
    this.armL = joint(this.shoulderL, [
      capsule(0.66, 2.5, SUIT, 0, -1.7, 0),
    ], this.matBody);
    this.foreL = joint(this.armL, [
      ball(0.62, SUIT, 0, 0, 0),
      capsule(0.55, 2.3, SUIT, 0, -1.6, 0),
      // grapple launcher: a rounded housing, a spool, a muzzle
      capsule(0.72, 1.3, DARK, -0.12, -2.3, 0.45, { rx: Math.PI / 2, sz: 0.85 }),
      ring(0.62, 0.2, TRIM, -0.12, -2.3, 0.95, { rx: 0, rz: Math.PI / 2 }),
      capsule(0.26, 1.0, ACC, -0.12, -2.85, 1.25, { rx: Math.PI / 2 }),
    ], this.matBody, -3.4);
    this.handL = joint(this.foreL, [
      ball(0.52, DARK, 0, -0.42, 0.08, { sx: 0.95, sy: 1.15, sz: 0.8 }),
    ], this.matBody, -3.2);
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
        ball(0.85, SUIT, 0, 0, 0),                                  // hip joint
        capsule(0.82, 3.1, SUIT, 0, -2.15, 0),
        ring(0.9, 0.14, LEATHER, 0, -3.25, 0, { sz: 0.9 }),         // thigh strap
      ], this.matBody);
      const shin = joint(thigh, [
        ball(0.7, DARK, 0, 0, 0),                                   // knee
        capsule(0.62, 2.9, DARK, 0, -2.0, 0),
        ball(0.72, ACC, 0, -0.2, 0.5, { sx: 1.1, sy: 0.9, sz: 0.6 }), // knee pad
        capsule(0.78, 1.0, LEATHER, 0, -3.5, 0.1, { sz: 1.05 }),    // boot upper
        capsule(0.55, 1.9, TRIM, 0, -4.25, 0.45, { rx: Math.PI / 2, sy: 0.55 }), // sole
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
        // Soft-edged fabric: a flattened capsule reads as cloth, a box does not.
        const mesh = new THREE.Mesh(merge([
          capsule(0.85 - i * 0.11, 1.9, CLOTH, 0, 0, -1.05, { rx: Math.PI / 2, sz: 0.30 }),
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
          capsule(1.05 - i * 0.16, 2.3, CLOTH, 0, -1.4, 0, { sz: 0.24 }),
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
    const pkState = st.parkour ? st.parkour.state : PSTATE.NONE;
    const wWallrun = pkState === PSTATE.WALLRUN ? 1 : 0;
    const wWallclimb = pkState === PSTATE.WALLCLIMB ? 1 : 0;
    const wSlide = pkState === PSTATE.SLIDE ? 1 : 0;
    const wGrapple = hooked && !wWallrun && !wWallclimb ? 1 : 0;
    // Parkour states take the body; everything else shares what is left.
    const taken = clamp01(wWallrun + wWallclimb + wSlide + wGrapple);
    const rest = 1 - taken;
    const airPart = air * rest;

    const W = {
      idle: this.groundW * wIdle * rest,
      walk: this.groundW * wWalk * rest,
      sprint: this.groundW * wSprint * rest,
      blitz: this.groundW * wBlitz * rest,
      rise: airPart * (rising ? 1 : 0),
      fall: airPart * (rising ? 0 : 1),
      grapple: wGrapple,
      wallrun: wWallrun,
      wallclimb: wWallclimb,
      slide: wSlide,
    };
    this.slideW = damp(this.slideW, wSlide, 13, dt);
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

    // Wall roll: on a wall the whole body rotates so the feet meet the surface,
    // which is the difference between running a wall and standing on one. It is
    // damped like everything else, so entering and leaving a wall is a sweep.
    const wallSide = st.parkour ? st.parkour.side : 0;
    const rollTarget = pkState === PSTATE.WALLRUN ? -wallSide * 1.02 : 0;
    this.wallRoll = damp(this.wallRoll, rollTarget, 9, dt);

    this.kickPulse = Math.max(0, this.kickPulse - dt * 3.2);

    this.body.rotation.x = P.lean - this.kickPulse * 0.5;
    this.body.rotation.z = this.turnLean + this.wallRoll;
    this.body.position.y = -P.lean * 2.0 - P.crouch * 2.4;

    // Landing squash: critically damped, so the body absorbs and returns once
    // rather than wobbling back up through the pose.
    {
      const K = 190, C = 2 * Math.sqrt(190);
      this.landVel += (-this.landSquash * K - this.landVel * C) * dt;
      this.landSquash += this.landVel * dt;
      if (Math.abs(this.landSquash) < 0.001 && Math.abs(this.landVel) < 0.01) { this.landSquash = 0; this.landVel = 0; }
    }

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
    let tL = lerp(airLegL, groundLegL, gw) - P.crouch * 0.6;
    let tR = lerp(airLegR, groundLegR, gw) - P.crouch * 0.6;
    let kL = lerp(airKneeL, kneeL, gw) - P.crouch * 0.5;
    let kR = lerp(airKneeR, kneeR, gw) - P.crouch * 0.5;

    // Slide: one leg thrown forward, the other folded under. Blended in, so the
    // drop into a slide is a fold rather than a snap.
    if (this.slideW > 0.002) {
      const s = this.slideW;
      tL = lerp(tL, 0.95, s);   kL = lerp(kL, -0.25, s);
      tR = lerp(tR, -0.35, s);  kR = lerp(kR, -2.0, s);
    }

    this.thighL.rotation.x = tL;
    this.thighR.rotation.x = tR;
    this.shinL.rotation.x = kL;
    this.shinR.rotation.x = kR;
    this.thighL.rotation.z = P.splay * 0.35;
    this.thighR.rotation.z = -P.splay * 0.35 - this.slideW * 0.25;

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

  /** Called on landing. A normal jump barely registers; a real drop absorbs. */
  land(power) {
    const t = clamp01((power - 180) / 620);
    if (t <= 0) return;
    this.landVel -= 0.5 + t * t * 3.6;
  }

  /** Called on a wall kick: a short whole-body recoil away from the surface. */
  wallKick() { this.kickPulse = 1; this.landVel -= 1.2; }

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

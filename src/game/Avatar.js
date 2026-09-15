/**
 * [MACH] — the runner.
 *
 * A hand-built rig: no skinning, no imported assets, every joint animated in
 * code. That keeps the silhouette legible at 500 units/second, which is the
 * only thing that matters — you read an opponent by their pose and their trail,
 * because you have about 90 milliseconds to decide.
 *
 * Pose blends by speed: upright walk -> forward-leaning sprint -> a near-flat
 * dive at terminal velocity. Swings rotate a chest pivot, so the whole body
 * carries the cut.
 */

import * as THREE from '../../lib/three.module.js';
import { CFG, speedT } from '../core/Config.js';
import { clamp, clamp01, lerp, damp, angleDelta } from '../core/Util.js';
import { WSTATE, ATTACK } from '../shared/Combat.js';
import { buildKatana } from '../economy/Cosmetics.js';
import { gradient } from '../world/Materials.js';

const box = (w, h, d) => new THREE.BoxGeometry(w, h, d);

/** Limb helper: a pivot at the joint with geometry hanging below it. */
function limb(parent, geo, mat, len, offsetY = 0) {
  const pivot = new THREE.Object3D();
  pivot.position.y = offsetY;
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.y = -len / 2;
  mesh.castShadow = true;
  pivot.add(mesh);
  parent.add(pivot);
  return pivot;
}

export class Avatar {
  constructor(skinDef, katanaDef, sheathDef, opts = {}) {
    this.skin = skinDef;
    this.root = new THREE.Group();
    this.isLocal = !!opts.local;
    this.phase = Math.random() * 10;
    this.lean = 0;
    this.swing = 0;
    this.swingTarget = 0;
    this.blink = 0;
    this.prevCombat = WSTATE.SHEATHED;
    this.scarfA = new THREE.Vector3();
    this.scarfB = new THREE.Vector3();
    this.hurt = 0;

    this._materials(skinDef.spec);
    this._build(skinDef.spec);
    this.setKatana(katanaDef, sheathDef);
    if (skinDef.spec.ghost) this._buildGhosts();
  }

  /* --------------------------------------------------------- materials */

  _materials(s) {
    const g = gradient();
    const mk = (color, extra = {}) => new THREE.MeshToonMaterial({
      color, gradientMap: g,
      transparent: !!s.translucent || !!extra.transparent,
      opacity: s.translucent ?? extra.opacity ?? 1,
      ...extra,
    });
    this.matSuit = mk(s.suit);
    this.matAccent = mk(s.accent);
    this.matTrim = mk(s.trim);
    this.matCloth = mk(s.cloth);
    this.matVisor = new THREE.MeshBasicMaterial({ color: s.visor, toneMapped: false });
    this.matVent = new THREE.MeshBasicMaterial({ color: s.trim, toneMapped: false, transparent: true, opacity: 0 });
  }

  /* ------------------------------------------------------------- build */

  _build(s) {
    const R = this.root;

    // Hips -------------------------------------------------------------
    this.body = new THREE.Object3D();
    R.add(this.body);

    this.hips = new THREE.Object3D();
    this.hips.position.y = 8.6;
    this.body.add(this.hips);
    const pelvis = new THREE.Mesh(box(5.4, 3.0, 3.2), this.matSuit);
    pelvis.castShadow = true;
    this.hips.add(pelvis);
    const belt = new THREE.Mesh(box(5.7, 0.8, 3.5), this.matTrim);
    belt.position.y = 1.3;
    this.hips.add(belt);

    // Torso ------------------------------------------------------------
    this.chest = new THREE.Object3D();
    this.chest.position.y = 1.5;
    this.hips.add(this.chest);
    const torso = new THREE.Mesh(box(6.0, 5.2, 3.5), this.matSuit);
    torso.position.y = 2.6;
    torso.castShadow = true;
    this.chest.add(torso);
    const plate = new THREE.Mesh(box(4.4, 2.6, 0.5), this.matAccent);
    plate.position.set(0, 3.4, 1.85);
    this.chest.add(plate);
    if (s.hivis) {
      for (const y of [1.6, 2.4]) {
        const band = new THREE.Mesh(box(6.2, 0.55, 3.7), this.matTrim);
        band.position.y = y;
        this.chest.add(band);
      }
    }
    if (s.livery) {
      const stripe = new THREE.Mesh(box(1.1, 5.3, 3.6), this.matAccent);
      stripe.position.set(-1.4, 2.6, 0);
      this.chest.add(stripe);
      const stripe2 = stripe.clone();
      stripe2.position.x = 1.4;
      this.chest.add(stripe2);
    }
    if (s.vents) {
      this.vents = [];
      for (let i = 0; i < 3; i++) {
        const v = new THREE.Mesh(box(0.9, 1.9, 0.4), this.matVent);
        v.position.set(-2.1 + i * 2.1, 2.2, -1.9);
        this.chest.add(v);
        this.vents.push(v);
      }
    }

    // Head -------------------------------------------------------------
    this.neck = new THREE.Object3D();
    this.neck.position.y = 5.6;
    this.chest.add(this.neck);
    const head = new THREE.Mesh(box(3.0, 3.0, 3.0), this.matSuit);
    head.position.y = 1.5;
    head.castShadow = true;
    this.neck.add(head);
    const visor = new THREE.Mesh(box(2.6, 0.95, 0.45), this.matVisor);
    visor.position.set(0, 1.6, 1.55);
    this.neck.add(visor);
    const crest = new THREE.Mesh(box(0.7, 0.8, 3.1), this.matTrim);
    crest.position.y = 3.1;
    this.neck.add(crest);
    if (s.lantern) {
      const lamp = new THREE.Mesh(
        new THREE.CylinderGeometry(1.8, 1.8, 3.4, 10),
        new THREE.MeshBasicMaterial({ color: s.visor, transparent: true, opacity: 0.85 }),
      );
      lamp.position.y = 1.6;
      this.neck.add(lamp);
      head.visible = false;
      this.lantern = lamp;
    }

    // Arms -------------------------------------------------------------
    const armGeo = box(1.5, 3.6, 1.5), foreGeo = box(1.3, 3.4, 1.3);
    this.shoulderL = new THREE.Object3D();
    this.shoulderL.position.set(-3.3, 4.7, 0);
    this.chest.add(this.shoulderL);
    this.armL = limb(this.shoulderL, armGeo, this.matSuit, 3.6);
    this.foreL = limb(this.armL, foreGeo, this.matAccent, 3.4, -3.6);

    // The weapon side hangs off a chest pivot so the body drives the cut.
    this.swingPivot = new THREE.Object3D();
    this.swingPivot.position.set(0, 4.7, 0);
    this.chest.add(this.swingPivot);
    this.shoulderR = new THREE.Object3D();
    this.shoulderR.position.set(3.3, 0, 0);
    this.swingPivot.add(this.shoulderR);
    this.armR = limb(this.shoulderR, armGeo, this.matSuit, 3.6);
    this.foreR = limb(this.armR, foreGeo, this.matAccent, 3.4, -3.6);
    this.hand = new THREE.Object3D();
    this.hand.position.y = -3.4;
    this.foreR.add(this.hand);

    for (const pad of [[-3.5, 4.9], [3.5, 4.9]]) {
      const p = new THREE.Mesh(box(2.2, 1.4, 3.0), this.matTrim);
      p.position.set(pad[0], pad[1], 0);
      p.castShadow = true;
      this.chest.add(p);
    }

    // Legs -------------------------------------------------------------
    const thighGeo = box(1.9, 4.5, 1.9), shinGeo = box(1.7, 4.2, 1.7);
    this.hipL = new THREE.Object3D(); this.hipL.position.set(-1.5, -1.4, 0); this.hips.add(this.hipL);
    this.thighL = limb(this.hipL, thighGeo, this.matSuit, 4.5);
    this.shinL = limb(this.thighL, shinGeo, this.matTrim, 4.2, -4.5);
    this.hipR = new THREE.Object3D(); this.hipR.position.set(1.5, -1.4, 0); this.hips.add(this.hipR);
    this.thighR = limb(this.hipR, thighGeo, this.matSuit, 4.5);
    this.shinR = limb(this.thighR, shinGeo, this.matTrim, 4.2, -4.5);
    for (const [shin, sign] of [[this.shinL, -1], [this.shinR, 1]]) {
      const foot = new THREE.Mesh(box(1.9, 0.9, 3.2), this.matTrim);
      foot.position.set(0, -4.1, 0.6);
      shin.add(foot);
    }

    // Cloth ------------------------------------------------------------
    this.cloth = [];
    if (s.coat) {
      let parent = this.chest;
      for (let i = 0; i < 3; i++) {
        const seg = new THREE.Object3D();
        seg.position.y = i === 0 ? 1.0 : -3.2;
        const m = new THREE.Mesh(box(6.2 - i * 0.6, 3.4, 0.5), this.matCloth);
        m.position.set(0, -1.7, -2.0 + i * 0.1);
        m.castShadow = true;
        seg.add(m);
        parent.add(seg);
        parent = seg;
        this.cloth.push(seg);
      }
    } else {
      // Scarf — the cheapest, best speed cue in the game.
      let parent = this.neck;
      for (let i = 0; i < 4; i++) {
        const seg = new THREE.Object3D();
        seg.position.set(0, i === 0 ? 0.6 : 0, i === 0 ? -1.2 : -2.6);
        const m = new THREE.Mesh(box(2.0 - i * 0.28, 0.45, 2.8), this.matCloth);
        m.position.z = -1.4;
        seg.add(m);
        parent.add(seg);
        parent = seg;
        this.cloth.push(seg);
      }
    }

    // Saya on the left hip, worn edge-up and raked back along the body the way
    // a katana actually sits — not standing upright out of the belt.
    this.sheathNode = new THREE.Object3D();
    this.sheathNode.position.set(-2.8, 0.2, -0.6);
    this.sheathNode.rotation.set(-1.32, 0.22, 0.30);
    this.hips.add(this.sheathNode);
  }

  _buildGhosts() {
    this.ghostHistory = [];
    this.ghosts = [];
    const mat = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending,
    });
    for (let i = 0; i < 3; i++) {
      const clone = this.body.clone(true);
      clone.traverse((o) => { if (o.isMesh) o.material = mat; o.castShadow = false; });
      const holder = new THREE.Group();
      holder.add(clone);
      this.ghosts.push({ holder, nodes: collectNodes(clone), delay: 0.07 + i * 0.07 });
      this.root.parent?.add(holder);
      this._ghostParentPending = true;
    }
    this.selfNodes = collectNodes(this.body);
  }

  /* ------------------------------------------------------------ katana */

  setKatana(katanaDef, sheathDef) {
    if (this.katana) {
      this.katana.group.parent?.remove(this.katana.group);
      this.katana.group.traverse((o) => { if (o.isMesh) { o.geometry.dispose?.(); } });
    }
    this.katanaDef = katanaDef;
    this.katana = buildKatana(katanaDef);
    this.katana.group.scale.setScalar(1.0);
    this.hand.add(this.katana.group);
    this.katana.group.position.set(0, 0, 0);
    this.katanaHeld = true;

    // Saya.
    if (this.sheathMesh) this.sheathNode.remove(this.sheathMesh);
    const sp = sheathDef?.spec ?? { color: 0x101014, trim: 0x3d434f };
    const len = (katanaDef.spec.blade.len ?? 11) + 1.6;
    const saya = new THREE.Group();
    const body = new THREE.Mesh(
      new THREE.CylinderGeometry(0.62, 0.52, len, 8),
      new THREE.MeshStandardMaterial({ color: sp.color, metalness: sp.metal ?? 0.3, roughness: sp.metal ? 0.1 : 0.55 }),
    );
    body.position.y = len / 2;
    body.castShadow = true;
    saya.add(body);
    for (let i = 0; i < 3; i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.64, 0.1, 5, 10),
        new THREE.MeshStandardMaterial({ color: sp.trim, metalness: 0.8, roughness: 0.3, emissive: sp.glow ? sp.trim : 0x000000 }));
      ring.rotation.x = Math.PI / 2;
      ring.position.y = 1.2 + i * (len - 3) / 2;
      saya.add(ring);
    }
    this.sheathMesh = saya;
    this.sheathNode.add(saya);
    this.sheathLen = len;
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
      this.hand.add(g);
      g.position.set(0, 0, 0);
      g.rotation.set(0, 0, 0);
    }
  }

  /** World-space blade tip and base, for trails and slash VFX. */
  bladePoints(tip, base) {
    this.katana.group.updateWorldMatrix(true, false);
    tip.copy(this.katana.tipLocal).applyMatrix4(this.katana.group.matrixWorld);
    base.copy(this.katana.baseLocal).applyMatrix4(this.katana.group.matrixWorld);
  }

  /* ------------------------------------------------------------ update */

  /**
   * @param {number} dt
   * @param {object} st {speed, grounded, yaw, pitch, combatState, phase,
   *                     swingIndex, attackType, alive, vulnerable, moving}
   */
  update(dt, st) {
    const t = speedT(st.speed);
    const sprinting = st.speed > 130;

    /* ---- gait ---- */
    const freq = Math.min(5.6, 1.15 + st.speed * 0.021);
    if (st.grounded && st.speed > 6) this.phase += dt * freq * Math.PI * 2;
    else if (!st.grounded) this.phase += dt * 3;
    const ph = this.phase;
    const amp = clamp(0.25 + t * 1.35, 0.25, 1.35) * (st.grounded ? 1 : 0.35);

    const targetLean = st.grounded ? lerp(0.02, 0.62, Math.pow(t, 0.85)) : 0.18;
    this.lean = damp(this.lean, targetLean, 9, dt);
    this.body.rotation.x = this.lean;
    this.body.position.y = -this.lean * 2.2;

    // Vertical bob + roll, scaled so it never becomes nausea at speed.
    const bob = Math.sin(ph * 2) * (0.30 + t * 0.5) * (st.grounded ? 1 : 0);
    this.hips.position.y = 8.6 + bob;
    this.hips.rotation.z = Math.sin(ph) * 0.06 * (1 - t * 0.5);
    this.hips.rotation.y = Math.sin(ph) * 0.20 * (1 - t * 0.35);
    this.chest.rotation.y = -this.hips.rotation.y * 0.8;

    if (st.grounded) {
      this.thighL.rotation.x = Math.sin(ph) * amp;
      this.thighR.rotation.x = Math.sin(ph + Math.PI) * amp;
      this.shinL.rotation.x = clamp(-Math.sin(ph - 0.8) * amp * 1.3, -2.0, 0.1);
      this.shinR.rotation.x = clamp(-Math.sin(ph + Math.PI - 0.8) * amp * 1.3, -2.0, 0.1);
    } else {
      this.thighL.rotation.x = damp(this.thighL.rotation.x, -0.9, 8, dt);
      this.thighR.rotation.x = damp(this.thighR.rotation.x, 0.35, 8, dt);
      this.shinL.rotation.x = damp(this.shinL.rotation.x, -1.3, 8, dt);
      this.shinR.rotation.x = damp(this.shinR.rotation.x, -0.5, 8, dt);
    }

    // Left arm: pumping at a walk, swept back into the slipstream at speed.
    const sweep = clamp01((t - 0.35) / 0.5);
    const pump = Math.sin(ph + Math.PI) * amp * 0.9;
    this.armL.rotation.x = lerp(pump, -2.25, sweep);
    this.armL.rotation.z = lerp(0.08, 0.5, sweep);
    this.foreL.rotation.x = lerp(-0.5 - Math.max(0, pump) * 0.5, -0.35, sweep);

    /* ---- weapon ---- */
    const cs = st.combatState;
    const attacking = cs === WSTATE.WINDUP || cs === WSTATE.ACTIVE;
    const recovering = cs === WSTATE.RECOVER;
    this.setWeaponSheathed(cs === WSTATE.SHEATHED || (cs === WSTATE.SHEATHING && st.phase > 0.6));

    // swing runs -1 (wound up) -> +1 (followed through), mirrored per index.
    const dir = st.swingIndex === 1 ? -1 : 1;
    let target = 0;
    if (cs === WSTATE.WINDUP) target = -1;
    else if (cs === WSTATE.ACTIVE) target = lerp(-0.4, 1, st.phase);
    else if (recovering) target = lerp(1, 0.15, clamp01(st.phase * 1.4));
    const rate = cs === WSTATE.ACTIVE ? 42 : cs === WSTATE.WINDUP ? 16 : 9;
    this.swing = damp(this.swing, target, rate, dt);

    const sw = this.swing * dir;
    const rising = st.swingIndex === 2;
    const iai = st.attackType === ATTACK.IAI;

    this.swingPivot.rotation.y = -sw * 1.75;
    this.swingPivot.rotation.z = rising ? sw * 0.55 - 0.3 : sw * 0.28;
    this.swingPivot.rotation.x = rising ? -0.7 - sw * 0.5 : (attacking || recovering ? -0.25 : 0);
    this.chest.rotation.y += -sw * 0.42;
    this.hips.rotation.y += -sw * 0.14;

    if (attacking || recovering) {
      this.armR.rotation.x = lerp(-1.25, -0.35, clamp01(this.swing * 0.5 + 0.5));
      this.armR.rotation.z = iai ? -0.55 : -0.25;
      this.foreR.rotation.x = lerp(-1.45, -0.28, clamp01(this.swing * 0.5 + 0.5));
      this.hand.rotation.z = rising ? -0.5 : 0.25;
      this.hand.rotation.x = iai ? -0.4 : -0.15;
    } else if (this.katanaHeld) {
      // Guard stance: blade held low and across, tightening as you speed up.
      this.armR.rotation.x = damp(this.armR.rotation.x, lerp(-0.35, -0.9, t) + Math.sin(ph) * amp * 0.25, 8, dt);
      this.armR.rotation.z = damp(this.armR.rotation.z, -0.22, 8, dt);
      this.foreR.rotation.x = damp(this.foreR.rotation.x, -0.85 - t * 0.35, 8, dt);
      this.hand.rotation.set(0.1, 0, 0.55);
    } else {
      // Sheathed: hand rests at the saya, ready for the iai.
      const reach = cs === WSTATE.WINDUP ? 1 : 0;
      this.armR.rotation.x = damp(this.armR.rotation.x, lerp(pump * 0.8, -0.9, Math.max(sweep, reach)), 9, dt);
      this.armR.rotation.z = damp(this.armR.rotation.z, lerp(-0.1, -0.75, reach), 9, dt);
      this.foreR.rotation.x = damp(this.foreR.rotation.x, lerp(-0.4, -1.6, reach), 9, dt);
      this.hand.rotation.set(0, 0, 0);
    }

    this.neck.rotation.x = clamp(-this.lean * 0.85 + (st.pitch || 0) * 0.35, -0.8, 0.6);

    /* ---- cloth ---- */
    const flap = Math.sin(this.phase * 1.6) * 0.12 * (0.3 + t);
    for (let i = 0; i < this.cloth.length; i++) {
      const seg = this.cloth[i];
      const lag = lerp(0.35, 1.25, t) + i * 0.12;
      seg.rotation.x = damp(seg.rotation.x, lag + flap * (i + 1) - this.lean * 0.5, 10 - i * 1.5, dt);
      seg.rotation.y = damp(seg.rotation.y, Math.sin(this.phase * 1.1 + i) * 0.18 * (0.4 + t), 8, dt);
    }

    /* ---- skin specials ---- */
    if (this.vents) {
      const heat = Math.pow(t, 1.5);
      for (const v of this.vents) { v.material.opacity = heat * 0.95; v.scale.y = 0.6 + heat; }
      this.matVent.color.setHex(this.skin.spec.trim);
    }
    if (this.lantern) {
      this.lantern.material.opacity = 0.65 + Math.sin(performance.now() * 0.004) * 0.12 + t * 0.2;
    }
    if (this.katana?.extras) {
      const now = performance.now() * 0.001;
      for (const e of this.katana.extras) {
        if (e.type === 'speedGlow') e.mesh.material.opacity = 0.35 + t * 0.65;
        else if (e.type === 'pulse') e.mesh.material.opacity = 0.16 + Math.sin(now * e.rate * 6.28) * 0.1 + t * 0.2;
        else if (e.type === 'flicker') e.mesh.material.opacity = 0.12 + Math.random() * 0.14 + t * 0.25;
        else if (e.type === 'spin') e.mesh.rotation.z += dt * e.rate;
        else if (e.type === 'tick') e.mesh.rotation.y = -Math.floor(now * 1) * (Math.PI / 30);
      }
    }

    /* ---- hit flash ---- */
    this.hurt = Math.max(0, this.hurt - dt * 4);
    if (this.hurt > 0) {
      const f = this.hurt;
      this.matSuit.emissive?.setRGB(f, f * 0.15, f * 0.1);
    } else if (this.matSuit.emissive) this.matSuit.emissive.setRGB(0, 0, 0);

    if (this.ghosts) this._updateGhosts(dt);
  }

  _updateGhosts(dt) {
    if (this._ghostParentPending && this.root.parent) {
      for (const g of this.ghosts) this.root.parent.add(g.holder);
      this._ghostParentPending = false;
    }
    const now = performance.now() * 0.001;
    this.ghostHistory.push({
      t: now,
      p: this.root.position.clone(),
      r: this.root.rotation.y,
    });
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

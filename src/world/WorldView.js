/**
 * [MACH] — turns the shared world data into a scene.
 *
 * Every collider you can stand on is drawn from the same numbers the physics
 * uses, so there is never a "phantom ledge". Buildings are instanced per
 * material, terrain is one flat-shaded mesh, props are merged per type.
 * Total draw calls for the whole city: about thirty.
 */

import * as THREE from '../../lib/three.module.js';
import { SHAPE, SURF, HALF, terrainHeight } from '../shared/WorldData.js';
import { mulberry32 } from '../core/Util.js';
import {
  PALETTE, toon, facadeMaterial, terrainMaterial,
  hazardTexture, billboardTexture, bannerTexture,
} from './Materials.js';

/* ------------------------------------------------------------- geometry */

function rampGeometry() {
  // Unit wedge: footprint [-0.5,0.5]^2, bottom flat at y=0, top slopes 0 -> 1
  // from -X to +X. Instances scale it into place.
  const v = [];
  const push = (...pts) => { for (const p of pts) v.push(p[0], p[1], p[2]); };
  const a = [-0.5, 0, -0.5], b = [0.5, 0, -0.5], c = [0.5, 0, 0.5], d = [-0.5, 0, 0.5];
  const B = [0.5, 1, -0.5], C = [0.5, 1, 0.5];
  push(a, c, b); push(a, d, c);           // bottom
  push(a, b, B); push(a, B, d);           // sloped top (a-d is the knife edge)
  push(d, B, C);
  push(b, c, C); push(b, C, B);           // vertical back face at +X
  push(a, B, b); // filler for the -Z side
  push(d, C, c);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(v, 3));
  g.computeVertexNormals();
  return g;
}

function mergeParts(parts) {
  const pos = [], nrm = [], col = [];
  const m3 = new THREE.Matrix3();
  for (const part of parts) {
    const g = part.g.index ? part.g.toNonIndexed() : part.g.clone();
    g.applyMatrix4(part.m);
    if (!g.attributes.normal) g.computeVertexNormals();
    const p = g.attributes.position.array, n = g.attributes.normal.array;
    const c = new THREE.Color(part.c ?? 0xffffff);
    for (let i = 0; i < p.length; i += 3) {
      pos.push(p[i], p[i + 1], p[i + 2]);
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

const T = (x, y, z, sx = 1, sy = 1, sz = 1, ry = 0) =>
  new THREE.Matrix4().compose(
    new THREE.Vector3(x, y, z),
    new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)),
    new THREE.Vector3(sx, sy, sz),
  );

/* ----------------------------------------------------------- kind table */

const KIND = {
  tower: { mat: 'facadeDark', vary: 0.14 },
  lowrise: { mat: 'facadeLight', vary: 0.12 },
  warehouse: { mat: 'ribbed', vary: 0.08 },
  roofridge: { mat: 'steel' },
  container: { mat: 'painted', vary: 1 },
  silo: { mat: 'pale' },
  pillar: { mat: 'concrete' },
  deck: { mat: 'concrete' },
  bridge: { mat: 'concrete' },
  rail: { mat: 'ink' },
  ramp: { mat: 'steel' },
  ledge: { mat: 'steel' },
  tunnelwall: { mat: 'slate' },
  tunnelroof: { mat: 'ink' },
  terrace: { mat: 'concrete' },
  citadel: { mat: 'slate' },
  antenna: { mat: 'red' },
  // The monument is 260 units of wall right at the crossroads. In near-black it
  // read as a hole in the screen, so it gets real stone with a yellow needle.
  monument: { mat: 'monumentMat', vary: 0.10 },
  needle: { mat: 'yellowMat' },
  planter: { mat: 'slate' },
};

const CONTAINER_COLORS = [0xf2c511, 0x22c6e8, 0xe23a2e, 0xd7dae0, 0x7a4a2e, 0x3c7a52];

export class WorldView {
  constructor(scene, world) {
    this.scene = scene;
    this.world = world;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.materials = this._materials();
    this._buildTerrain();
    this._buildSolids();
    this._buildProps();
  }

  _materials() {
    return {
      facadeDark: facadeMaterial(0x39404c, { floorHeight: 27, barWidth: 18 }),
      facadeLight: facadeMaterial(0x4a5160, { floorHeight: 23, barWidth: 15, glass: 0x1b2230 }),
      monumentMat: toon(0x474d58),
      ribbed: facadeMaterial(PALETTE.steel, { floorHeight: 58, barWidth: 9, glass: 0x363c47, lit: 0x363c47 }),
      steel: toon(PALETTE.steel),
      painted: toon(0xffffff),
      pale: toon(PALETTE.pale),
      concrete: toon(PALETTE.concrete),
      ink: toon(PALETTE.ink),
      slate: toon(PALETTE.slate),
      red: toon(PALETTE.red),
      yellowMat: toon(PALETTE.yellow),
    };
  }

  /* ------------------------------------------------------------ terrain */

  _buildTerrain() {
    const t = this.world.terrain;
    const n = t.n, step = t.step;
    const pos = [], col = [];
    const rng = mulberry32(99);
    const cc = new THREE.Color();

    const kindColor = (k) => {
      switch (k) {
        case SURF.ASPHALT: return PALETTE.asphalt;
        case SURF.PLAZA: return 0x4a4f59;
        case SURF.CONCRETE: return 0x565c66;
        case SURF.DIRT: return PALETTE.dirt;
        case SURF.GRASS: return PALETTE.grass;
        case SURF.CUT: return 0x3a3f49;
        default: return PALETTE.concrete;
      }
    };

    for (let j = 0; j < t.cells; j++) {
      for (let i = 0; i < t.cells; i++) {
        const x0 = -HALF + i * step, z0 = -HALF + j * step;
        const x1 = x0 + step, z1 = z0 + step;
        const h00 = t.heights[j * n + i], h10 = t.heights[j * n + i + 1];
        const h01 = t.heights[(j + 1) * n + i], h11 = t.heights[(j + 1) * n + i + 1];
        pos.push(x0, h00, z0, x0, h01, z1, x1, h10, z0);
        pos.push(x1, h10, z0, x0, h01, z1, x1, h11, z1);

        const base = kindColor(t.kinds[j * t.cells + i]);
        const jitter = 0.88 + rng() * 0.24;
        cc.setHex(base).multiplyScalar(jitter);
        for (let v = 0; v < 6; v++) col.push(cc.r, cc.g, cc.b);
      }
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    g.computeVertexNormals();
    const mesh = new THREE.Mesh(g, terrainMaterial());
    mesh.receiveShadow = true;
    mesh.name = 'terrain';
    this.group.add(mesh);
    this.terrainMesh = mesh;
  }

  /* ------------------------------------------------------------- solids */

  _buildSolids() {
    const byMat = new Map();   // matKey -> {box:[], ramp:[], cyl:[]}
    const rng = mulberry32(4242);
    const skirts = [];

    for (const o of this.world.solids) {
      if (o.k === 'bounds') continue;
      const def = KIND[o.k] || { mat: 'concrete' };
      let entry = byMat.get(def.mat);
      if (!entry) byMat.set(def.mat, (entry = { box: [], ramp: [], cyl: [], def }));

      if (o.t === SHAPE.BOX) {
        entry.box.push(o);
      } else if (o.t === SHAPE.CYL) {
        entry.cyl.push(o);
      } else {
        entry.ramp.push(o);
        // Fill underneath so a raised ramp is not a floating wedge.
        const cx = (o.x0 + o.x1) / 2, cz = (o.z0 + o.z1) / 2;
        const ground = terrainHeight(this.world, cx, cz);
        const low = Math.min(o.y0, o.y1);
        if (low - ground > 5) {
          skirts.push({ x0: o.x0, x1: o.x1, z0: o.z0, z1: o.z1, y0: ground - 4, y1: low + 1, mat: def.mat });
        }
      }
    }
    for (const s of skirts) byMat.get(s.mat).box.push({ ...s, t: SHAPE.BOX, k: 'skirt' });

    const boxGeo = new THREE.BoxGeometry(1, 1, 1);
    const rampGeo = rampGeometry();
    const cylGeo = new THREE.CylinderGeometry(1, 1, 1, 14, 1);
    const mtx = new THREE.Matrix4();
    const col = new THREE.Color();

    for (const [matKey, e] of byMat) {
      const material = this.materials[matKey];
      const vary = e.def.vary || 0;

      if (e.box.length) {
        const im = new THREE.InstancedMesh(boxGeo, material, e.box.length);
        im.castShadow = true; im.receiveShadow = true;
        e.box.forEach((o, i) => {
          mtx.makeScale(o.x1 - o.x0, o.y1 - o.y0, o.z1 - o.z0);
          mtx.setPosition((o.x0 + o.x1) / 2, (o.y0 + o.y1) / 2, (o.z0 + o.z1) / 2);
          im.setMatrixAt(i, mtx);
          if (vary === 1) col.setHex(CONTAINER_COLORS[(rng() * CONTAINER_COLORS.length) | 0]);
          else col.setScalar(1).multiplyScalar(1 - vary / 2 + rng() * vary);
          im.setColorAt(i, col);
        });
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        this.group.add(im);
      }

      if (e.ramp.length) {
        const im = new THREE.InstancedMesh(rampGeo, material, e.ramp.length);
        im.castShadow = true; im.receiveShadow = true;
        e.ramp.forEach((o, i) => {
          const w = o.x1 - o.x0, d = o.z1 - o.z0;
          const rise = Math.abs(o.y1 - o.y0);
          let ry = 0, sx = w, sz = d;
          if (o.ax === 0) { ry = o.dir > 0 ? 0 : Math.PI; }
          else { ry = o.dir > 0 ? -Math.PI / 2 : Math.PI / 2; sx = d; sz = w; }
          mtx.compose(
            new THREE.Vector3((o.x0 + o.x1) / 2, Math.min(o.y0, o.y1), (o.z0 + o.z1) / 2),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, ry, 0)),
            new THREE.Vector3(sx, rise, sz),
          );
          im.setMatrixAt(i, mtx);
          col.setScalar(0.92 + rng() * 0.16);
          im.setColorAt(i, col);
        });
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        this.group.add(im);
      }

      if (e.cyl.length) {
        const im = new THREE.InstancedMesh(cylGeo, material, e.cyl.length);
        im.castShadow = true; im.receiveShadow = true;
        e.cyl.forEach((o, i) => {
          mtx.makeScale(o.r, o.y1 - o.y0, o.r);
          mtx.setPosition(o.cx, (o.y0 + o.y1) / 2, o.cz);
          im.setMatrixAt(i, mtx);
          col.setScalar(0.94 + rng() * 0.12);
          im.setColorAt(i, col);
        });
        im.instanceMatrix.needsUpdate = true;
        if (im.instanceColor) im.instanceColor.needsUpdate = true;
        this.group.add(im);
      }
    }
  }

  /* -------------------------------------------------------------- props */

  _buildProps() {
    const props = this.world.props;
    const groups = new Map();
    for (const p of props) {
      const key = p.type === 'billboard' || p.type === 'banner' ? `${p.type}${p.c}` : p.type;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }

    const vcMat = () => toon(0xffffff, { vertexColors: true });

    const protos = {
      lamp: () => mergeParts([
        { g: new THREE.CylinderGeometry(2.2, 3.2, 96, 8), m: T(0, 48, 0), c: PALETTE.ink },
        { g: new THREE.BoxGeometry(26, 3.5, 4), m: T(-12, 95, 0), c: PALETTE.ink },
        { g: new THREE.BoxGeometry(16, 4.5, 9), m: T(-24, 92, 0), c: PALETTE.yellow },
        { g: new THREE.BoxGeometry(9, 9, 9), m: T(0, 4, 0), c: PALETTE.slate },
      ]),
      tree: () => mergeParts([
        { g: new THREE.CylinderGeometry(2.4, 4.2, 44, 6), m: T(0, 22, 0), c: 0x3a2f26 },
        { g: new THREE.ConeGeometry(20, 44, 7), m: T(0, 60, 0), c: 0x33512f },
        { g: new THREE.ConeGeometry(15, 34, 7), m: T(0, 86, 0), c: 0x3e6138 },
      ]),
      acunit: () => mergeParts([
        { g: new THREE.BoxGeometry(26, 14, 20), m: T(0, 7, 0), c: PALETTE.pale },
        { g: new THREE.CylinderGeometry(7, 7, 4, 10), m: T(0, 15, 0), c: PALETTE.steel },
      ]),
      antenna: () => mergeParts([
        { g: new THREE.CylinderGeometry(1.4, 2.2, 70, 6), m: T(0, 35, 0), c: PALETTE.steel },
        { g: new THREE.BoxGeometry(18, 2, 2), m: T(0, 58, 0), c: PALETTE.steel },
        { g: new THREE.BoxGeometry(13, 2, 2), m: T(0, 48, 0), c: PALETTE.steel },
        { g: new THREE.SphereGeometry(2.6, 6, 5), m: T(0, 72, 0), c: PALETTE.red },
      ]),
    };

    for (const [key, list] of groups) {
      if (key === 'barrier') {
        const geo = new THREE.BoxGeometry(60, 15, 7);
        const mat = new THREE.MeshToonMaterial({ map: hazardTexture() });
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        im.castShadow = true;
        const m = new THREE.Matrix4();
        list.forEach((p, i) => {
          m.compose(new THREE.Vector3(p.x, p.y + 8, p.z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rot, 0)),
            new THREE.Vector3(1, 1, 1));
          im.setMatrixAt(i, m);
        });
        this.group.add(im);
        continue;
      }
      if (key.startsWith('billboard')) {
        const variant = +key.slice(9);
        const geo = new THREE.PlaneGeometry(120, 60);
        const mat = new THREE.MeshBasicMaterial({ map: billboardTexture(variant), side: THREE.DoubleSide });
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        const m = new THREE.Matrix4();
        list.forEach((p, i) => {
          m.compose(new THREE.Vector3(p.x, p.y, p.z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rot, 0)),
            new THREE.Vector3(p.s, p.s, 1));
          im.setMatrixAt(i, m);
        });
        this.group.add(im);
        continue;
      }
      if (key.startsWith('banner')) {
        const variant = +key.slice(6);
        const geo = new THREE.PlaneGeometry(34, 130);
        const mat = new THREE.MeshToonMaterial({ map: bannerTexture(variant), side: THREE.DoubleSide, gradientMap: this.materials.steel.gradientMap });
        const poleGeo = new THREE.CylinderGeometry(2.5, 2.5, 190, 8);
        const im = new THREE.InstancedMesh(geo, mat, list.length);
        const ip = new THREE.InstancedMesh(poleGeo, this.materials.ink, list.length);
        const m = new THREE.Matrix4();
        list.forEach((p, i) => {
          m.compose(new THREE.Vector3(p.x, p.y + 105, p.z),
            new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rot, 0)),
            new THREE.Vector3(1, 1, 1));
          im.setMatrixAt(i, m);
          m.compose(new THREE.Vector3(p.x, p.y + 95, p.z), new THREE.Quaternion(), new THREE.Vector3(1, 1, 1));
          ip.setMatrixAt(i, m);
        });
        ip.castShadow = true;
        this.group.add(im); this.group.add(ip);
        continue;
      }

      const proto = protos[key];
      if (!proto) continue;
      const geo = proto();
      const im = new THREE.InstancedMesh(geo, vcMat(), list.length);
      im.castShadow = true;
      im.receiveShadow = key === 'acunit';
      const m = new THREE.Matrix4();
      list.forEach((p, i) => {
        m.compose(new THREE.Vector3(p.x, p.y, p.z),
          new THREE.Quaternion().setFromEuler(new THREE.Euler(0, p.rot, 0)),
          new THREE.Vector3(p.s, p.s, p.s));
        im.setMatrixAt(i, m);
      });
      this.group.add(im);
    }
  }
}

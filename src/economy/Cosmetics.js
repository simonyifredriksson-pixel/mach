/**
 * [MACH] — cosmetics.
 *
 * Every item here is visual only. Nothing in this file touches speed, damage,
 * reach, arc or health — a MYTHIC katana and the starter katana hit for exactly
 * SPEED x 0.5.
 *
 * Katanas are generated geometry, not palette swaps: blade profile, curvature,
 * guard shape and silhouette all change. The ??? tier changes what the weapon
 * fundamentally *is*.
 */

import * as THREE from '../../lib/three.module.js';

/* ------------------------------------------------------------- geometry */

/**
 * Katana blade. Curved, tapered, with a real kissaki (tip) and a distinct
 * spine/edge cross-section so the silhouette reads from any angle.
 */
export function bladeGeometry({ len = 11, width = 0.62, thick = 0.19, curve = 0.9, taper = 0.30, segs = 12 } = {}) {
  const pos = [], nrm = [];
  const ring = (t) => {
    const y = t * len;
    const z0 = curve * Math.pow(t, 1.7);
    const w = width * (1 - taper * t);
    const th = thick * (1 - 0.45 * t);
    return [
      [0, y, z0 - w],          // edge (ha)
      [th, y, z0 + w * 0.30],  // side
      [0, y, z0 + w],          // spine (mune)
      [-th, y, z0 + w * 0.30], // side
    ];
  };
  const tri = (a, b, c) => {
    const ax = b[0] - a[0], ay = b[1] - a[1], az = b[2] - a[2];
    const bx = c[0] - a[0], by = c[1] - a[1], bz = c[2] - a[2];
    let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
    const l = Math.hypot(nx, ny, nz) || 1;
    nx /= l; ny /= l; nz /= l;
    pos.push(...a, ...b, ...c);
    for (let i = 0; i < 3; i++) nrm.push(nx, ny, nz);
  };

  let prev = ring(0);
  for (let i = 1; i <= segs; i++) {
    const t = i / segs;
    const cur = i === segs ? null : ring(t);
    if (cur) {
      for (let k = 0; k < 4; k++) {
        const n = (k + 1) % 4;
        tri(prev[k], prev[n], cur[n]);
        tri(prev[k], cur[n], cur[k]);
      }
      prev = cur;
    } else {
      // Kissaki: converge on a point slightly past the edge line.
      const tip = [0, len, curve * 1.0 - width * (1 - taper) * 0.2];
      for (let k = 0; k < 4; k++) tri(prev[k], prev[(k + 1) % 4], tip);
    }
  }
  // Base cap.
  const base = ring(0);
  tri(base[0], base[2], base[1]);
  tri(base[0], base[3], base[2]);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return g;
}

function tsubaMesh(shape, mat) {
  switch (shape) {
    case 'square': {
      const m = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.22, 1.7), mat);
      return m;
    }
    case 'cross': {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.BoxGeometry(2.3, 0.2, 0.55), mat));
      g.add(new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.2, 2.3), mat));
      return g;
    }
    case 'ring':
      return new THREE.Mesh(new THREE.TorusGeometry(0.85, 0.16, 6, 16), mat);
    case 'sun': {
      const g = new THREE.Group();
      g.add(new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.18, 18), mat));
      for (let i = 0; i < 12; i++) {
        const s = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.7, 4), mat);
        const a = (i / 12) * Math.PI * 2;
        s.position.set(Math.cos(a) * 1.2, 0, Math.sin(a) * 1.2);
        s.rotation.z = -Math.PI / 2;
        s.rotation.y = -a;
        g.add(s);
      }
      return g;
    }
    case 'none':
      return new THREE.Group();
    default:
      return new THREE.Mesh(new THREE.CylinderGeometry(0.95, 0.95, 0.2, 16), mat);
  }
}

/**
 * Build a katana. Origin is the butt of the handle; the blade runs up +Y.
 * Returns {group, tipLocal, emissiveMats} so the renderer can drive trails and
 * speed-reactive glow.
 */
export function buildKatana(def) {
  const spec = def.spec;
  const group = new THREE.Group();
  const emissive = [];

  const bladeMat = new THREE.MeshStandardMaterial({
    color: spec.blade.color,
    metalness: spec.blade.metal ?? 0.9,
    roughness: spec.blade.rough ?? 0.22,
    emissive: spec.blade.emissive ?? 0x000000,
    emissiveIntensity: spec.blade.emissivePower ?? 1,
    transparent: !!spec.blade.opacity,
    opacity: spec.blade.opacity ?? 1,
  });
  if (spec.blade.emissive) emissive.push(bladeMat);

  const fitMat = new THREE.MeshStandardMaterial({
    color: spec.fittings ?? 0x2a2c32, metalness: 0.75, roughness: 0.35,
    emissive: spec.fittingsEmissive ?? 0x000000,
  });
  if (spec.fittingsEmissive) emissive.push(fitMat);

  const wrapMat = new THREE.MeshStandardMaterial({
    color: spec.wrap ?? 0x14151a, metalness: 0.1, roughness: 0.85,
  });

  const handleLen = spec.handleLen ?? 4.0;

  // Tsuka (handle) + ito wrap diamonds.
  const tsuka = new THREE.Mesh(new THREE.CylinderGeometry(0.33, 0.38, handleLen, 8), wrapMat);
  tsuka.position.y = handleLen / 2;
  group.add(tsuka);
  if (spec.wrapDiamonds !== false) {
    for (let i = 0; i < 6; i++) {
      const d = new THREE.Mesh(new THREE.BoxGeometry(0.72, 0.38, 0.72), fitMat);
      d.position.y = 0.55 + i * (handleLen - 1.1) / 5;
      d.rotation.y = Math.PI / 4;
      d.scale.z = 0.5;
      group.add(d);
    }
  }
  const kashira = new THREE.Mesh(new THREE.CylinderGeometry(0.42, 0.34, 0.45, 8), fitMat);
  group.add(kashira);

  // Tsuba (guard).
  const tsuba = tsubaMesh(spec.tsuba ?? 'disc', fitMat);
  tsuba.position.y = handleLen + 0.15;
  if (spec.tsuba === 'ring') tsuba.rotation.x = Math.PI / 2;
  group.add(tsuba);

  // Habaki collar.
  const habaki = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.44, 0.7, 8), fitMat);
  habaki.position.y = handleLen + 0.5;
  group.add(habaki);

  // Blade.
  const bladeLen = spec.blade.len ?? 11;
  let blade = null;
  if (!spec.blade.invisible) {
    blade = new THREE.Mesh(bladeGeometry(spec.blade), bladeMat);
    blade.position.y = handleLen + 0.7;
    blade.castShadow = true;
    group.add(blade);

    // Hamon: a thin bright line along the edge.
    if (spec.blade.hamon !== false) {
      const hm = new THREE.Mesh(
        bladeGeometry({ ...spec.blade, width: (spec.blade.width ?? 0.62) * 0.42, thick: (spec.blade.thick ?? 0.19) * 0.5 }),
        new THREE.MeshBasicMaterial({ color: spec.blade.hamonColor ?? 0xdfe6ef, transparent: true, opacity: 0.55 }),
      );
      hm.position.y = handleLen + 0.7;
      hm.position.z = -0.02;
      group.add(hm);
    }
  }

  /* ------------------------------------------------------------ specials */
  const extras = [];
  if (spec.special === 'flare') {
    // Molten core that brightens with your speed.
    const core = new THREE.Mesh(
      bladeGeometry({ ...spec.blade, width: (spec.blade.width ?? 0.62) * 0.55, thick: 0.02 }),
      new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    core.position.y = handleLen + 0.7;
    group.add(core);
    extras.push({ type: 'speedGlow', mesh: core });
  }
  if (spec.special === 'null') {
    const halo = new THREE.Mesh(
      bladeGeometry({ ...spec.blade, width: (spec.blade.width ?? 0.62) * 1.5, thick: 0.01 }),
      new THREE.MeshBasicMaterial({ color: 0x9a4bff, transparent: true, opacity: 0.30, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
    );
    halo.position.y = handleLen + 0.7;
    group.add(halo);
    extras.push({ type: 'pulse', mesh: halo, rate: 1.7 });
  }
  if (spec.special === 'phantom') {
    // The blade is not there. Only the cut is.
    const edge = new THREE.Mesh(
      new THREE.PlaneGeometry(0.16, bladeLen),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
    );
    edge.position.set(0, handleLen + 0.7 + bladeLen / 2, 0.2);
    group.add(edge);
    extras.push({ type: 'flicker', mesh: edge });
  }
  if (spec.special === 'noon') {
    const disc = new THREE.Mesh(
      new THREE.RingGeometry(1.5, 2.4, 24),
      new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.55, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
    );
    disc.position.y = handleLen + 0.4;
    disc.rotation.x = Math.PI / 2;
    group.add(disc);
    extras.push({ type: 'spin', mesh: disc, rate: 0.6 });
  }
  if (spec.special === 'lastsecond') {
    // THE LAST SECOND — the weapon is the minute hand of a clock that is always
    // one tick from midnight. The guard is a dial; the blade carries numerals.
    const dial = new THREE.Mesh(
      new THREE.RingGeometry(1.1, 1.9, 32),
      new THREE.MeshBasicMaterial({ color: 0xf4f4f4, transparent: true, opacity: 0.8, side: THREE.DoubleSide }),
    );
    dial.position.y = handleLen + 0.2;
    dial.rotation.x = Math.PI / 2;
    group.add(dial);
    for (let i = 0; i < 12; i++) {
      const tick = new THREE.Mesh(
        new THREE.BoxGeometry(i % 3 === 0 ? 0.3 : 0.16, 0.06, i % 3 === 0 ? 0.62 : 0.34),
        new THREE.MeshBasicMaterial({ color: i === 11 ? 0xe23a2e : 0x101014 }),
      );
      const a = (i / 12) * Math.PI * 2;
      tick.position.set(Math.cos(a) * 1.5, handleLen + 0.24, Math.sin(a) * 1.5);
      tick.rotation.y = -a;
      group.add(tick);
    }
    const secondHand = new THREE.Mesh(
      new THREE.BoxGeometry(0.1, 0.06, 1.35),
      new THREE.MeshBasicMaterial({ color: 0xe23a2e }),
    );
    secondHand.position.set(0, handleLen + 0.3, 0.6);
    group.add(secondHand);
    extras.push({ type: 'tick', mesh: secondHand, pivot: new THREE.Vector3(0, handleLen + 0.3, 0) });

    const shimmer = new THREE.Mesh(
      bladeGeometry({ ...spec.blade, width: (spec.blade.width ?? 0.6) * 1.25, thick: 0.015 }),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.2, blending: THREE.AdditiveBlending, side: THREE.DoubleSide, depthWrite: false }),
    );
    shimmer.position.y = handleLen + 0.7;
    group.add(shimmer);
    extras.push({ type: 'pulse', mesh: shimmer, rate: 0.9 });
  }

  const tipLocal = new THREE.Vector3(0, handleLen + 0.7 + bladeLen, (spec.blade.curve ?? 0.9) * 1.0);
  const baseLocal = new THREE.Vector3(0, handleLen + 0.9, 0);
  group.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return { group, tipLocal, baseLocal, emissive, extras, blade };
}

/* ----------------------------------------------------------- item tables */

const K = (id, name, rarity, crate, spec, lore) => ({ id, name, type: 'katana', rarity, crate, spec, lore });

export const KATANAS = {
  standard: K('standard', 'STANDARD ISSUE', 'COMMON', null, {
    blade: { color: 0xc8ced8, emissive: 0x000000, len: 11, width: 0.62, curve: 0.9 },
    fittings: 0x2c2f36, wrap: 0x16171c, tsuba: 'disc',
  }, 'District issue. Forty thousand made. Yours is not special. You might be.'),

  chalk: K('chalk', 'CHALK', 'COMMON', 'street', {
    blade: { color: 0xe8e6df, rough: 0.6, metal: 0.3, len: 10.6, width: 0.66, curve: 0.7 },
    fittings: 0x9aa2ad, wrap: 0xd9d5ca, tsuba: 'square',
  }, 'Matte white, no shine, no glare. Popular with runners who work at noon.'),

  rust: K('rust', 'SALT AND RUST', 'COMMON', 'yards', {
    blade: { color: 0x9a7a5e, rough: 0.78, metal: 0.55, len: 11.2, width: 0.68, curve: 1.0 },
    fittings: 0x5e4630, wrap: 0x3a2a1e, tsuba: 'disc',
  }, 'Pulled out of the canal. Still takes an edge. Mostly.'),

  quarry: K('quarry', 'QUARRY', 'COMMON', 'yards', {
    blade: { color: 0xa8aeb8, rough: 0.66, metal: 0.45, len: 10.4, width: 0.86, curve: 0.3, taper: 0.2 },
    fittings: 0x4a4f59, wrap: 0x2b2f36, tsuba: 'square',
  }, 'Short, broad, unglamorous. Made for cutting banding, not people.'),

  pilgrim: K('pilgrim', 'PILGRIM', 'COMMON', 'hill', {
    blade: { color: 0xd2d7de, rough: 0.45, len: 11.8, width: 0.56, curve: 1.45 },
    fittings: 0x6b5a3e, wrap: 0x8a7550, tsuba: 'ring', wrapDiamonds: false,
  }, 'Carried up the hill road every spring by someone who never explains why.'),

  signal: K('signal', 'SIGNAL', 'UNCOMMON', 'street', {
    blade: { color: 0xdff6fb, emissive: 0x22c6e8, emissivePower: 0.7, len: 11, width: 0.58, curve: 0.8 },
    fittings: 0x1d3b45, fittingsEmissive: 0x0a2830, wrap: 0x0f1a1e, tsuba: 'ring',
  }, 'Traffic-grade cyan. Legally required to be visible at 200.'),

  hazard: K('hazard', 'HAZARD', 'UNCOMMON', 'street', {
    blade: { color: 0xf2c511, rough: 0.35, len: 10.8, width: 0.74, curve: 0.6, hamonColor: 0x1a1a1a },
    fittings: 0x16171c, wrap: 0xf2c511, tsuba: 'square',
  }, 'Site safety yellow. Ironic, given the use case.'),

  fieldgrey: K('fieldgrey', 'FIELD GREY', 'UNCOMMON', 'yards', {
    blade: { color: 0x8d949d, rough: 0.5, len: 11.4, width: 0.6, curve: 1.1 },
    fittings: 0x3f444c, wrap: 0x2b2f36, tsuba: 'cross',
  }, 'Nothing reflective. Nothing loud. Nothing to identify you by.'),

  koi: K('koi', 'KOI', 'RARE', 'street', {
    blade: { color: 0xf0f2f5, rough: 0.15, len: 11.6, width: 0.64, curve: 1.3, hamonColor: 0xffd9d4 },
    fittings: 0xb23a2c, wrap: 0xe23a2e, tsuba: 'sun',
  }, 'Red wrap, water-pattern hamon. Swims upstream, cuts downstream.'),

  circuit: K('circuit', 'CIRCUIT', 'RARE', 'yards', {
    blade: { color: 0x1f2630, emissive: 0x2ce8a8, emissivePower: 1.5, metal: 0.95, rough: 0.15, len: 11, width: 0.56, curve: 0.5 },
    fittings: 0x121820, fittingsEmissive: 0x0d5a44, wrap: 0x0b0e12, tsuba: 'cross',
  }, 'Trace-etched. The lines are functional. Nobody will say what they do.'),

  bone: K('bone', 'RELIQUARY', 'RARE', 'hill', {
    blade: { color: 0xe6e1cf, rough: 0.55, metal: 0.2, len: 12.2, width: 0.78, curve: 1.6, taper: 0.42 },
    fittings: 0x7a6a4f, wrap: 0x453a2c, tsuba: 'ring',
  }, 'Carved, not forged. Lighter than steel. Considerably ruder.'),

  meridian: K('meridian', 'MERIDIAN', 'EPIC', 'street', {
    blade: { color: 0xf5e6b8, metal: 1.0, rough: 0.12, len: 12, width: 0.6, curve: 1.2, hamonColor: 0xfff4c9 },
    fittings: 0xd8b24a, wrap: 0x14141a, tsuba: 'sun', handleLen: 4.4,
  }, 'Commissioned for the district charter. Two were made. One is in a museum.'),

  cryo: K('cryo', 'CRYOGENIC', 'EPIC', 'yards', {
    blade: { color: 0xbfe9ff, metal: 0.4, rough: 0.05, len: 11.8, width: 0.92, curve: 0.4, taper: 0.18, opacity: 0.86, emissive: 0x2f9fd8, emissivePower: 0.5 },
    fittings: 0x7fb6cf, wrap: 0x1b2c36, tsuba: 'square',
  }, 'Forged wet and never allowed to finish. It is still, technically, freezing.'),

  volt: K('volt', 'VOLT', 'EPIC', 'hill', {
    blade: { color: 0x2b2f3a, emissive: 0xf2d511, emissivePower: 2.0, metal: 0.9, rough: 0.3, len: 11.2, width: 0.5, curve: 0.2, taper: 0.1 },
    fittings: 0x16171c, fittingsEmissive: 0x554a00, wrap: 0x0d0e12, tsuba: 'none', handleLen: 4.6,
  }, 'Straight-bladed, hollow-cored, permanently charged. Do not sheathe wet.'),

  solar: K('solar', 'SOLAR FLARE', 'LEGENDARY', 'street', {
    blade: { color: 0x2a1408, emissive: 0xff6a1a, emissivePower: 2.6, metal: 0.6, rough: 0.4, len: 12.6, width: 0.85, curve: 1.5, hamonColor: 0xffb347 },
    fittings: 0x5e2a10, fittingsEmissive: 0x8c3a00, wrap: 0x1a0d06, tsuba: 'sun', special: 'flare', handleLen: 4.6,
  }, 'The core never cooled. Ten years on, it is still losing the argument with entropy.'),

  nulledge: K('nulledge', 'NULL EDGE', 'LEGENDARY', 'yards', {
    blade: { color: 0x07070a, metal: 0.2, rough: 0.95, len: 12.4, width: 0.7, curve: 1.0, hamon: false },
    fittings: 0x1a1030, fittingsEmissive: 0x3a1a6a, wrap: 0x0a0a10, tsuba: 'ring', special: 'null', handleLen: 4.2,
  }, 'Photographs of it come back empty. The blade is fine. The film is not.'),

  longnoon: K('longnoon', 'THE LONG NOON', 'MYTHIC', 'street', {
    blade: { color: 0xfff6dd, metal: 1.0, rough: 0.02, len: 17.5, width: 0.38, curve: 2.4, taper: 0.5, emissive: 0xffd27a, emissivePower: 0.8 },
    fittings: 0xffd76a, wrap: 0xf4efe2, tsuba: 'sun', special: 'noon', handleLen: 5.2,
  }, 'A blade so long it arrives before you do. Named for the hour it never leaves.'),

  phantom: K('phantom', 'PHANTOM LIMB', 'MYTHIC', 'hill', {
    blade: { color: 0xffffff, invisible: true, len: 12, width: 0.6, curve: 0.9 },
    fittings: 0x3a3f4a, wrap: 0x0d0e12, tsuba: 'none', special: 'phantom', handleLen: 4.4,
  }, 'The hilt was recovered. The blade was not. It still cuts, which raises questions.'),

  lastsecond: K('lastsecond', 'THE LAST SECOND', 'SECRET', null, {
    blade: { color: 0xf8f8fb, metal: 1.0, rough: 0.0, len: 13.5, width: 0.44, curve: 0.0, taper: 0.0, hamon: false, emissive: 0xffffff, emissivePower: 0.35 },
    fittings: 0xf4f4f4, wrap: 0x101014, tsuba: 'none', special: 'lastsecond', handleLen: 4.0,
  }, 'It is the minute hand. It has never moved. Everything else has.'),
};

const S = (id, name, rarity, crate, spec, lore) => ({ id, name, type: 'skin', rarity, crate, spec, lore });

export const SKINS = {
  runner: S('runner', 'RUNNER', 'COMMON', null, { suit: 0x3f4550, accent: 0xd7dae0, trim: 0x22262e, visor: 0x22c6e8, cloth: 0x2c313a }, 'Standard courier plate. It has been dropped from height. Repeatedly.'),
  cadet: S('cadet', 'CADET', 'COMMON', 'street', { suit: 0x2f4a6b, accent: 0x8fb4d8, trim: 0x18232f, visor: 0xd7dae0, cloth: 0x27374a }, 'Academy issue, first year. The helmet is one size too big on purpose.'),
  dockhand: S('dockhand', 'DOCKHAND', 'COMMON', 'yards', { suit: 0x4a4f59, accent: 0xf2c511, trim: 0x2b2f36, visor: 0xd7dae0, cloth: 0x3d434f }, 'Steel toes, rated gloves, and a helmet with somebody else\'s name in it.'),
  hillwalker: S('hillwalker', 'HILLWALKER', 'COMMON', 'hill', { suit: 0x4c5440, accent: 0xd8c49a, trim: 0x2c3126, visor: 0xe6e1cf, cloth: 0x5a634c }, 'Waxed canvas, good boots. Was here before the district was.'),
  courier: S('courier', 'COURIER', 'UNCOMMON', 'street', { suit: 0xd9721f, accent: 0x16171c, trim: 0xf2c511, visor: 0x101318, cloth: 0xb75a14, hivis: true }, 'Hi-vis. Legally a vehicle above 180.'),
  nightshift: S('nightshift', 'NIGHT SHIFT', 'UNCOMMON', 'yards', { suit: 0x1b1d24, accent: 0x3d434f, trim: 0x22c6e8, visor: 0x22c6e8, cloth: 0x14151a, glow: 0.4 }, 'Nobody runs the district at 04:00 for a good reason.'),
  pacecar: S('pacecar', 'PACE CAR', 'RARE', 'yards', { suit: 0xf0f2f5, accent: 0xe23a2e, trim: 0x101318, visor: 0x101318, cloth: 0xe8eaee, livery: true }, 'Racing livery, number stencils, sponsor nobody remembers.'),
  streetsam: S('streetsam', 'STREET SAMURAI', 'RARE', 'street', { suit: 0x24262d, accent: 0xb23a2c, trim: 0x8d949d, visor: 0xe23a2e, cloth: 0x8a2b20, coat: true }, 'A long coat is a terrible idea at speed. That is rather the point.'),
  redline: S('redline', 'RED LINE', 'EPIC', 'street', { suit: 0x1a1013, accent: 0xe8453a, trim: 0xf2c511, visor: 0xe8453a, cloth: 0x7a1d18, coat: true, glow: 0.7 }, 'Past this marker the engine does not survive. Neither does anyone nearby.'),
  glass: S('glass', 'GLASS', 'EPIC', 'hill', { suit: 0x9fd4e8, accent: 0xffffff, trim: 0x6fb8d4, visor: 0xffffff, cloth: 0xbfe4f2, translucent: 0.55 }, 'Annealed, not tempered. Everyone flinches when you take a hit. You do too.'),
  afterburn: S('afterburn', 'AFTERBURN', 'LEGENDARY', 'yards', { suit: 0x191a20, accent: 0x3d434f, trim: 0xff6a1a, visor: 0xff8a2a, cloth: 0x101014, vents: true, glow: 1 }, 'The vents open as you accelerate. By 400 you are venting light.'),
  lantern: S('lantern', 'PAPER LANTERN', 'MYTHIC', 'hill', { suit: 0xf6e7c4, accent: 0xe23a2e, trim: 0xd8c49a, visor: 0xffcf6a, cloth: 0xf0dcb0, lantern: true, glow: 1.2 }, 'Folded from one sheet. Nobody has ever seen the fold undone.'),
  echo: S('echo', 'ECHO', 'SECRET', null, { suit: 0x0f1014, accent: 0xffffff, trim: 0xffffff, visor: 0xffffff, cloth: 0x0f1014, ghost: true, glow: 1 }, 'You arrive three times. Two of them are not you. Nobody agrees which.'),
};

const mk = (type) => (id, name, rarity, crate, spec, lore) => ({ id, name, type, rarity, crate, spec, lore });
const TR = mk('trail'), SL = mk('slash'), KL = mk('kill'), SP = mk('spawn'), SH = mk('sheath');

export const TRAILS = {
  none: TR('none', 'NO TRAIL', 'COMMON', null, { color: 0xffffff, width: 0, style: 'none' }, 'Nothing behind you.'),
  vapor: TR('vapor', 'VAPOR', 'COMMON', 'street', { color: 0xdce8f0, width: 1.0, style: 'ribbon', opacity: 0.35 }, 'Displaced air, condensing. Entirely mundane. Still looks good.'),
  grit: TR('grit', 'GRIT', 'COMMON', 'yards', { color: 0xa89a82, width: 1.0, style: 'spark', opacity: 0.45 }, 'Yard dust, thrown up and left behind.'),
  dust: TR('dust', 'CHALK DUST', 'COMMON', 'hill', { color: 0xe8e6df, width: 1.1, style: 'ribbon', opacity: 0.4 }, 'The hill road is limestone. It gets everywhere.'),
  inkribbon: TR('inkribbon', 'INK RIBBON', 'UNCOMMON', 'street', { color: 0x14151a, width: 1.4, style: 'ribbon', opacity: 0.75 }, 'Calligraphy at 300. The stroke is the whole poem.'),
  circuit: TR('circuit', 'CIRCUIT', 'RARE', 'yards', { color: 0x2ce8a8, width: 1.1, style: 'dash', opacity: 0.9 }, 'Dashes, evenly spaced, in a grid nobody drew.'),
  ember: TR('ember', 'EMBER', 'EPIC', 'hill', { color: 0xff6a1a, width: 1.5, style: 'spark', opacity: 1 }, 'The road is not on fire. It is merely considering it.'),
  prism: TR('prism', 'PRISM', 'LEGENDARY', 'street', { color: 0xffffff, width: 1.8, style: 'prism', opacity: 0.85 }, 'White light, split by the speed of the thing splitting it.'),
  comet: TR('comet', 'THE COMET', 'MYTHIC', 'yards', { color: 0x9fd8ff, width: 2.6, style: 'comet', opacity: 1 }, 'Registered as an astronomical object by a very tired observatory.'),
  timestamp: TR('timestamp', 'TIMESTAMP', 'SECRET', null, { color: 0xffffff, width: 2.2, style: 'timestamp', opacity: 1 }, 'It writes the hour you passed. The hour is always the same one.'),
};

export const SLASHES = {
  steel: SL('steel', 'STEEL', 'COMMON', null, { color: 0xffffff, shape: 'arc', width: 1 }, 'A clean line.'),
  crescent: SL('crescent', 'CRESCENT', 'UNCOMMON', 'street', { color: 0xbfe9ff, shape: 'crescent', width: 1.2 }, 'Wider at the belly, thin at the horns.'),
  inksplit: SL('inksplit', 'INKSPLIT', 'RARE', 'hill', { color: 0x14151a, shape: 'split', width: 1.4 }, 'Two strokes that were one stroke.'),
  fracture: SL('fracture', 'FRACTURE', 'EPIC', 'yards', { color: 0x22c6e8, shape: 'shatter', width: 1.5 }, 'The air holds the crack for a moment before it heals.'),
  solar: SL('solar', 'SOLAR', 'LEGENDARY', 'street', { color: 0xffb347, shape: 'flare', width: 1.8 }, 'Brief, local, and roughly the temperature of an argument.'),
  voidgate: SL('voidgate', 'VOID GATE', 'MYTHIC', 'hill', { color: 0x9a4bff, shape: 'gate', width: 2.2 }, 'For an instant there is a door. Do not look through it.'),
};

export const KILLS = {
  shatter: KL('shatter', 'SHATTER', 'COMMON', null, { color: 0xd7dae0, style: 'shards' }, 'They come apart like safety glass.'),
  petals: KL('petals', 'PETALS', 'UNCOMMON', 'hill', { color: 0xe8879a, style: 'petals' }, 'Out of season. Always.'),
  ash: KL('ash', 'ASH FALL', 'RARE', 'street', { color: 0x8d949d, style: 'ash' }, 'Grey, slow, and weirdly peaceful.'),
  lightning: KL('lightning', 'ARC FAULT', 'EPIC', 'yards', { color: 0xf2d511, style: 'bolt' }, 'The district grid browns out for one frame.'),
  implosion: KL('implosion', 'IMPLOSION', 'LEGENDARY', 'yards', { color: 0x9a4bff, style: 'implode' }, 'Everything nearby leans in, then decides against it.'),
  kanji: KL('kanji', 'VERDICT', 'MYTHIC', 'street', { color: 0xe23a2e, style: 'kanji' }, 'A single character hangs in the air for one second. Nobody agrees on the translation.'),
};

export const SPAWNS = {
  drop: SP('drop', 'DROP IN', 'COMMON', null, { color: 0xd7dae0, style: 'drop' }, 'Straight down. No ceremony.'),
  flashstep: SP('flashstep', 'FLASH STEP', 'UNCOMMON', 'yards', { color: 0x22c6e8, style: 'flash' }, 'You were not there. Now the argument is over.'),
  origami: SP('origami', 'ORIGAMI', 'RARE', 'hill', { color: 0xf6e7c4, style: 'fold' }, 'Unfolds from a single sheet, then stands up.'),
  boom: SP('boom', 'SONIC BOOM', 'EPIC', 'street', { color: 0xffffff, style: 'boom' }, 'The sound arrives second. It usually does.'),
};

export const SHEATHS = {
  lacquer: SH('lacquer', 'LACQUER BLACK', 'COMMON', null, { color: 0x101014, trim: 0x3d434f }, 'Seven coats. Each one thinner than the last.'),
  crimson: SH('crimson', 'CRIMSON WRAP', 'UNCOMMON', 'street', { color: 0x7a1d18, trim: 0xf2c511 }, 'Cord-wrapped, knotted at the throat.'),
  chrome: SH('chrome', 'CHROME', 'RARE', 'yards', { color: 0xc8ced8, trim: 0xf0f2f5, metal: 1 }, 'You can check your reflection. You will not like the speed.'),
  circuitsaya: SH('circuitsaya', 'TRACE', 'EPIC', 'yards', { color: 0x121820, trim: 0x2ce8a8, glow: 1 }, 'The saya reads the blade. Nobody has asked what it reports to.'),
  bonesaya: SH('bonesaya', 'RELIQUARY SAYA', 'LEGENDARY', 'hill', { color: 0xe6e1cf, trim: 0x7a6a4f }, 'Matched set. Both halves were once the same animal.'),
};

/* --------------------------------------------------------------- registry */

export const CATALOG = { katana: KATANAS, skin: SKINS, trail: TRAILS, slash: SLASHES, kill: KILLS, spawn: SPAWNS, sheath: SHEATHS };

export const ALL_ITEMS = [];
for (const [type, table] of Object.entries(CATALOG)) {
  for (const item of Object.values(table)) ALL_ITEMS.push(item);
}

const BY_ID = new Map(ALL_ITEMS.map((i) => [i.type + ':' + i.id, i]));
export function getItem(type, id) {
  return BY_ID.get(type + ':' + id) || Object.values(CATALOG[type])[0];
}

export const TYPE_LABEL = {
  katana: 'KATANA', skin: 'CHARACTER', trail: 'SPEED TRAIL',
  slash: 'SLASH VFX', kill: 'KILL EFFECT', spawn: 'SPAWN EFFECT', sheath: 'SHEATH',
};

export const DEFAULT_LOADOUT = {
  katana: 'standard', skin: 'runner', trail: 'vapor',
  slash: 'steel', kill: 'shatter', spawn: 'drop', sheath: 'lacquer',
};

/**
 * [MACH] — look development.
 *
 * Hard cel shading, heavy black, one hot accent. Everything is procedural:
 * no textures ship with the game. Building facades, road markings and hazard
 * stripes are all generated in-shader or on a canvas at boot.
 */

import * as THREE from '../../lib/three.module.js';

export const PALETTE = {
  ink: 0x0d0e12,
  shadow: 0x1b1d24,
  slate: 0x2c3039,
  steel: 0x3d434f,
  concrete: 0x6e7580,
  pale: 0x9aa2ad,
  bone: 0xd7dae0,
  asphalt: 0x23252c,
  dirt: 0x4a4239,
  grass: 0x3c4a34,
  rust: 0x7a4a2e,
  yellow: 0xf2c511,
  cyan: 0x22c6e8,
  red: 0xe23a2e,
  magenta: 0xc63fa0,
  white: 0xf3f4f6,
};

/** 3-step toon ramp — the hard terracing that gives the comic read. */
export function toonGradient(steps = 4) {
  const data = new Uint8Array(steps * 4);
  const stops = [0.30, 0.56, 0.80, 1.0];
  for (let i = 0; i < steps; i++) {
    const v = Math.round(255 * (stops[i] ?? (i + 1) / steps));
    data[i * 4] = v; data[i * 4 + 1] = v; data[i * 4 + 2] = v; data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, steps, 1, THREE.RGBAFormat);
  tex.minFilter = THREE.NearestFilter;
  tex.magFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.needsUpdate = true;
  return tex;
}

let GRADIENT = null;
export function gradient() { return (GRADIENT ||= toonGradient()); }

export function toon(color, opts = {}) {
  const m = new THREE.MeshToonMaterial({
    color,
    gradientMap: gradient(),
    ...opts,
  });
  return m;
}

/* ------------------------------------------------------- facade shader */

const WORLDPOS_VARYINGS = `
varying vec3 vWPos;
varying vec3 vWNrm;
`;

function injectWorldPos(shader) {
  shader.vertexShader = shader.vertexShader
    .replace('#include <common>', `#include <common>\n${WORLDPOS_VARYINGS}`)
    .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
      mat3 wm = mat3(modelMatrix);
      #ifdef USE_INSTANCING
        wm = wm * mat3(instanceMatrix);
      #endif
      vWNrm = normalize(wm * objectNormal);`)
    .replace('#include <project_vertex>', `
      vec4 _wp = vec4(transformed, 1.0);
      #ifdef USE_INSTANCING
        _wp = instanceMatrix * _wp;
      #endif
      vWPos = (modelMatrix * _wp).xyz;
      #include <project_vertex>`);
  shader.fragmentShader = shader.fragmentShader
    .replace('#include <common>', `#include <common>\n${WORLDPOS_VARYINGS}`);
}

/**
 * Tower / warehouse facades: window bands, mullions, a few lit panes, and a
 * grime gradient toward the street. Reads as a real building at 100 m/s.
 */
export function facadeMaterial(color, opts = {}) {
  // Pull our own knobs out before handing the rest to three, which warns about
  // properties it does not recognise.
  const { floorHeight, barWidth, glass: glassHex, lit: litHex, ...matOpts } = opts;
  const m = toon(color, matOpts);
  const floorH = floorHeight ?? 26.0;
  const barW = barWidth ?? 17.0;
  const glass = new THREE.Color(glassHex ?? 0x151a24);
  const lit = new THREE.Color(litHex ?? 0x3d4a5e);
  m.onBeforeCompile = (shader) => {
    injectWorldPos(shader);
    shader.uniforms.uFloorH = { value: floorH };
    shader.uniforms.uBarW = { value: barW };
    shader.uniforms.uGlass = { value: glass };
    shader.uniforms.uLit = { value: lit };
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        uniform float uFloorH; uniform float uBarW;
        uniform vec3 uGlass; uniform vec3 uLit;
        float h21(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          float vertical = 1.0 - step(0.55, abs(vWNrm.y));
          float u = abs(vWNrm.x) > 0.5 ? vWPos.z : vWPos.x;
          float fy = vWPos.y / uFloorH;
          float fu = u / uBarW;
          float bandY = fract(fy);
          float bandU = fract(fu);
          float win = step(0.26, bandY) * step(bandY, 0.74) * step(0.16, bandU) * step(bandU, 0.84);
          win *= vertical * step(8.0, vWPos.y);
          float r = h21(vec2(floor(fu), floor(fy)));
          vec3 pane = mix(uGlass, uLit, step(0.88, r));
          diffuseColor.rgb = mix(diffuseColor.rgb, pane, win * 0.92);
          // street-level grime + a bright cornice line
          float grime = smoothstep(120.0, 0.0, vWPos.y) * 0.22;
          diffuseColor.rgb *= (1.0 - grime * vertical);
          float cornice = step(0.965, bandY) * vertical;
          diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * 1.5 + 0.03, cornice);
        }`);
    m.userData.shader = shader;
  };
  m.customProgramCacheKey = () => 'facade' + floorH + '_' + barW;
  return m;
}

/**
 * Terrain: flat-shaded vertex colours plus painted road markings derived from
 * world position, so the boulevard actually looks like a road.
 */
export function terrainMaterial() {
  const m = toon(0xffffff, { vertexColors: true });
  m.onBeforeCompile = (shader) => {
    injectWorldPos(shader);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        float lane(float p, float period, float dash){
          float f = abs(fract(p / period) - 0.5) * period;
          return step(f, dash);
        }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
        {
          vec3 paint = vec3(0.86, 0.84, 0.78);
          vec3 hot = vec3(0.95, 0.77, 0.07);
          float up = step(0.7, vWNrm.y);
          float m2 = 0.0;
          vec3 pc = paint;
          // Grand Boulevard (runs along X at z = 0)
          if (abs(vWPos.z) < 152.0) {
            float centre = step(abs(vWPos.z), 3.0) * lane(vWPos.x, 90.0, 26.0);
            float edge = step(abs(abs(vWPos.z) - 143.0), 2.5);
            float lanes = step(abs(abs(vWPos.z) - 72.0), 1.6) * lane(vWPos.x, 60.0, 16.0);
            m2 = max(max(centre, edge), lanes);
            pc = mix(paint, hot, centre);
          }
          // North Avenue (runs along Z at x = 0)
          if (abs(vWPos.x) < 152.0) {
            float centre = step(abs(vWPos.x), 3.0) * lane(vWPos.z, 90.0, 26.0);
            float edge = step(abs(abs(vWPos.x) - 143.0), 2.5);
            m2 = max(m2, max(centre, edge));
            pc = mix(pc, hot, centre);
          }
          // Ring road
          float ring = max(abs(vWPos.x), abs(vWPos.z));
          if (abs(ring - 1800.0) < 112.0) {
            float edge = step(abs(abs(ring - 1800.0) - 104.0), 2.5);
            float centre = step(abs(ring - 1800.0), 2.5) * lane(abs(vWPos.x) > abs(vWPos.z) ? vWPos.z : vWPos.x, 80.0, 22.0);
            m2 = max(m2, max(edge, centre));
          }
          // Sunken expressway
          if (abs(vWPos.x - 1250.0) < 118.0) {
            float centre = step(abs(vWPos.x - 1250.0), 2.5) * lane(vWPos.z, 70.0, 20.0);
            m2 = max(m2, centre);
            pc = mix(pc, hot, centre);
          }
          diffuseColor.rgb = mix(diffuseColor.rgb, pc, m2 * up * 0.9);
        }`);
  };
  m.customProgramCacheKey = () => 'terrain';
  return m;
}

/* ----------------------------------------------------- canvas textures */

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d');
  draw(g, w, h);
  const t = new THREE.CanvasTexture(c);
  t.anisotropy = 4;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function hazardTexture() {
  return canvasTex(128, 32, (g, w, h) => {
    g.fillStyle = '#f2c511'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#16171c';
    for (let i = -h; i < w + h; i += 28) {
      g.beginPath();
      g.moveTo(i, 0); g.lineTo(i + 14, 0); g.lineTo(i + 14 + h, h); g.lineTo(i + h, h);
      g.closePath(); g.fill();
    }
    g.fillStyle = '#0d0e12';
    g.fillRect(0, 0, w, 3); g.fillRect(0, h - 3, w, 3);
  });
}

const BILLBOARD_COPY = [
  { bg: '#f2c511', fg: '#111218', t: 'MACH', sub: 'SPEED IS DAMAGE' },
  { bg: '#e23a2e', fg: '#f6f6f6', t: '500', sub: 'TERMINAL VELOCITY' },
  { bg: '#101218', fg: '#22c6e8', t: '斬', sub: 'MERIDIAN DISTRICT' },
  { bg: '#22c6e8', fg: '#0d0e12', t: 'x0.5', sub: 'DAMAGE MULTIPLIER' },
];

export function billboardTexture(i) {
  const c = BILLBOARD_COPY[i % BILLBOARD_COPY.length];
  return canvasTex(512, 256, (g, w, h) => {
    g.fillStyle = c.bg; g.fillRect(0, 0, w, h);
    g.fillStyle = 'rgba(0,0,0,0.10)';
    for (let y = 0; y < h; y += 8) for (let x = (y / 8) % 2 ? 4 : 0; x < w; x += 8) g.fillRect(x, y, 3, 3);
    g.fillStyle = c.fg;
    g.font = 'bold 150px "Archivo Black", Impact, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(c.t, w / 2, h / 2 - 16);
    g.font = 'bold 34px "Barlow Condensed", Impact, sans-serif';
    g.fillText(c.sub, w / 2, h / 2 + 76);
    g.strokeStyle = c.fg; g.lineWidth = 8;
    g.strokeRect(14, 14, w - 28, h - 28);
  });
}

export function bannerTexture(i) {
  const cols = ['#e23a2e', '#22c6e8', '#f2c511'];
  const col = cols[i % 3];
  return canvasTex(128, 512, (g, w, h) => {
    g.fillStyle = '#12141a'; g.fillRect(0, 0, w, h);
    g.fillStyle = col; g.fillRect(10, 10, w - 20, h - 20);
    g.fillStyle = '#12141a';
    g.font = 'bold 76px "Archivo Black", Impact, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('斬', w / 2, h * 0.28);
    g.fillRect(24, h * 0.44, w - 48, 6);
    g.font = 'bold 40px "Barlow Condensed", Impact, sans-serif';
    for (let k = 0; k < 4; k++) g.fillText('MACH'[k], w / 2, h * 0.56 + k * 44);
  });
}

/** Soft radial sprite used for dust, sparks and glows. */
export function glowTexture() {
  return canvasTex(64, 64, (g, w, h) => {
    const grd = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
    grd.addColorStop(0, 'rgba(255,255,255,1)');
    grd.addColorStop(0.35, 'rgba(255,255,255,0.55)');
    grd.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grd; g.fillRect(0, 0, w, h);
  });
}

/** Hard-edged four-point spark, for impacts. */
export function sparkTexture() {
  return canvasTex(64, 64, (g, w, h) => {
    g.translate(w / 2, h / 2);
    g.fillStyle = '#ffffff';
    g.beginPath();
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2;
      const b = a + Math.PI / 4;
      g.lineTo(Math.cos(a) * 30, Math.sin(a) * 30);
      g.lineTo(Math.cos(b) * 5, Math.sin(b) * 5);
    }
    g.closePath(); g.fill();
  });
}

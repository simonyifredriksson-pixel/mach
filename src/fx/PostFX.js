/**
 * [MACH] — post stack.
 *
 * One extra fullscreen pass. It carries the entire "how fast am I" language:
 *
 *   depth outlines   -> the comic read, always on
 *   radial blur      -> fades in from ~180 speed
 *   speed lines      -> fades in from ~210, peaks at 500
 *   chromatic edges  -> high speed only, edges of frame only
 *   vignette + grain -> constant, subtle
 *   hurt flash       -> on damage taken
 *
 * Everything is scaled so that at a walk the frame is clean and at 500 it is
 * barely controllable — but never illegible.
 */

import * as THREE from '../../lib/three.module.js';

const VERT = `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

const FRAG = `
precision highp float;
varying vec2 vUv;

uniform sampler2D tDiffuse;
uniform sampler2D tDepth;
uniform vec2  uRes;
uniform float uTime;
uniform float uSpeedT;     // 0..1
uniform float uBlur;
uniform float uLines;
uniform float uHurt;
uniform float uLowHP;
uniform float uOutline;
uniform float uNear;
uniform float uFar;
uniform float uFlash;
uniform vec3  uFlashColor;

float linDepth(vec2 uv){
  float z = texture2D(tDepth, uv).x;
  float ndc = z * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

float hash(vec2 p){ return fract(sin(dot(p, vec2(41.3, 289.1))) * 43758.5453); }

void main(){
  vec2 uv = vUv;
  vec2 centre = vec2(0.5);
  vec2 dir = uv - centre;
  float r = length(dir);

  /* ---- chromatic aberration, edges only ---- */
  float ca = uSpeedT * uSpeedT * 0.0075 * smoothstep(0.15, 0.75, r);
  vec3 col;
  col.r = texture2D(tDiffuse, uv - dir * ca).r;
  col.g = texture2D(tDiffuse, uv).g;
  col.b = texture2D(tDiffuse, uv + dir * ca).b;

  /* ---- radial motion blur ---- */
  if (uBlur > 0.003) {
    float amt = uBlur * smoothstep(0.02, 0.9, r);
    vec3 acc = col;
    float w = 1.0;
    for (int i = 1; i < 8; i++) {
      float f = float(i) / 7.0;
      vec2 o = dir * amt * f;
      acc += texture2D(tDiffuse, uv - o).rgb * (1.0 - f * 0.55);
      w += (1.0 - f * 0.55);
    }
    col = acc / w;
  }

  /* ---- depth outline ---- */
  if (uOutline > 0.0) {
    vec2 px = 1.0 / uRes;
    float d0 = linDepth(uv);
    float d1 = linDepth(uv + vec2(px.x, 0.0));
    float d2 = linDepth(uv + vec2(0.0, px.y));
    float d3 = linDepth(uv - vec2(px.x, 0.0));
    float d4 = linDepth(uv - vec2(0.0, px.y));
    float g = abs(d1 - d0) + abs(d2 - d0) + abs(d3 - d0) + abs(d4 - d0);
    // Scale threshold with distance so far buildings don't turn into mush.
    float edge = smoothstep(d0 * 0.022 + 0.6, d0 * 0.055 + 2.4, g);
    edge *= uOutline * (1.0 - smoothstep(2600.0, 4200.0, d0));
    col = mix(col, col * 0.06, edge);
  }

  /* ---- speed lines: peripheral only, and never enough to hide a target ---- */
  if (uLines > 0.001) {
    float a = atan(dir.y * (uRes.y / uRes.x), dir.x);
    float lane = floor(a * 30.0 + hash(vec2(floor(a * 30.0), 1.0)) * 2.0);
    float seed = hash(vec2(lane, 3.0));
    float streak = fract(seed * 7.0 + uTime * (2.5 + seed * 4.0));
    float len = 0.10 + seed * 0.22;
    float band = smoothstep(0.0, 0.04, streak) * (1.0 - smoothstep(len, len + 0.20, streak));
    // Held well outside the centre so the blade arc stays clean.
    float radial = smoothstep(0.38, 0.78, r) * (1.0 - smoothstep(0.92, 1.25, r));
    float l = band * radial * uLines * (0.30 + seed * 0.70);
    col += vec3(0.85, 0.92, 1.0) * l * 0.30;
  }

  /* ---- vignette / grade ---- */
  float vig = 1.0 - smoothstep(0.48, 1.10, r) * (0.26 + uSpeedT * 0.28);
  col *= vig;
  float lum = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(col, vec3(lum), smoothstep(0.45, 1.0, r) * 0.22);

  /* ---- damage / low health ---- */
  if (uHurt > 0.001) {
    float ring = smoothstep(0.25, 0.95, r);
    col = mix(col, vec3(0.72, 0.06, 0.05), ring * uHurt * 0.85);
  }
  if (uLowHP > 0.001) {
    float pulse = 0.5 + 0.5 * sin(uTime * 5.0);
    col = mix(col, vec3(0.45, 0.02, 0.02), smoothstep(0.35, 1.0, r) * uLowHP * (0.18 + pulse * 0.16));
  }
  if (uFlash > 0.001) col = mix(col, uFlashColor, uFlash);

  /* ---- grain ---- */
  float g2 = hash(uv * uRes + fract(uTime) * 91.7);
  col += (g2 - 0.5) * 0.016;

  // The scene target is sRGB, so the sampler handed us linear values. A raw
  // ShaderMaterial gets no automatic output conversion, so encode by hand.
  col = pow(max(col, vec3(0.0)), vec3(1.0 / 2.2));
  gl_FragColor = vec4(col, 1.0);
}
`;

export class PostFX {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.enabled = true;

    const size = renderer.getDrawingBufferSize(new THREE.Vector2());
    this.target = this._makeTarget(size.x, size.y);

    this.material = new THREE.ShaderMaterial({
      vertexShader: VERT,
      fragmentShader: FRAG,
      depthTest: false,
      depthWrite: false,
      uniforms: {
        tDiffuse: { value: this.target.texture },
        tDepth: { value: this.target.depthTexture },
        uRes: { value: new THREE.Vector2(size.x, size.y) },
        uTime: { value: 0 },
        uSpeedT: { value: 0 },
        uBlur: { value: 0 },
        uLines: { value: 0 },
        uHurt: { value: 0 },
        uLowHP: { value: 0 },
        uOutline: { value: 1 },
        uNear: { value: camera.near },
        uFar: { value: camera.far },
        uFlash: { value: 0 },
        uFlashColor: { value: new THREE.Color(0xffffff) },
      },
    });

    const quad = new THREE.BufferGeometry();
    quad.setAttribute('position', new THREE.Float32BufferAttribute([-1, -1, 0, 3, -1, 0, -1, 3, 0], 3));
    quad.setAttribute('uv', new THREE.Float32BufferAttribute([0, 0, 2, 0, 0, 2], 2));
    this.quad = new THREE.Mesh(quad, this.material);
    this.quad.frustumCulled = false;
    this.fsScene = new THREE.Scene();
    this.fsScene.add(this.quad);
    this.fsCamera = new THREE.Camera();

    this.hurt = 0;
    this.flash = 0;
  }

  _makeTarget(w, h) {
    const depth = new THREE.DepthTexture(w, h);
    depth.type = THREE.UnsignedIntType;
    const rt = new THREE.WebGLRenderTarget(w, h, {
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthTexture: depth,
      depthBuffer: true,
      type: THREE.UnsignedByteType,
      colorSpace: THREE.SRGBColorSpace,
    });
    return rt;
  }

  setSize(w, h) {
    const pr = this.renderer.getPixelRatio();
    const dw = Math.max(1, Math.floor(w * pr)), dh = Math.max(1, Math.floor(h * pr));
    this.target.setSize(dw, dh);
    this.material.uniforms.uRes.value.set(dw, dh);
  }

  addHurt(amount) { this.hurt = Math.min(1.1, this.hurt + amount); }
  addFlash(color, amount) {
    this.material.uniforms.uFlashColor.value.set(color);
    this.flash = Math.min(1, this.flash + amount);
  }

  /** @param {object} st {speedT, hp, settings} */
  render(dt, st) {
    const u = this.material.uniforms;
    u.uTime.value += dt;
    this.hurt *= Math.exp(-4.5 * dt);
    this.flash *= Math.exp(-6 * dt);

    const s = st.settings || {};
    const t = st.speedT;
    u.uSpeedT.value = t;
    // Both effects stay out of the way until ~230 speed, then ramp to 500.
    u.uBlur.value = Math.max(0, (t - 0.46)) * 0.105 * (s.motionBlur ?? 1);
    u.uLines.value = Math.max(0, (t - 0.50) / 0.5) * 0.62 * (s.speedLines ?? 1);
    u.uHurt.value = this.hurt;
    u.uLowHP.value = st.hp !== undefined ? Math.max(0, 1 - st.hp / 90) : 0;
    u.uFlash.value = this.flash;
    u.uNear.value = this.camera.near;
    u.uFar.value = this.camera.far;

    if (!this.enabled) {
      this.renderer.setRenderTarget(null);
      this.renderer.render(this.scene, this.camera);
      return;
    }
    this.renderer.setRenderTarget(this.target);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.fsScene, this.fsCamera);
  }
}

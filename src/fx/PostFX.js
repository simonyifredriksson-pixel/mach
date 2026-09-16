/**
 * VELOCITY RONIN — post stack.
 *
 * Design rule, and it is not negotiable: SPEED MUST NEVER MAKE THE GAME HARDER
 * TO LOOK AT. Sprinting should read as exhilarating, not as eye strain.
 *
 * So there is deliberately NO chromatic aberration, NO speed-scaled film grain,
 * NO screen noise and NO ambient shake. What is left is clean and directional:
 *
 *   depth outlines  -> the comic read, always on, speed-independent
 *   speed lines     -> crisp peripheral strokes, centre stays perfectly clear
 *   edge streak     -> a gentle radial smear at the very edge of frame only
 *   cool tint       -> a whisper of colour at the periphery at high speed
 *   vignette        -> mild, constant
 *   hurt flash      -> on damage taken only
 *
 * The centre 40% of the screen is never touched by any speed effect, because
 * that is where the enemy, your blade and your grapple line live.
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

  /* ---- no chromatic aberration anywhere: it is pure eye strain ---- */
  vec3 col = texture2D(tDiffuse, uv).rgb;

  /* ---- edge streak: a soft directional smear, PERIPHERY ONLY ----
     Held off until r > 0.55 so the centre of the frame — where you actually
     fight — is pixel-for-pixel sharp no matter how fast you are going. */
  if (uBlur > 0.0015) {
    float amt = uBlur * smoothstep(0.55, 1.05, r);
    if (amt > 0.0004) {
      vec3 acc = col;
      float w = 1.0;
      for (int i = 1; i < 5; i++) {
        float f = float(i) / 4.0;
        vec2 o = dir * amt * f;
        float wi = 1.0 - f * 0.6;
        acc += texture2D(tDiffuse, uv - o).rgb * wi;
        w += wi;
      }
      col = acc / w;
    }
  }

  /* ---- outline + contact shading ----
     A FIRST-derivative edge test fires on every flat surface seen at a grazing
     angle, because depth genuinely ramps across it — that was the speckled
     "grain" covering the screen. This is a SECOND-derivative (Laplacian) test:
     any linear depth ramp cancels exactly, so flat walls and floors are silent
     at every angle and only real silhouettes survive. */
  float d0 = linDepth(uv);
  if (uOutline > 0.0 && d0 < uFar * 0.6) {
    vec2 px = 1.0 / uRes;
    float dR = linDepth(uv + vec2(px.x, 0.0));
    float dL = linDepth(uv - vec2(px.x, 0.0));
    float dU = linDepth(uv + vec2(0.0, px.y));
    float dD = linDepth(uv - vec2(0.0, px.y));
    float lap = abs((dR + dL) * 0.5 - d0) + abs((dU + dD) * 0.5 - d0);
    // Relative threshold: an edge must be a real step, not float noise.
    float thresh = d0 * 0.010 + 0.8;
    float edge = smoothstep(thresh, thresh * 3.2, lap);
    edge *= uOutline * (1.0 - smoothstep(2400.0, 4200.0, d0));
    col = mix(col, col * 0.10, edge * 0.85);

    /* ---- cheap contact occlusion ----
       Points that sit behind their surroundings get gently darkened. Eight
       taps on a small ring, depth-only, no noise and no dither pattern. */
    float ao = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7853981;
      vec2 o = vec2(cos(a), sin(a)) * px * (7.0 + d0 * 0.004);
      float ds = linDepth(uv + o);
      float diff = d0 - ds;
      ao += clamp(diff / (d0 * 0.02 + 3.0), 0.0, 1.0);
    }
    ao = clamp(ao / 8.0, 0.0, 1.0);
    ao *= 1.0 - smoothstep(1800.0, 3600.0, d0);
    col *= 1.0 - ao * 0.30;
  }

  /* ---- speed lines: clean directional strokes, strictly peripheral ---- */
  if (uLines > 0.001) {
    float a = atan(dir.y * (uRes.y / uRes.x), dir.x);
    float lane = floor(a * 26.0);
    float seed = hash(vec2(lane, 3.0));
    // Each lane is a single crisp stroke sweeping outward at its own pace.
    float streak = fract(seed * 7.0 + uTime * (1.9 + seed * 2.6));
    float len = 0.13 + seed * 0.20;
    float band = smoothstep(0.0, 0.03, streak) * (1.0 - smoothstep(len, len + 0.16, streak));
    // Thin the stroke across the lane so it is a line, not a wedge.
    float acrossLane = abs(fract(a * 26.0) - 0.5) * 2.0;
    float thin = 1.0 - smoothstep(0.25, 0.85, acrossLane);
    float radial = smoothstep(0.44, 0.86, r) * (1.0 - smoothstep(0.95, 1.30, r));
    float l = band * thin * radial * uLines * (0.45 + seed * 0.55);
    col += vec3(0.88, 0.94, 1.0) * l * 0.34;
  }

  /* ---- a whisper of cool colour at the very edge at high speed ---- */
  if (uSpeedT > 0.45) {
    float tint = smoothstep(0.45, 1.0, uSpeedT) * smoothstep(0.55, 1.1, r) * 0.13;
    col = mix(col, col * vec3(0.86, 0.95, 1.12), tint);
  }

  /* ---- vignette: mild and, crucially, NOT speed-scaled ---- */
  float vig = 1.0 - smoothstep(0.52, 1.12, r) * 0.24;
  col *= vig;

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

  /* ---- grade ----
     A soft filmic roll-off with a lifted toe. Highlights compress instead of
     clipping to flat white, shadows open up instead of crushing to black, and
     the midtones keep their colour. No grain, no dither, no noise is added to
     this frame anywhere. */
  col = max(col, vec3(0.0));
  col = col * (1.0 + col * 0.42) / (1.0 + col);      // highlight roll-off
  col = col * 0.94 + 0.030;                          // shadow lift
  col = (col - 0.5) * 1.06 + 0.5;                    // gentle contrast
  float lum2 = dot(col, vec3(0.299, 0.587, 0.114));
  col = mix(vec3(lum2), col, 1.14);                  // a little more colour
  col = max(col, vec3(0.0));

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
    // Speed lines start around 200 and build smoothly; the edge streak waits
    // until 300+ and stays gentle. Neither ever touches the middle of frame.
    u.uBlur.value = Math.max(0, (t - 0.60) / 0.40) * 0.055 * (s.motionBlur ?? 1);
    u.uLines.value = Math.max(0, (t - 0.40) / 0.60) * 0.85 * (s.speedLines ?? 1);
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

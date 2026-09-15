/**
 * Sky, sun and lighting. Flat graphic sky with a halftone horizon band —
 * it keeps the silhouette of the city readable at any speed.
 */

import * as THREE from '../../lib/three.module.js';
import { PALETTE } from './Materials.js';

const SKY_VERT = `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}`;

const SKY_FRAG = `
varying vec3 vDir;
uniform vec3 uTop;
uniform vec3 uMid;
uniform vec3 uHorizon;
uniform vec3 uSun;
uniform float uTime;

float halftone(vec2 uv, float scale, float amt) {
  vec2 g = fract(uv * scale) - 0.5;
  return step(length(g), amt * 0.62);
}

void main() {
  float h = clamp(vDir.y * 0.5 + 0.5, 0.0, 1.0);
  vec3 col = mix(uHorizon, uMid, smoothstep(0.48, 0.63, h));
  col = mix(col, uTop, smoothstep(0.6, 0.98, h));

  // Sun disc + hard graphic rays.
  float d = dot(normalize(vDir), normalize(uSun));
  col = mix(col, vec3(1.0, 0.96, 0.82), smoothstep(0.9975, 0.9990, d));
  col += vec3(0.30, 0.24, 0.10) * pow(max(d, 0.0), 42.0);

  // Halftone band just above the horizon.
  vec2 uv = vec2(atan(vDir.z, vDir.x) * 1.6, vDir.y * 6.0);
  float band = smoothstep(0.58, 0.50, h) * smoothstep(0.42, 0.50, h);
  col = mix(col, col * 0.86, halftone(uv, 26.0, band * 1.6) * band);

  gl_FragColor = vec4(col, 1.0);
}`;

export class Sky {
  constructor(scene) {
    this.scene = scene;
    this.sunDir = new THREE.Vector3(0.42, 0.74, 0.52).normalize();

    const geo = new THREE.SphereGeometry(8000, 32, 20);
    this.material = new THREE.ShaderMaterial({
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
      uniforms: {
        uTop: { value: new THREE.Color(0x16324f) },
        uMid: { value: new THREE.Color(0x3d7fa8) },
        uHorizon: { value: new THREE.Color(0xc9d7dd) },
        uSun: { value: this.sunDir.clone() },
        uTime: { value: 0 },
      },
    });
    this.mesh = new THREE.Mesh(geo, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -1000;
    scene.add(this.mesh);

    scene.fog = new THREE.Fog(0xb9c8d0, 1800, 6800);
    scene.background = new THREE.Color(0xb9c8d0);

    /* ------------------------------------------------------------ lights */
    this.hemi = new THREE.HemisphereLight(0xcfe3f0, 0x2a2b30, 1.0);
    scene.add(this.hemi);

    this.sun = new THREE.DirectionalLight(0xfff3d6, 2.0);
    this.sun.position.copy(this.sunDir).multiplyScalar(900);
    this.sun.castShadow = true;
    const s = this.sun.shadow;
    s.mapSize.set(2048, 2048);
    s.camera.near = 50;
    s.camera.far = 2600;
    s.camera.left = -620; s.camera.right = 620;
    s.camera.top = 620; s.camera.bottom = -620;
    s.bias = -0.0016;
    s.normalBias = 2.2;
    scene.add(this.sun);
    scene.add(this.sun.target);

    this.fill = new THREE.DirectionalLight(0x8fb4d8, 0.4);
    this.fill.position.set(-0.5, 0.35, -0.7).multiplyScalar(500);
    scene.add(this.fill);

    this._buildClouds();
    this._buildHorizon();
  }

  /**
   * The playable map is 5.2 km across; past its edge there was nothing but sky.
   * This puts a ground plane and a ring of far-off towers out there so the
   * district reads as part of a city rather than a diorama on a table.
   */
  _buildHorizon() {
    const g = new THREE.Group();

    // Sits below the lowest edge terrain so it can never poke through a dip.
    const ground = new THREE.Mesh(
      new THREE.RingGeometry(2450, 9000, 64, 1),
      new THREE.MeshBasicMaterial({ color: 0x8e9aa4, fog: true }),
    );
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -60;
    g.add(ground);

    // Distant skyline: two rings of flat blocks, fogged nearly to nothing.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    let seed = 12345;
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
    for (const [radius, count, scale, color] of [[3300, 90, 1.0, 0x6d7a88], [5200, 70, 1.8, 0x8794a2]]) {
      const im = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color, fog: true }), count);
      const m = new THREE.Matrix4();
      for (let i = 0; i < count; i++) {
        const a = (i / count) * Math.PI * 2 + rnd() * 0.05;
        const r = radius + (rnd() - 0.5) * radius * 0.22;
        const h = (140 + rnd() * 520) * scale;
        const w = (90 + rnd() * 180) * scale;
        m.makeScale(w, h, w);
        m.setPosition(Math.cos(a) * r, h / 2 - 20, Math.sin(a) * r);
        im.setMatrixAt(i, m);
      }
      im.instanceMatrix.needsUpdate = true;
      g.add(im);
    }
    this.horizon = g;
    this.scene.add(g);
  }

  /**
   * Cheap environment map. Without one, a metalness-0.9 katana reflects nothing
   * and reads as a black stick. This gives every blade a sky and a ground to
   * catch, which is most of why they look like steel.
   */
  buildEnvironment(renderer) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    const grd = g.createLinearGradient(0, 0, 0, 128);
    grd.addColorStop(0.00, '#20415f');
    grd.addColorStop(0.42, '#8fb9cf');
    grd.addColorStop(0.50, '#dfe7ea');
    grd.addColorStop(0.58, '#5a5f68');
    grd.addColorStop(1.00, '#191b20');
    g.fillStyle = grd; g.fillRect(0, 0, 256, 128);
    // A hot spot where the sun is, so blades catch a highlight as they swing.
    const sx = (Math.atan2(this.sunDir.z, this.sunDir.x) / (Math.PI * 2) + 0.5) * 256;
    const sy = (1 - (this.sunDir.y * 0.5 + 0.5)) * 128;
    const sun = g.createRadialGradient(sx, sy, 0, sx, sy, 40);
    sun.addColorStop(0, 'rgba(255,248,224,1)');
    sun.addColorStop(1, 'rgba(255,248,224,0)');
    g.fillStyle = sun; g.fillRect(sx - 40, sy - 40, 80, 80);

    const tex = new THREE.CanvasTexture(c);
    tex.mapping = THREE.EquirectangularReflectionMapping;
    tex.colorSpace = THREE.SRGBColorSpace;
    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();
    const rt = pmrem.fromEquirectangular(tex);
    this.scene.environment = rt.texture;
    this.scene.environmentIntensity = 0.75;
    tex.dispose();
    pmrem.dispose();
  }

  _buildClouds() {
    const c = document.createElement('canvas');
    c.width = c.height = 256;
    const g = c.getContext('2d');
    g.clearRect(0, 0, 256, 256);
    g.fillStyle = 'rgba(255,255,255,0.92)';
    for (let i = 0; i < 16; i++) {
      const x = 40 + Math.random() * 176, y = 90 + Math.random() * 76;
      const r = 26 + Math.random() * 44;
      g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
    }
    g.globalCompositeOperation = 'destination-out';
    for (let i = 0; i < 40; i++) {
      g.beginPath();
      g.arc(Math.random() * 256, 150 + Math.random() * 120, 10 + Math.random() * 30, 0, Math.PI * 2);
      g.fill();
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;

    this.clouds = new THREE.Group();
    const mat = new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, fog: false, opacity: 0.85 });
    for (let i = 0; i < 14; i++) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), mat);
      const a = (i / 14) * Math.PI * 2 + Math.random();
      const r = 2600 + Math.random() * 1800;
      const sc = 900 + Math.random() * 1400;
      m.position.set(Math.cos(a) * r, 760 + Math.random() * 700, Math.sin(a) * r);
      m.scale.set(sc, sc * 0.42, 1);
      m.userData.speed = 4 + Math.random() * 7;
      this.clouds.add(m);
    }
    this.clouds.renderOrder = -900;
    this.scene.add(this.clouds);
  }

  /** Keep the sky centred on the camera and the shadow box on the player. */
  update(dt, camera, focus) {
    this.mesh.position.copy(camera.position);
    this.clouds.position.set(camera.position.x, 0, camera.position.z);
    for (const c of this.clouds.children) {
      c.lookAt(camera.position.x, c.position.y + camera.position.y * 0.0, camera.position.z);
      c.position.x += c.userData.speed * dt;
      if (c.position.x > 4600) c.position.x = -4600;
    }
    this.sun.target.position.set(focus.x, focus.y, focus.z);
    this.sun.position.set(focus.x + this.sunDir.x * 900, focus.y + this.sunDir.y * 900, focus.z + this.sunDir.z * 900);
    this.material.uniforms.uTime.value += dt;
  }
}

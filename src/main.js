/**
 * [MACH] — entry point.
 *
 * Wiring only: this file owns the render loop, the state machine (MENU /
 * PLAYING / PAUSED), and the mapping from authoritative events to feedback.
 * Rules live in src/shared, look lives in src/world + src/fx, meta lives in
 * src/economy. Nothing here decides a hit.
 */

import * as THREE from '../lib/three.module.js';

import { CFG, speedT, damageForSpeed } from './core/Config.js';
import { clamp, clamp01, lerp, damp, formatNum } from './core/Util.js';
import { Input } from './core/Input.js';

import { buildWorld } from './shared/WorldData.js';
import { WSTATE, isVulnerable } from './shared/Combat.js';
import { GSTATE, findAnchor } from './shared/Grapple.js';

import { LoopbackTransport, WebSocketTransport, BOT_NAMES } from './net/Transport.js';
import { GameState } from './game/GameState.js';
import { Avatar } from './game/Avatar.js';
import { CameraRig } from './game/CameraRig.js';

import { WorldView } from './world/WorldView.js';
import { Sky } from './world/Sky.js';
import { PALETTE } from './world/Materials.js';

import { PostFX } from './fx/PostFX.js';
import { WindField, SpeedTrail, GroundWake } from './fx/SpeedFX.js';
import { CombatFX, BladeTrail } from './fx/CombatFX.js';
import { GrappleFX } from './fx/GrappleFX.js';

import { AudioSystem } from './audio/Audio.js';
import { Profile } from './economy/Profile.js';
import { KATANAS, SKINS, TRAILS, SLASHES, KILLS, SPAWNS, SHEATHS, getItem } from './economy/Cosmetics.js';

import { HUD } from './ui/HUD.js';
import { StatScreen } from './ui/StatScreen.js';
import { Menu } from './ui/Menu.js';
import { CrateUI } from './ui/CrateUI.js';

const STATE = { BOOT: 0, MENU: 1, PLAYING: 2, PAUSED: 3, CRATES: 4 };

class Game {
  constructor() {
    this.canvas = document.getElementById('view');
    this.ui = document.getElementById('ui');
    this.state = STATE.BOOT;
    this.clock = new THREE.Clock();
    this.inputAcc = 0;
    this.avatars = new Map();
    this.match = null;
    this._cmd = { seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, sprint: false, jump: false, attack: false, sheathe: false };
    this._v = new THREE.Vector3();
    this._tip = new THREE.Vector3();
    this._base = new THREE.Vector3();
    this._selfPos = new THREE.Vector3();
    this.lastTurn = 0;
    this.prevYaw = 0;
  }

  /* ---------------------------------------------------------------- boot */

  async boot() {
    const loading = document.getElementById('loading');
    const step = (t, p) => {
      document.getElementById('load-text').textContent = t;
      document.getElementById('load-bar').style.width = p + '%';
      return new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
    };

    await step('INITIALISING RENDERER', 8);
    // Try for the good context, then walk down. Some drivers (and every
    // software rasteriser) refuse MSAA, and a game that fails to start is
    // worse than a game without antialiasing.
    const attempts = [
      { antialias: true, powerPreference: 'high-performance', stencil: false },
      { antialias: false, powerPreference: 'high-performance', stencil: false },
      { antialias: false },
    ];
    let lastErr = null;
    for (const opts of attempts) {
      try {
        this.renderer = new THREE.WebGLRenderer({ canvas: this.canvas, ...opts });
        break;
      } catch (e) { lastErr = e; }
    }
    if (!this.renderer) {
      throw new Error('WebGL is unavailable in this browser. ' + (lastErr?.message || ''));
    }
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    // No tone mapping: this is a flat graphic look and ACES would mute the
    // yellows and cyans that carry it. Grading happens in the post pass.
    this.renderer.toneMapping = THREE.NoToneMapping;

    this.scene = new THREE.Scene();
    // A generous near plane (the camera never gets closer than 14 units to the
    // runner) buys depth precision, which the outline pass spends.
    this.camera = new THREE.PerspectiveCamera(CFG.CAM_FOV, window.innerWidth / window.innerHeight, 5, 9000);

    await step('GENERATING MERIDIAN DISTRICT', 24);
    this.world = buildWorld(1337);

    await step('BUILDING THE CITY', 42);
    this.worldView = new WorldView(this.scene, this.world);
    this.sky = new Sky(this.scene);
    this.sky.buildEnvironment(this.renderer);

    await step('LOADING PROFILE', 60);
    this.profile = new Profile();
    this.audio = new AudioSystem(this.profile.settings);

    await step('WIRING EFFECTS', 72);
    this.post = new PostFX(this.renderer, this.scene, this.camera);
    this.combatFX = new CombatFX(this.scene, this.camera, this.ui);
    this.grappleFX = new GrappleFX(this.scene, this.camera);
    this.wind = new WindField(this.scene);
    this.wake = new GroundWake(this.combatFX.smoke);
    this.rig = new CameraRig(this.camera, this.world, this.profile);

    await step('BUILDING INTERFACE', 86);
    this.input = new Input(this.canvas);
    this.input.sensitivity = CFG.MOUSE_SENS * (this.profile.settings.sensitivity ?? 1);
    this.input.invertY = !!this.profile.settings.invertY;
    this.hud = new HUD(this.ui);
    this.statScreen = new StatScreen(this.ui, this.profile);
    this.menu = new Menu(this.ui, this.profile, this.audio);
    this.crateUI = new CrateUI(this.ui, this.profile, this.audio);
    this.pause = this._buildPause();
    this._wireUI();

    await step('PREPARING PREVIEW', 95);
    this._buildPreview();

    await step('READY', 100);
    window.addEventListener('resize', () => this.resize());
    this.resize();

    loading.classList.add('done');
    setTimeout(() => loading.remove(), 700);
    this.setState(STATE.MENU);
    this.renderer.setAnimationLoop((t) => this.frame(t));
  }

  /* ------------------------------------------------------------ preview */

  _buildPreview() {
    this.preview = new THREE.Scene();
    this.preview.background = null;
    const hemi = new THREE.HemisphereLight(0xdceaf5, 0x1a1c22, 1.5);
    this.preview.add(hemi);
    const key = new THREE.DirectionalLight(0xfff2da, 2.6);
    key.position.set(30, 50, 40);
    this.preview.add(key);
    const rim = new THREE.DirectionalLight(0x22c6e8, 1.6);
    rim.position.set(-40, 20, -30);
    this.preview.add(rim);
    // Aimed to the RIGHT of the runner so they stand in the left third of the
    // frame, with the menu slabs occupying the space they leave. Pulled back
    // far enough to keep the whole figure, katana included, inside the frame.
    this.previewCam = new THREE.PerspectiveCamera(32, 1, 1, 400);
    this.previewCam.position.set(16, 15, 96);
    this.previewCam.lookAt(16, 11, 0);
    this.previewSpin = 0;
    this._refreshPreviewAvatar();
  }

  _refreshPreviewAvatar() {
    if (this.previewAvatar) this.previewAvatar.dispose();
    const L = this.profile.loadout;
    this.previewAvatar = new Avatar(getItem('skin', L.skin), getItem('katana', L.katana), getItem('sheath', L.sheath));
    this.previewAvatar.root.position.set(-8, 0, 0);
    this.preview.add(this.previewAvatar.root);
    this.previewState = {
      speed: 0, grounded: true, yaw: 0, pitch: 0,
      combatState: WSTATE.SHEATHED, phase: 0, swingIndex: 0, attackType: 1, alive: true,
    };
  }

  /* ----------------------------------------------------------- UI wiring */

  _buildPause() {
    const el = document.createElement('div');
    el.className = 'pause hidden';
    el.innerHTML = `
      <div class="pause-box">
        <div class="pause-title">PAUSED</div>
        <button class="btn primary" data-a="resume">RESUME</button>
        <button class="btn ghost" data-a="settings">SETTINGS</button>
        <button class="btn ghost" data-a="quit">LEAVE MATCH</button>
        <div class="pause-hint">ESC to resume</div>
      </div>`;
    this.ui.appendChild(el);
    el.addEventListener('click', (e) => {
      const a = e.target.dataset?.a;
      if (!a) return;
      this.audio.ui('click');
      if (a === 'resume') this.resumeMatch();
      if (a === 'settings') this.menu.showSettings();
      if (a === 'quit') this.endMatch();
    });
    return el;
  }

  _wireUI() {
    this.menu.on('play', () => this.startMatch());
    this.menu.on('locker', () => this.menu.showLocker());
    this.menu.on('crates', () => this.setState(STATE.CRATES));
    this.menu.on('stats', () => this.menu.showCareer());
    this.menu.on('openSettings', () => this.menu.showSettings());
    this.menu.on('loadout', () => {
      this._refreshPreviewAvatar();
      if (this.state === STATE.PLAYING || this.state === STATE.PAUSED) this._applyLocalLoadout();
    });

    this.crateUI.on('exit', () => this.setState(STATE.MENU));
    this.crateUI.on('unboxed', () => this.menu.refresh());

    // Settings changes propagate live.
    this.menu.on('settings', (s) => {
      this.input.sensitivity = CFG.MOUSE_SENS * (s.sensitivity ?? 1);
      this.input.invertY = !!s.invertY;
      this.audio.applySettings(s);
    });

    this.input.on('keydown', (code) => {
      if (code === 'Escape') {
        if (this.state === STATE.PLAYING) this.pauseMatch();
        else if (this.state === STATE.PAUSED) this.resumeMatch();
        else if (this.state === STATE.CRATES && !this.crateUI.busy) this.setState(STATE.MENU);
      }
      if (code === 'Tab' && this.state === STATE.PLAYING) this.statScreen.show(true);
    });
    this.input.on('keyup', (code) => {
      if (code === 'Tab') this.statScreen.show(false);
    });
    this.input.on('lockchange', (locked) => {
      if (!locked && this.state === STATE.PLAYING) this.pauseMatch();
    });

    document.addEventListener('click', () => { this.audio.init(); this.audio.resume(); }, { once: true });
  }

  setState(s) {
    this.state = s;
    const menu = s === STATE.MENU;
    this.menu.el.classList.toggle('hidden', !menu);
    if (menu) this.menu.refresh();
    this.crateUI.el.classList.toggle('hidden', s !== STATE.CRATES);
    if (s === STATE.CRATES) this.crateUI.show();
    this.hud.setVisible(s === STATE.PLAYING || s === STATE.PAUSED);
    this.pause.classList.toggle('hidden', s !== STATE.PAUSED);
    if (s !== STATE.PLAYING) this.statScreen.show(false);
    document.body.classList.toggle('in-game', s === STATE.PLAYING || s === STATE.PAUSED);
  }

  /* -------------------------------------------------------------- match */

  async startMatch() {
    this.audio.init();
    this.audio.resume();
    this.menu.closePanel();

    const params = new URLSearchParams(location.search);
    const server = params.get('server');
    const botCount = clamp(parseInt(params.get('bots') ?? '5', 10) || 5, 0, 9);

    let transport;
    if (server) {
      transport = new WebSocketTransport(server);
      this.hud.setNet('CONNECTING…');
    } else {
      transport = new LoopbackTransport(this.world, { bots: botCount, skill: [0.45, 0.95], names: BOT_NAMES });
    }
    this.transport = transport;

    this.gameState = new GameState(this.world, transport);
    try {
      await this.gameState.join(this.profile.name);
    } catch (e) {
      this.hud.setNet('CONNECTION FAILED — RUNNING LOCAL');
      this.transport = new LoopbackTransport(this.world, { bots: botCount, skill: [0.45, 0.95], names: BOT_NAMES });
      this.gameState = new GameState(this.world, this.transport);
      await this.gameState.join(this.profile.name);
    }

    this._wireGameEvents();
    this.match = {
      kills: 0, deaths: 0, damageDealt: 0, damageTaken: 0, hits: 0, swings: 0,
      topSpeed: 0, bestHit: 0, bestHitSpeed: 0, streak: 0, bestStreak: 0, time: 0, distance: 0,
    };
    this.matchCredits = 0;
    this.killerName = '';

    this._applyLocalLoadout();
    this.input.yaw = this.gameState.self.yaw;
    this.input.pitch = 0;
    this.setState(STATE.PLAYING);
    this.input.requestLock();
    this.audio.setMusic(true);
    this.hud.showBanner('GO', 'go', 1.2);
    this.hud.pushFeed('MATCH LIVE &middot; FIRST TO OUTRUN EVERYONE', 'sys');
  }

  pauseMatch() {
    if (this.state !== STATE.PLAYING) return;
    this.setState(STATE.PAUSED);
    this.input.releaseLock();
    this.input.enabled = false;
  }

  resumeMatch() {
    if (this.state !== STATE.PAUSED) return;
    this.menu.closePanel();
    this.setState(STATE.PLAYING);
    this.input.enabled = true;
    this.input.requestLock();
  }

  endMatch() {
    if (this.match) this.profile.recordMatch(this.match);
    for (const [, a] of this.avatars) this._disposeAvatar(a);
    this.avatars.clear();
    this.transport?.close();
    this.gameState = null;
    this.transport = null;
    this.match = null;
    this.input.enabled = true;
    this.input.releaseLock();
    this.menu.closePanel();
    this.setState(STATE.MENU);
  }

  _applyLocalLoadout() {
    const a = this.avatars.get(this.gameState?.selfId);
    if (a) { this._disposeAvatar(a); this.avatars.delete(this.gameState.selfId); }
  }

  /* -------------------------------------------------------------- events */

  _wireGameEvents() {
    const G = this.gameState;
    const selfId = () => G.selfId;

    G.on('localSwing', ({ type }) => {
      this.match.swings++;
      this.audio.swing(G.self.move.speed, G.self.move.pos, type === 1);
      this.rig.addKick(0.12 + speedT(G.self.move.speed) * 0.2);
    });
    G.on('localWhiff', () => {
      this.audio.whiff(G.self.move.pos);
      this.hud.setStatus('MISSED — RECOVERING', 'bad');
      setTimeout(() => this.hud.setStatus(''), 520);
    });
    G.on('localDraw', () => this.audio.draw(G.self.move.pos));
    G.on('localSheathe', () => this.audio.sheathe(G.self.move.pos));
    G.on('localJump', () => this.audio.jump(G.self.move.pos));
    G.on('localLand', (e) => {
      this.audio.land(e.landSpeed, G.self.move.pos);
      this.rig.land(e.landSpeed);
      this.avatars.get(G.selfId)?.avatar.land(e.landSpeed);
      // Dust scales with the landing, but a gentle touchdown gets nothing.
      if (e.landSpeed > 120) this.wake.burst(G.self.move.pos, e.landSpeed, G.self.move.groundKind);
    });

    G.on('localGrappleFire', ({ hit }) => {
      this.audio.grappleFire(G.self.move.pos, hit);
      this.rig.grappleFire();
      if (!hit) {
        this.hud.setStatus('NO ANCHOR', 'bad');
        setTimeout(() => this.hud.setStatus(''), 420);
      }
    });
    G.on('localGrappleHook', ({ g }) => {
      this.audio.grappleHit({ x: g.ax, y: g.ay, z: g.az });
      this.rig.grappleHook();
      this._grappleBite(g);
    });
    G.on('localGrappleRelease', ({ speed }) => {
      this.audio.grappleRelease(G.self.move.pos, speed);
      this.rig.grappleRelease();
    });

    G.on('event', (ev) => {
      switch (ev.t) {
        case 'hit': this._onHit(ev, selfId()); break;
        case 'kill': this._onKill(ev, selfId()); break;
        case 'spawn': this._onSpawn(ev); break;
        case 'swing': if (ev.id !== selfId()) this._remoteSwing(ev); break;
        case 'whiff': break;
        case 'draw': if (ev.id !== selfId()) this.audio.draw(this._entPos(ev.id)); break;
        case 'sheathe': if (ev.id !== selfId()) this.audio.sheathe(this._entPos(ev.id)); break;
        case 'land': if (ev.id !== selfId() && ev.v > 180) this.audio.land(ev.v, this._entPos(ev.id)); break;
        case 'credits':
          if (ev.id === selfId()) {
            this.profile.addCredits(ev.c);
            this.matchCredits += ev.c;
          }
          break;
        case 'block':
          this.combatFX.blocked(new THREE.Vector3(ev.x, ev.y, ev.z));
          break;
        case 'gfire':
          if (ev.id !== selfId()) this.audio.grappleFire(this._entPos(ev.id), ev.hit);
          break;
        case 'ghook':
          if (ev.id !== selfId()) {
            this.audio.grappleHit({ x: ev.x, y: ev.y, z: ev.z });
            this._grappleBite(ev);
          }
          break;
        case 'grelease':
          if (ev.id !== selfId()) this.audio.grappleRelease(this._entPos(ev.id), ev.s || 0);
          break;
      }
    });
  }

  /** Chips and dust where the hook bites. */
  _grappleBite(g) {
    const pos = new THREE.Vector3(g.ax, g.ay, g.az);
    const c = new THREE.Color(0xd8dee8);
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      this.combatFX.sparks.emit({
        x: pos.x, y: pos.y, z: pos.z,
        vx: Math.cos(a) * (40 + Math.random() * 90),
        vy: Math.random() * 90,
        vz: Math.sin(a) * (40 + Math.random() * 90),
        color: c, size: 9 + Math.random() * 10, life: 0.24 + Math.random() * 0.2,
        gravity: 260, drag: 2.4, alpha: 1,
      });
    }
    this.combatFX.smoke.emit({
      x: pos.x, y: pos.y, z: pos.z, color: new THREE.Color(0x9aa2ad),
      size: 26, life: 0.4, gravity: -30, drag: 3, grow: 60, alpha: 0.5,
    });
  }

  _entPos(id) {
    const e = this.gameState.entities.get(id);
    if (!e) return this.camera.position;
    return e.remote ? e.render : e.move.pos;
  }

  _onHit(ev, selfId) {
    const pos = new THREE.Vector3(ev.x, ev.y, ev.z);
    const t = clamp01(ev.s / CFG.MAX_SPEED);
    const attackerSlash = ev.a === selfId
      ? getItem('slash', this.profile.loadout.slash)
      : this._remoteCosmetic(ev.a, 'slash');
    const yaw = this.gameState.entities.get(ev.a)?.render?.yaw ?? this.gameState.self.yaw;

    this.combatFX.impact(pos, ev.d, t, attackerSlash, yaw);

    const av = this.avatars.get(ev.v);
    if (av) av.avatar.takeHit();

    if (ev.a === selfId) {
      this.match.hits++;
      this.match.damageDealt += ev.d;
      if (ev.d > this.match.bestHit) { this.match.bestHit = ev.d; this.match.bestHitSpeed = ev.s; }
      this.hud.hit(ev.d);

      // HIGH-SPEED HIT: strictly above 350 speed, attacker only, 0.3 s exactly.
      const heavy = this.rig.impact(ev.s);
      if (heavy) {
        this.audio.impactHeavy(ev.d, ev.s, pos);
        this.hud.highSpeedHit(ev.s, ev.d);
        this.combatFX.heavyImpact(pos, ev.s, attackerSlash, yaw);
      } else {
        this.audio.impact(ev.d, ev.s, pos, true);
        this.rig.addKick(0.22 + t * 0.3);
      }

      if (this.profile.settings.showDamage) this.combatFX.numbers.spawn(pos, ev.d, { speed: ev.s });
      if (ev.d >= 200) this.hud.showBanner(`${Math.round(ev.d)} — AT ${ev.s}`, 'huge', 1.5);
    } else {
      this.audio.impact(ev.d, ev.s, pos, false);
    }
    if (ev.v === selfId) {
      this.match.damageTaken += ev.d;
      this.post.addHurt(0.35 + t * 0.5);
      this.rig.addShake(0.4 + t * 0.9);
      if (this.profile.settings.showDamage) this.combatFX.numbers.spawn(pos, ev.d, { taken: true });
      this.killerName = this.gameState.entities.get(ev.a)?.name || '';
    }
  }

  _onKill(ev, selfId) {
    const pos = new THREE.Vector3(ev.x, ev.y, ev.z);
    const killDef = ev.a === selfId ? getItem('kill', this.profile.loadout.kill) : this._remoteCosmetic(ev.a, 'kill');
    this.combatFX.killEffect(pos, killDef);

    // ASCII-safe separator: the kill feed must render on every system font.
    const line = `<b>${ev.an}</b> <i>&#10005;</i> <span>${ev.vn}</span> <em>${ev.s}</em>`;
    this.hud.pushFeed(line, ev.a === selfId ? 'mine' : ev.v === selfId ? 'death' : '');

    if (ev.a === selfId) {
      this.match.kills++;
      this.match.streak = ev.streak;
      this.match.bestStreak = Math.max(this.match.bestStreak, ev.streak);
      this.audio.killConfirm();
      this.hud.showBanner(ev.streak > 1 ? `${ev.streak} IN A ROW` : 'ELIMINATED', 'kill', 1.6);
      this.post.addFlash(0xffffff, 0.14);
    }
    if (ev.v === selfId) {
      this.match.deaths++;
      this.audio.death();
      this.post.addHurt(1.0);
      this.rig.addShake(1.4);
      this.killerName = ev.an;
    }
  }

  _onSpawn(ev) {
    const def = ev.id === this.gameState.selfId
      ? getItem('spawn', this.profile.loadout.spawn)
      : this._remoteCosmetic(ev.id, 'spawn');
    this.combatFX.spawnEffect(new THREE.Vector3(ev.x, ev.y, ev.z), def);
  }

  _remoteSwing(ev) {
    const pos = this._entPos(ev.id);
    this.audio.swing(ev.s || 0, pos, ev.a === 1);
  }

  /** Remote loadouts are not transmitted; derive a stable set from the id. */
  _remoteCosmetic(id, type) {
    const tables = { katana: KATANAS, skin: SKINS, trail: TRAILS, slash: SLASHES, kill: KILLS, spawn: SPAWNS, sheath: SHEATHS };
    const list = Object.values(tables[type]);
    const h = Math.abs(Math.imul(id | 0, 2654435761)) % list.length;
    return list[h];
  }

  /* ------------------------------------------------------------- avatars */

  _ensureAvatar(ent) {
    let a = this.avatars.get(ent.id);
    if (a) return a;
    const local = ent.id === this.gameState.selfId;
    const pick = (type) => (local ? getItem(type, this.profile.loadout[type]) : this._remoteCosmetic(ent.id, type));
    const avatar = new Avatar(pick('skin'), pick('katana'), pick('sheath'), { local });
    this.scene.add(avatar.root);
    const trail = new SpeedTrail(this.scene, pick('trail'));
    const blade = new BladeTrail(this.scene, pick('slash').spec.color);
    a = { avatar, trail, blade, id: ent.id, local, lastStep: 0, footPhase: 0 };
    this.avatars.set(ent.id, a);
    return a;
  }

  _disposeAvatar(a) {
    a.avatar.dispose();
    a.trail.dispose();
    a.blade.dispose();
  }

  /* --------------------------------------------------------------- frame */

  resize() {
    const w = window.innerWidth, h = window.innerHeight;
    this.renderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.post.setSize(w, h);
    this.previewCam.aspect = w / h;
    this.previewCam.updateProjectionMatrix();
  }

  frame() {
    const dt = Math.min(this.clock.getDelta(), 0.1);
    if (this.state === STATE.MENU || this.state === STATE.CRATES) return this._frameMenu(dt);
    if (!this.gameState) return;
    this._frameGame(dt);
  }

  _frameMenu(dt) {
    // Slow orbit of the district behind the menu — the map sells itself.
    this.menuT = (this.menuT || 0) + dt * 0.033;
    const a = this.menuT, r = 940;
    this.camera.position.set(Math.cos(a) * r, 250 + Math.sin(a * 0.8) * 70, Math.sin(a) * r);
    this.camera.lookAt(0, 150, 0);
    if (this.camera.fov !== 50) { this.camera.fov = 50; this.camera.updateProjectionMatrix(); }
    this.sky.update(dt, this.camera, { x: 0, y: 0, z: 0 });

    this.previewSpin += dt * 0.35;
    const av = this.previewAvatar;
    av.root.rotation.y = Math.sin(this.previewSpin) * 0.5 + 0.30;
    this.previewState.speed = 16 + Math.sin(this.previewSpin * 0.8) * 12;
    // Idle showcase: every few seconds, an iai draw-cut and back to the saya.
    this._previewTimer = (this._previewTimer || 0) + dt;
    if (this._previewTimer > 5.5) {
      this._previewTimer = 0;
      this._previewSwing = 0;
    }
    if (this._previewSwing !== undefined) {
      this._previewSwing += dt;
      const s = this._previewSwing;
      const P = this.previewState;
      if (s < 0.34) { P.combatState = WSTATE.WINDUP; P.phase = s / 0.34; }
      else if (s < 0.48) { P.combatState = WSTATE.ACTIVE; P.phase = (s - 0.34) / 0.14; }
      else if (s < 1.5) { P.combatState = WSTATE.RECOVER; P.phase = (s - 0.48) / 1.02; }
      else if (s < 2.1) { P.combatState = WSTATE.SHEATHING; P.phase = (s - 1.5) / 0.6; }
      else { P.combatState = WSTATE.SHEATHED; P.phase = 0; this._previewSwing = undefined; }
    }
    av.update(dt, this.previewState);

    this.renderer.setRenderTarget(null);
    this.renderer.clear();
    this.renderer.render(this.scene, this.camera);   // city as a backdrop
    this.renderer.autoClear = false;
    this.renderer.clearDepth();
    this.renderer.render(this.preview, this.previewCam);
    this.renderer.autoClear = true;
  }

  _frameGame(dt) {
    const G = this.gameState;
    const S = G.self;

    /* ---- fixed-rate input + prediction ---- */
    const step = 1 / CFG.TICK_RATE;
    this.inputAcc = Math.min(this.inputAcc + dt, 0.2);
    while (this.inputAcc >= step) {
      this.inputAcc -= step;
      if (this.state === STATE.PLAYING) this.input.sample(this._cmd);
      else { this._cmd.mx = 0; this._cmd.mz = 0; this._cmd.jump = false; this._cmd.attack = false; this._cmd.sheathe = false; this._cmd.sprint = false; this._cmd.yaw = this.input.yaw; this._cmd.pitch = this.input.pitch; }
      G.applyInput(this._cmd, step);
    }
    G.update(dt);

    const speed = S.move.speed;
    const t = speedT(speed);
    this.match.time += dt;
    this.match.topSpeed = Math.max(this.match.topSpeed, speed);
    this.match.distance += speed * dt;

    G.selfRenderPos(this._selfPos);

    /* ---- camera ---- */
    let turnRate = this.input.yaw - this.prevYaw;
    if (turnRate > Math.PI) turnRate -= Math.PI * 2;
    if (turnRate < -Math.PI) turnRate += Math.PI * 2;
    this.prevYaw = this.input.yaw;
    this.lastTurn = damp(this.lastTurn, turnRate / Math.max(dt, 1e-3), 8, dt);

    const G_ = S.grapple;
    const grappling = G_.state === GSTATE.ATTACHED;
    let ropeSide = 0;
    if (grappling) {
      const rx = G_.ax - this._selfPos.x, rz = G_.az - this._selfPos.z;
      ropeSide = (rx * Math.cos(this.input.yaw) - rz * Math.sin(this.input.yaw)) / Math.max(1, Math.hypot(rx, rz));
    }

    this.rig.update(dt, this._selfPos, this.input.yaw, this.input.pitch, speed, {
      velX: S.move.vel.x, velZ: S.move.vel.z, velY: S.move.vel.y,
      turnRate: clamp(this.lastTurn * 0.1, -1, 1),
      grappling, ropeSide,
    });

    // Render-only hit-stop: the authority keeps ticking at full rate, only the
    // animation and effect clocks briefly slow for the impact.
    const adt = this.rig.consumeHitStop(dt);

    /* ---- avatars ---- */
    for (const ent of G.entities.values()) {
      const a = this._ensureAvatar(ent);
      const local = ent.id === G.selfId;
      const pos = local ? this._selfPos : ent.render;
      const yaw = local ? S.yaw : ent.render.yaw;
      const sp = local ? speed : ent.render.speed;
      const alive = local ? S.alive : ent.alive;

      a.avatar.root.visible = alive;
      a.avatar.root.position.set(pos.x, pos.y, pos.z);
      a.avatar.root.rotation.y = yaw;
      // Bank into the turn — a motorcycle cue for a runner with no brakes.
      const bank = local ? clamp(this.lastTurn * 0.012 * speedT(sp), -0.32, 0.32) : 0;
      a.avatar.root.rotation.z = damp(a.avatar.root.rotation.z, bank, 6, dt);

      const cs = local ? S.combat.state : ent.combatState;
      const phase = local ? S.combat.phase : ent.phase;
      const grap = local ? S.grapple : ent.grapple;
      a.avatar.update(adt, {
        speed: sp,
        grounded: local ? S.move.grounded : ent.grounded,
        yaw, pitch: local ? S.pitch : ent.render.pitch,
        combatState: cs,
        phase,
        swingIndex: local ? S.combat.swingIndex : ent.swingIndex,
        attackType: local ? S.combat.attackType : ent.attackType,
        velY: local ? S.move.vel.y : 0,
        turnRate: local ? clamp(this.lastTurn * 0.1, -1, 1) : 0,
        grapple: grap,
        alive,
      });

      // Cable + hook, for everyone.
      if (alive && grap && grap.state !== GSTATE.IDLE) this.grappleFX.show(ent.id, grap, a.avatar);
      else this.grappleFX.hide(ent.id);

      // Blade trail while the cut is live.
      const swinging = cs === WSTATE.WINDUP || cs === WSTATE.ACTIVE || (cs === WSTATE.RECOVER && phase < 0.3);
      if (swinging && alive) {
        a.avatar.bladePoints(this._tip, this._base);
        a.blade.push(this._tip, this._base);
      }
      a.blade.update(dt, swinging && alive);

      const vel = local ? S.move.vel : { x: -Math.sin(yaw) * sp, y: 0, z: -Math.cos(yaw) * sp };
      if (alive) a.trail.update(dt, pos, vel, sp, this.combatFX.sparks);
      else a.trail.mesh.visible = false;

      // Footsteps.
      if (alive && (local ? S.move.grounded : ent.grounded) && sp > 20) {
        a.footPhase += dt * Math.min(5.6, 1.15 + sp * 0.021) * 2;
        if (a.footPhase >= 1) {
          a.footPhase -= 1;
          this.audio.footstep(sp, local ? S.move.groundKind : 'terrain', pos);
        }
      }
    }
    for (const [id, a] of this.avatars) {
      if (!G.entities.has(id)) {
        this._disposeAvatar(a);
        this.grappleFX.remove(id);
        this.avatars.delete(id);
      }
    }

    /* ---- world FX ---- */
    this.wind.update(dt, this.camera.position, S.move.vel, speed);
    if (S.alive && S.move.grounded) this.wake.update(dt, this._selfPos, S.move.vel, speed, true, S.move.groundKind);
    this.combatFX.update(adt);
    this.sky.update(dt, this.camera, this._selfPos);
    this.audio.setListener(this.camera.position, this.camera.quaternion);
    this.audio.updateWind(speed, S.move.grounded);

    /* ---- HUD ---- */
    const vulnerable = isVulnerable(S.combat);
    // Probe for an anchor a few times a second so the G tag can light up.
    this._anchorTimer = (this._anchorTimer || 0) - dt;
    if (this._anchorTimer <= 0) {
      this._anchorTimer = 0.1;
      this._canGrapple = G_.state === GSTATE.IDLE && S.alive
        ? !!findAnchor(this.world, S.move.pos.x, S.move.pos.y, S.move.pos.z, this.input.yaw, this.input.pitch)
        : false;
    }
    this.hud.update(dt, {
      speed, hp: S.hp, credits: this.profile.credits,
      x: this._selfPos.x, z: this._selfPos.z,
      vulnerable,
      attacking: S.combat.state === WSTATE.WINDUP || S.combat.state === WSTATE.ACTIVE,
      grappleState: G_.state,
      canGrapple: this._canGrapple,
    });
    if (!S.alive) {
      if (this._deadSince === null || this._deadSince === undefined) this._deadSince = performance.now();
      const left = CFG.RESPAWN_TIME - (performance.now() - this._deadSince) / 1000;
      this.hud.setRespawn(true, this.killerName, Math.max(0, left));
    } else {
      this._deadSince = null;
      this.hud.setRespawn(false);
    }

    if (this.statScreen.visible) {
      const board = this.transport.scoreboard ? this.transport.scoreboard() : this._clientBoard();
      this.statScreen.update({ speed, hp: S.hp, match: this.match }, board, G.selfId);
    }
    if (this._boardTimer === undefined || (this._boardTimer -= dt) <= 0) {
      this._boardTimer = 0.5;
      const board = this.transport.scoreboard ? this.transport.scoreboard() : this._clientBoard();
      this.hud.setScore(board, G.selfId);
      this.hud.setNet(this.transport.kind === 'solo'
        ? 'LOCAL AUTHORITY'
        : `${Math.round(this.transport.rtt)} ms${G.corrections ? ' · ' + G.corrections + ' corr' : ''}`);
    }

    /* ---- render ---- */
    this.post.render(dt, { speedT: t, hp: S.hp, settings: this.profile.settings });
  }

  _clientBoard() {
    const rows = [];
    for (const e of this.gameState.entities.values()) {
      rows.push({
        id: e.id, name: e.name || this.profile.name, bot: e.bot ? 1 : 0,
        kills: e.kills || 0, deaths: e.deaths || 0,
        damage: e.id === this.gameState.selfId ? this.match.damageDealt : 0,
        topSpeed: 0, bestHit: 0, alive: (e.alive ?? true) ? 1 : 0,
      });
    }
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    return rows;
  }
}

const game = new Game();
game.boot().catch((e) => {
  console.error(e);
  const l = document.getElementById('load-text');
  if (l) l.textContent = 'FAILED TO START: ' + e.message;
});
window.MACH = game;

/**
 * [MACH] — client-side world state.
 *
 *  - LOCAL PLAYER: predicted with the shared movement/combat code, then
 *    reconciled against the authority by replaying unacknowledged inputs.
 *    Correction error is bled off smoothly instead of snapping.
 *  - REMOTE PLAYERS: rendered INTERP_DELAY behind the server clock, lerped
 *    between snapshots so a 500-speed pass reads as a clean streak, not a jump.
 *
 * The client never decides a hit, a health value, or a kill. It only asks for
 * things and draws what it is told.
 */

import { CFG } from '../core/Config.js';
import { Emitter, clamp, damp, lerp, angleLerp } from '../core/Util.js';
import { makeMoveState, stepPlayer } from '../shared/Movement.js';
import { makeCombatState, stepCombat, WSTATE } from '../shared/Combat.js';
import { makeGrappleState, stepGrapplePre, stepGrapplePost, GSTATE } from '../shared/Grapple.js';
import { makeParkourState, stepParkourPre, stepParkourPost, PSTATE } from '../shared/Parkour.js';
import { S2C } from '../net/Protocol.js';

const MAX_PENDING = 120;
const HARD_SNAP = 240;      // beyond this the prediction is hopeless: teleport

export class GameState extends Emitter {
  constructor(world, transport) {
    super();
    this.world = world;
    this.transport = transport;
    this.selfId = null;
    this.entities = new Map();
    this.self = null;
    this.seq = 1;
    this.pending = [];
    this.renderTime = 0;
    this.haveTime = false;
    this.error = { x: 0, y: 0, z: 0 };
    this.serverTick = 0;
    this.credits = 0;
    this.lastSnapshotAt = 0;
    this.corrections = 0;

    transport.on('message', (m) => this._onMessage(m));
  }

  async join(name) {
    const wel = await this.transport.connect(name);
    this.selfId = wel.id;
    this.self = {
      id: wel.id, name, color: 0,
      move: makeMoveState(),
      combat: makeCombatState(),
      grapple: makeGrappleState(),
      parkour: makeParkourState(),
      simTime: 0,
      yaw: 0, pitch: 0,
      hp: CFG.MAX_HEALTH, alive: true, protect: false,
      lastHitAt: -99, lastHurtAt: -99, vulnerable: false,
      kills: 0, deaths: 0,
    };
    this.entities.set(wel.id, this.self);
    return wel;
  }

  /* --------------------------------------------------------------- input */

  /** Fixed-step: predict locally, then ship the command. */
  applyInput(cmd, dt) {
    const s = this.self;
    if (!s) return;
    cmd.seq = this.seq++;
    s.yaw = cmd.yaw;
    s.pitch = cmd.pitch;

    if (s.alive) {
      const ev = stepCombat(s.combat, cmd, dt, s.move.mods, s.move.grounded);
      if (ev.startWindup) this.emit('localSwing', { type: s.combat.attackType, index: s.combat.swingIndex });
      if (ev.whiff) this.emit('localWhiff', {});
      if (ev.draw) this.emit('localDraw', {});
      if (ev.sheathe) this.emit('localSheathe', {});

      s.simTime += dt;
      stepParkourPre(s.parkour, s.move, cmd, this.world, dt, s.simTime,
        s.grapple.state === GSTATE.ATTACHED);
      const pk = s.parkour;
      if (pk.justWallrun) this.emit('localWall', { climb: pk.state === PSTATE.WALLCLIMB, pk });
      if (pk.justKick) this.emit('localKick', { pk, speed: s.move.speed });
      if (pk.justVault) this.emit('localVault', {});
      if (pk.justSlide) this.emit('localSlide', { speed: s.move.speed });
      if (pk.justSlideEnd) this.emit('localSlideEnd', {});

      const firedBefore = s.grapple.fired;
      stepGrapplePre(s.grapple, s.move, cmd, this.world, dt, s.yaw, s.pitch);
      if (s.grapple.state === GSTATE.ATTACHED) {
        s.move.mods.accel *= 0.22;
        s.move.mods.turn *= 0.45;
      }
      if (s.grapple.fired !== firedBefore) {
        this.emit('localGrappleFire', { hit: s.grapple.state !== GSTATE.IDLE, g: s.grapple });
      }

      const mev = { jumped: false, landed: false, landSpeed: 0 };
      stepPlayer(s.move, cmd, this.world, dt, mev);
      stepGrapplePost(s.grapple, s.move);
      stepParkourPost(s.parkour, s.move, s.simTime);

      if (s.grapple.justAttached) this.emit('localGrappleHook', { g: s.grapple });
      if (s.grapple.justReleased) this.emit('localGrappleRelease', { speed: s.grapple.releaseSpeed });
      if (mev.jumped) this.emit('localJump', {});
      if (mev.landed) this.emit('localLand', mev);
    }

    this.pending.push({ seq: cmd.seq, cmd: { ...cmd }, dt });
    if (this.pending.length > MAX_PENDING) this.pending.shift();
    this.transport.sendInput(cmd);
  }

  /* ------------------------------------------------------------ messages */

  _onMessage(m) {
    if (m.t === S2C.SNAPSHOT) this._onSnapshot(m);
    else if (m.t === S2C.BOARD) this.emit('board', m.rows);
    else if (m.t === S2C.BYE) this.emit('bye', m);
  }

  _onSnapshot(snap) {
    this.serverTick = snap.tick;
    this.lastSnapshotAt = performance.now();

    if (!this.haveTime) { this.renderTime = snap.st - CFG.INTERP_DELAY; this.haveTime = true; }
    else {
      const target = snap.st - CFG.INTERP_DELAY;
      // Nudge the render clock instead of jerking it.
      this.renderTime += clamp(target - this.renderTime, -0.05, 0.05) * 0.25;
    }

    const seen = new Set();
    for (const ps of snap.players) {
      seen.add(ps.id);
      if (ps.id === this.selfId) { this._reconcile(ps, snap.st); continue; }
      let e = this.entities.get(ps.id);
      if (!e) {
        e = {
          id: ps.id, name: ps.n, color: ps.c, bot: !!ps.b, remote: true,
          buf: [], render: { x: ps.x, y: ps.y, z: ps.z, yaw: ps.ya, pitch: ps.pi, speed: 0 },
          hp: ps.hp, alive: !!ps.al, combatState: ps.ws, swingIndex: ps.wi, attackType: ps.wa,
          phase: 0, grounded: !!ps.g, vulnerable: false, protect: false,
          grapple: { state: 0, ax: 0, ay: 0, az: 0, t: 1 },
          parkour: { state: 0, nx: 0, nz: 0, side: 0 },
          kills: ps.k, deaths: ps.d,
        };
        this.entities.set(ps.id, e);
        this.emit('joined', e);
      }
      e.name = ps.n; e.hp = ps.hp; e.alive = !!ps.al; e.kills = ps.k; e.deaths = ps.d;
      e.vulnerable = !!ps.vu; e.protect = !!ps.pr;
      e.grapple = { state: ps.gs | 0, ax: ps.gx, ay: ps.gy, az: ps.gz, t: ps.gt };
      e.parkour = { state: ps.pk | 0, nx: ps.pn || 0, nz: ps.pz || 0, side: ps.ps || 0 };
      e.buf.push({
        t: snap.st, x: ps.x, y: ps.y, z: ps.z, yaw: ps.ya, pitch: ps.pi,
        sp: ps.sp, ws: ps.ws, wi: ps.wi, wa: ps.wa, wp: ps.wp, g: ps.g, al: ps.al,
      });
      while (e.buf.length > 40) e.buf.shift();
    }

    for (const [id, e] of this.entities) {
      if (id === this.selfId) continue;
      if (!seen.has(id)) { this.entities.delete(id); this.emit('left', e); }
    }

    for (const ev of snap.events) this._onEvent(ev);
  }

  _onEvent(ev) {
    if (ev.t === 'hit' && ev.a === this.selfId) {
      // The authority confirmed the blade connected — shorten our predicted
      // recovery to match and fire the hit-confirm feedback.
      const c = this.self.combat;
      c.hitLanded = true;
      if (c.state === WSTATE.RECOVER && c.lastWhiff) {
        c.lastWhiff = false;
        c.timer = Math.min(c.timer, CFG.SWING.recover);
      }
    }
    if (ev.t === 'credits' && ev.id === this.selfId) this.credits = ev.total;
    this.emit('event', ev);
  }

  _reconcile(ps, serverTime) {
    const s = this.self;
    s.hp = ps.hp;
    s.alive = !!ps.al;
    s.protect = !!ps.pr;
    s.kills = ps.k; s.deaths = ps.d;
    s.color = ps.c;

    // Drop acknowledged inputs.
    while (this.pending.length && this.pending[0].seq <= ps.ack) this.pending.shift();

    const predicted = { x: s.move.pos.x, y: s.move.pos.y, z: s.move.pos.z };

    // Rewind to the authoritative state...
    s.move.pos.x = ps.x; s.move.pos.y = ps.y; s.move.pos.z = ps.z;
    s.move.vel.x = ps.vx; s.move.vel.y = ps.vy; s.move.vel.z = ps.vz;
    s.move.grounded = !!ps.g;
    s.move.speed = ps.sp;

    // ...and replay everything the server has not seen yet. A dead player is
    // frozen on both sides, so replaying would only invent a correction.
    const mods = s.move.mods;
    if (s.alive) {
      const hooked = s.grapple.state === GSTATE.ATTACHED;
      const pkState = s.parkour.state;
      for (const p of this.pending) {
        mods.turn = 1; mods.accel = 1; mods.friction = 1;
        applyModsForState(s.combat, mods);
        if (hooked) { mods.accel *= 0.22; mods.turn *= 0.45; }
        // Hold the parkour overrides steady across the replay rather than
        // re-running the state machine, which would double-advance its timers.
        if (pkState === PSTATE.WALLRUN) { s.move.gravityScale = 0.4; mods.turn *= 0.22; mods.accel *= 0.15; }
        else if (pkState === PSTATE.WALLCLIMB) s.move.gravityScale = 0.08;
        else if (pkState === PSTATE.SLIDE) { mods.friction *= 0.11; mods.turn *= 0.42; mods.accel *= 0.25; }
        stepPlayer(s.move, p.cmd, this.world, p.dt, null);
        if (hooked) stepGrapplePost(s.grapple, s.move);
      }
      s.move.gravityScale = 1;
    } else {
      this.pending.length = 0;
    }

    // Grapple authority: only adopt the server's view once it has actually
    // seen everything we sent, otherwise a freshly fired hook flickers off.
    if (this.pending.length === 0 && ps.gs !== undefined && ps.gs !== s.grapple.state) {
      const g = s.grapple;
      g.state = ps.gs;
      g.ax = ps.gx; g.ay = ps.gy; g.az = ps.gz;
      if (ps.gs === GSTATE.ATTACHED) {
        g.rope = Math.hypot(g.ax - s.move.pos.x, g.ay - (s.move.pos.y + 13), g.az - s.move.pos.z);
      } else if (ps.gs === GSTATE.IDLE) {
        g.rope = 0;
      }
    }

    const dx = predicted.x - s.move.pos.x;
    const dy = predicted.y - s.move.pos.y;
    const dz = predicted.z - s.move.pos.z;
    const err = Math.hypot(dx, dy, dz);
    if (err > HARD_SNAP) {
      this.error.x = this.error.y = this.error.z = 0;
      this.corrections++;
    } else if (err > 0.05) {
      // Keep drawing where we were, then bleed the error away over a few frames.
      this.error.x = dx; this.error.y = dy; this.error.z = dz;
      if (err > 12) this.corrections++;
    }
  }

  /* -------------------------------------------------------------- per-frame */

  update(dt) {
    this.transport.pump(dt);
    if (this.haveTime) this.renderTime += dt;

    // Error smoothing for the local player.
    const k = Math.exp(-14 * dt);
    this.error.x *= k; this.error.y *= k; this.error.z *= k;

    const rt = this.renderTime;
    for (const e of this.entities.values()) {
      if (!e.remote) continue;
      const buf = e.buf;
      if (buf.length === 0) continue;

      let a = buf[0], b = buf[buf.length - 1];
      if (rt <= buf[0].t) { a = b = buf[0]; }
      else if (rt >= buf[buf.length - 1].t) { a = b = buf[buf.length - 1]; }
      else {
        for (let i = buf.length - 1; i > 0; i--) {
          if (buf[i - 1].t <= rt) { a = buf[i - 1]; b = buf[i]; break; }
        }
      }
      const f = b.t > a.t ? clamp((rt - a.t) / (b.t - a.t), 0, 1) : 0;
      const r = e.render;
      r.x = lerp(a.x, b.x, f);
      r.y = lerp(a.y, b.y, f);
      r.z = lerp(a.z, b.z, f);
      r.yaw = angleLerp(a.yaw, b.yaw, f);
      r.pitch = lerp(a.pitch, b.pitch, f);
      r.speed = lerp(a.sp, b.sp, f);
      e.combatState = b.ws;
      e.swingIndex = b.wi;
      e.attackType = b.wa;
      e.phase = b.wp;
      e.grounded = !!b.g;
      e.alive = !!b.al;
      // Cull stale buffer entries.
      while (buf.length > 2 && buf[1].t < rt - 0.6) buf.shift();
    }
  }

  /** Render-space position of the local player (prediction + error bleed). */
  selfRenderPos(out) {
    const p = this.self.move.pos;
    out.x = p.x + this.error.x;
    out.y = p.y + this.error.y;
    out.z = p.z + this.error.z;
    return out;
  }

  list() { return [...this.entities.values()]; }
}

function applyModsForState(c, mods) {
  switch (c.state) {
    case WSTATE.WINDUP:
    case WSTATE.ACTIVE:
      mods.turn = CFG.ATTACK_TURN_MULT; mods.accel = CFG.ATTACK_ACCEL_MULT; break;
    case WSTATE.RECOVER:
      if (c.lastWhiff) { mods.turn = CFG.WHIFF_TURN_MULT; mods.accel = 0.22; mods.friction = CFG.WHIFF_FRICTION_MULT; }
      else { mods.turn = 0.7; mods.accel = 0.8; }
      break;
    case WSTATE.DRAWING:
    case WSTATE.SHEATHING:
      mods.turn = 0.88; mods.accel = 0.9; break;
  }
}

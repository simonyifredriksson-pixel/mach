/**
 * [MACH] — authoritative simulation.
 *
 * This runs on the server (and, for solo play, inside a loopback authority in
 * the page). Clients send *inputs only*. Positions, speed, hit registration,
 * damage, health, kills and credits are decided here and nowhere else.
 *
 * Hit registration is lag-compensated: when a blade goes active we rewind every
 * other player to where the attacker actually saw them, clamped to MAX_REWIND.
 */

import { CFG, damageForSpeed } from '../core/Config.js';
import { clamp, clamp01, History } from '../core/Util.js';
import { makeMoveState, stepPlayer } from './Movement.js';
import { makeCombatState, stepCombat, WSTATE, isVulnerable, bladeHits } from './Combat.js';
import { makeGrappleState, stepGrapplePre, stepGrapplePost, GSTATE } from './Grapple.js';
import { botInput, makeBotState } from './Bots.js';

const EMPTY_INPUT = { seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0, sprint: false, jump: false, attack: false, sheathe: false, grapple: false };

function lerpVec(a, b, f) {
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
}

export function makeStats() {
  return {
    kills: 0, deaths: 0, assists: 0,
    damageDealt: 0, damageTaken: 0,
    hits: 0, swings: 0,
    topSpeed: 0, bestHit: 0, bestHitSpeed: 0,
    distance: 0, timeAlive: 0, streak: 0, bestStreak: 0,
  };
}

export class Sim {
  constructor(world, opts = {}) {
    this.world = world;
    this.dt = 1 / CFG.TICK_RATE;
    this.tick = 0;
    this.time = 0;
    this.players = new Map();
    this.events = [];
    this.nextBotId = -1;
    this.onEvent = opts.onEvent || null;
  }

  /* --------------------------------------------------------------- roster */

  add(id, { name = 'RUNNER', bot = false, skill = 0.75, color = 0 } = {}) {
    const p = {
      id, name, bot, color,
      move: makeMoveState(),
      combat: makeCombatState(),
      grapple: makeGrappleState(),
      bot_: bot ? makeBotState(skill) : null,
      yaw: 0, pitch: 0,
      hp: CFG.MAX_HEALTH,
      alive: true,
      respawnAt: 0,
      protectUntil: 0,
      iframeUntil: 0,
      hitBy: new Map(),              // attackId dedupe: victimId -> lastAttackId
      queue: [],
      lastInput: { ...EMPTY_INPUT },
      ack: 0,
      latency: 0,
      hist: new History(CFG.HISTORY_SECONDS),
      stats: makeStats(),
      credits: 0,
      creditFrac: 0,
      surviveTimer: 0,
      joinedAt: this.time,
    };
    this.players.set(id, p);
    this._respawn(p, true);
    return p;
  }

  addBot(name, skill) {
    const id = this.nextBotId--;
    return this.add(id, { name, bot: true, skill, color: (Math.abs(id) % 6) });
  }

  remove(id) { this.players.delete(id); }

  /* ---------------------------------------------------------------- input */

  input(id, cmd) {
    const p = this.players.get(id);
    if (!p || p.bot) return;
    if (Array.isArray(cmd)) { for (const c of cmd) this.input(id, c); return; }
    if (cmd.seq <= p.ack && p.queue.length === 0) return;      // stale
    if (p.queue.length > 8) p.queue.shift();                   // don't let a laggy client bank inputs
    p.queue.push(cmd);
    if (typeof cmd.rtt === 'number') p.latency = clamp(cmd.rtt * 0.5, 0, CFG.MAX_REWIND);
  }

  /* ----------------------------------------------------------------- step */

  step(dt = this.dt) {
    this.time += dt;
    this.tick++;

    // Pass A — consume input, run the weapon SM, then move.
    for (const p of this.players.values()) {
      if (!p.alive) {
        if (this.time >= p.respawnAt) this._respawn(p);
        else { p.hist.push(this.time, { ...p.move.pos }); continue; }
      }

      let input;
      if (p.bot) {
        input = botInput(this, p, dt);
      } else if (p.queue.length) {
        input = p.queue.shift();
        p.ack = input.seq | 0;
      } else {
        // Starved: hold the stick, drop the edges.
        input = p.lastInput;
        input.jump = false; input.attack = false; input.sheathe = false; input.grapple = false;
      }
      p.lastInput = input;
      p.yaw = input.yaw || 0;
      p.pitch = clamp(input.pitch || 0, -1.2, 1.2);

      const ev = stepCombat(p.combat, input, dt, p.move.mods, p.move.grounded);
      if (ev.startWindup) {
        p.stats.swings++;
        p.protectUntil = 0;                                    // swinging drops spawn protection
        this._emit({ t: 'swing', id: p.id, a: p.combat.attackType, i: p.combat.swingIndex, s: Math.round(p.move.speed) });
      }
      if (ev.whiff) this._emit({ t: 'whiff', id: p.id });
      if (ev.draw) this._emit({ t: 'draw', id: p.id });
      if (ev.sheathe) this._emit({ t: 'sheathe', id: p.id });

      // Grapple runs around the movement step: the reel/swing forces go in
      // before integration, the rope constraint is enforced after it.
      const wasHooked = p.grapple.state;
      stepGrapplePre(p.grapple, p.move, input, this.world, dt, p.yaw, p.pitch);
      if (p.grapple.state === GSTATE.ATTACHED) {
        // While latched, the rope is doing the steering.
        p.move.mods.accel *= 0.22;
        p.move.mods.turn *= 0.45;
      }
      if (p.grapple.fired !== p.grappleFired) {
        p.grappleFired = p.grapple.fired;
        this._emit({
          t: 'gfire', id: p.id,
          hit: p.grapple.state !== GSTATE.IDLE ? 1 : 0,
          x: p.grapple.ax, y: p.grapple.ay, z: p.grapple.az,
        });
      }

      const before = p.move.pos;
      const px = before.x, pz = before.z;
      const mev = { jumped: false, landed: false, landSpeed: 0 };
      stepPlayer(p.move, input, this.world, dt, mev);
      stepGrapplePost(p.grapple, p.move);

      if (p.grapple.justAttached) this._emit({ t: 'ghook', id: p.id, x: p.grapple.ax, y: p.grapple.ay, z: p.grapple.az });
      if (p.grapple.justReleased) this._emit({ t: 'grelease', id: p.id, s: Math.round(p.grapple.releaseSpeed) });
      void wasHooked;

      p.stats.distance += Math.hypot(p.move.pos.x - px, p.move.pos.z - pz);
      if (p.move.speed > p.stats.topSpeed) p.stats.topSpeed = p.move.speed;
      p.stats.timeAlive += dt;

      if (mev.jumped) this._emit({ t: 'jump', id: p.id });
      if (mev.landed) this._emit({ t: 'land', id: p.id, v: Math.round(mev.landSpeed), s: Math.round(p.move.speed) });

      // Survival income, paid per 10 seconds upright.
      p.surviveTimer += dt;
      if (p.surviveTimer >= 10) { p.surviveTimer -= 10; this._award(p, CFG.SURVIVE_CURRENCY, 'survive'); }

      p.hist.push(this.time, { ...p.move.pos });
    }

    // Pass B — blade resolution, after everyone has moved this tick.
    for (const p of this.players.values()) {
      if (!p.alive || p.combat.state !== WSTATE.ACTIVE) continue;
      this._resolveBlade(p);
    }

    return this.events;
  }

  _resolveBlade(a) {
    const rewind = clamp(a.latency + CFG.INTERP_DELAY, 0, CFG.MAX_REWIND);
    const at = this.time - rewind;
    const speed = a.move.speed;

    for (const v of this.players.values()) {
      if (v === a || !v.alive) continue;
      if (this.time < v.iframeUntil) continue;
      if (v.hitBy.get(a.id) === a.combat.attackId) continue;

      // Rewind the victim to where the attacker saw them.
      const past = v.bot ? v.move.pos : (v.hist.sample(at, lerpVec) || v.move.pos);

      const res = bladeHits(
        a.move.pos.x, a.move.pos.y, a.move.pos.z,
        a.yaw, speed,
        past.x, past.y, past.z,
      );
      if (!res) continue;

      v.hitBy.set(a.id, a.combat.attackId);
      a.combat.hitLanded = true;

      if (this.time < v.protectUntil) {
        this._emit({ t: 'block', a: a.id, v: v.id, x: past.x, y: past.y + CFG.HIT_SPHERE_Y, z: past.z });
        continue;
      }

      /* ---- THE formula. Server-side, from the server's speed value. ---- */
      const dmg = damageForSpeed(speed);

      v.hp -= dmg;
      v.iframeUntil = this.time + CFG.IFRAME;
      v.stats.damageTaken += dmg;
      a.stats.damageDealt += dmg;
      a.stats.hits++;
      if (dmg > a.stats.bestHit) { a.stats.bestHit = dmg; a.stats.bestHitSpeed = speed; }

      // Impact: the victim is shoved along the blade and loses momentum.
      const fx = -Math.sin(a.yaw), fz = -Math.cos(a.yaw);
      v.move.vel.x = v.move.vel.x * (1 - CFG.HIT_SPEED_LOSS) + fx * CFG.HIT_KNOCK;
      v.move.vel.z = v.move.vel.z * (1 - CFG.HIT_SPEED_LOSS) + fz * CFG.HIT_KNOCK;
      v.move.vel.y = Math.max(v.move.vel.y, 40);
      v.move.grounded = false;
      v.move.speed = Math.hypot(v.move.vel.x, v.move.vel.z);

      this._award(a, dmg * CFG.HIT_CURRENCY, 'hit');

      this._emit({
        t: 'hit', a: a.id, v: v.id,
        d: Math.round(dmg * 10) / 10,
        s: Math.round(speed),
        q: Math.round(res.quality * 100) / 100,
        x: past.x, y: past.y + CFG.HIT_SPHERE_Y, z: past.z,
        hp: Math.max(0, Math.round(v.hp)),
      });

      if (v.hp <= 0) this._kill(a, v, dmg, speed);
    }
  }

  _kill(a, v, dmg, speed) {
    v.alive = false;
    v.hp = 0;
    v.respawnAt = this.time + CFG.RESPAWN_TIME;
    v.stats.deaths++;
    v.stats.streak = 0;
    a.stats.kills++;
    a.stats.streak++;
    if (a.stats.streak > a.stats.bestStreak) a.stats.bestStreak = a.stats.streak;
    this._award(a, CFG.BOUNTY_CURRENCY, 'kill');
    this._emit({
      t: 'kill', a: a.id, v: v.id, an: a.name, vn: v.name,
      d: Math.round(dmg), s: Math.round(speed), streak: a.stats.streak,
      x: v.move.pos.x, y: v.move.pos.y, z: v.move.pos.z,
    });
  }

  _award(p, amount, reason) {
    p.creditFrac += amount;
    const whole = Math.floor(p.creditFrac);
    if (whole > 0) {
      p.creditFrac -= whole;
      p.credits += whole;
      this._emit({ t: 'credits', id: p.id, c: whole, r: reason, total: p.credits });
    }
  }

  _respawn(p, initial = false) {
    const spawn = this._pickSpawn(p);
    p.move = makeMoveState();
    p.move.pos.x = spawn.x; p.move.pos.y = spawn.y + 2; p.move.pos.z = spawn.z;
    p.combat = makeCombatState();
    p.grapple = makeGrappleState();
    p.grappleFired = 0;
    p.hp = CFG.MAX_HEALTH;
    p.alive = true;
    p.hitBy.clear();
    p.iframeUntil = 0;
    p.protectUntil = this.time + CFG.SPAWN_PROTECT;
    p.yaw = Math.atan2(-(0 - spawn.x), -(0 - spawn.z)) + Math.PI; // look roughly inward
    p.hist.items.length = 0;
    if (!initial) this._emit({ t: 'spawn', id: p.id, x: spawn.x, y: spawn.y, z: spawn.z });
  }

  _pickSpawn(p) {
    const spawns = this.world.spawns;
    let best = spawns[0], bestScore = -Infinity;
    for (const s of spawns) {
      let near = Infinity;
      for (const o of this.players.values()) {
        if (o === p || !o.alive) continue;
        near = Math.min(near, Math.hypot(o.move.pos.x - s.x, o.move.pos.z - s.z));
      }
      const score = (near === Infinity ? 5000 : near) + Math.random() * 300;
      if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
  }

  _emit(e) {
    e.tick = this.tick;
    this.events.push(e);
    if (this.onEvent) this.onEvent(e);
  }

  /* ------------------------------------------------------------- snapshot */

  snapshot() {
    const players = [];
    for (const p of this.players.values()) {
      players.push({
        id: p.id,
        n: p.name,
        c: p.color,
        b: p.bot ? 1 : 0,
        x: r2(p.move.pos.x), y: r2(p.move.pos.y), z: r2(p.move.pos.z),
        vx: r2(p.move.vel.x), vy: r2(p.move.vel.y), vz: r2(p.move.vel.z),
        sp: r1(p.move.speed),
        ya: r3(p.yaw), pi: r3(p.pitch),
        hp: r1(p.hp),
        al: p.alive ? 1 : 0,
        g: p.move.grounded ? 1 : 0,
        ws: p.combat.state,
        wi: p.combat.swingIndex,
        wa: p.combat.attackType,
        wp: r2(p.combat.phase),
        gs: p.grapple.state,
        gx: r1(p.grapple.ax), gy: r1(p.grapple.ay), gz: r1(p.grapple.az),
        gt: p.grapple.state === GSTATE.FIRING ? r2(clamp(p.grapple.travel / Math.max(1, p.grapple.total), 0, 1)) : 1,
        vu: isVulnerable(p.combat) ? 1 : 0,
        pr: this.time < p.protectUntil ? 1 : 0,
        k: p.stats.kills, d: p.stats.deaths,
        ack: p.ack,
        cr: p.credits,
      });
    }
    // `st` = server time. Deliberately NOT `t`: the transport envelope uses `t`
    // for the message type, and spreading a snapshot into it would clobber it.
    const snap = { st: r3(this.time), tick: this.tick, players, events: this.events };
    this.events = [];
    return snap;
  }

  /** Full stats payload for the stat screen / scoreboard. */
  scoreboard() {
    const rows = [];
    for (const p of this.players.values()) {
      rows.push({
        id: p.id, name: p.name, bot: p.bot ? 1 : 0, color: p.color,
        kills: p.stats.kills, deaths: p.stats.deaths,
        damage: Math.round(p.stats.damageDealt),
        topSpeed: Math.round(p.stats.topSpeed),
        bestHit: Math.round(p.stats.bestHit),
        streak: p.stats.streak,
        acc: p.stats.swings ? p.stats.hits / p.stats.swings : 0,
        alive: p.alive ? 1 : 0,
      });
    }
    rows.sort((a, b) => b.kills - a.kills || a.deaths - b.deaths || b.damage - a.damage);
    return rows;
  }
}

const r1 = (v) => Math.round(v * 10) / 10;
const r2 = (v) => Math.round(v * 100) / 100;
const r3 = (v) => Math.round(v * 1000) / 1000;

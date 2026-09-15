/**
 * Two transports, one interface.
 *
 *  - WebSocketTransport: talks to server/server.js over the network.
 *  - LoopbackTransport:  hosts the SAME Sim class inside the page, with bots,
 *                        stepped from the render loop. Solo play is therefore
 *                        not a different game mode with different rules — it is
 *                        the identical authority with zero latency.
 *
 * A transport only moves messages. It never interprets game state.
 */

import { Emitter } from '../core/Util.js';
import { CFG } from '../core/Config.js';
import { C2S, S2C, packInput, unpackInput, PROTOCOL_VERSION } from './Protocol.js';
import { Sim } from '../shared/Sim.js';

export class WebSocketTransport extends Emitter {
  constructor(url) {
    super();
    this.url = url;
    this.ws = null;
    this.ready = false;
    this.rtt = 0;
    this._pingTimer = 0;
    this._pendingPings = new Map();
    this.kind = 'online';
  }

  connect(name) {
    return new Promise((resolve, reject) => {
      let settled = false;
      try { this.ws = new WebSocket(this.url); } catch (e) { reject(e); return; }
      const fail = (e) => { if (!settled) { settled = true; reject(e); } };
      this.ws.onopen = () => {
        this.ready = true;
        this.ws.send(JSON.stringify({ t: C2S.JOIN, name, v: PROTOCOL_VERSION }));
      };
      this.ws.onmessage = (ev) => {
        let msg;
        try { msg = JSON.parse(ev.data); } catch { return; }
        if (msg.t === S2C.WELCOME && !settled) { settled = true; resolve(msg); }
        if (msg.t === S2C.PONG) {
          const sent = this._pendingPings.get(msg.id);
          if (sent) { this.rtt = performance.now() - sent; this._pendingPings.delete(msg.id); }
          return;
        }
        this.emit('message', msg);
      };
      this.ws.onerror = (e) => fail(e);
      this.ws.onclose = () => { this.ready = false; this.emit('close'); fail(new Error('closed')); };
      setTimeout(() => fail(new Error('timeout')), 6000);
    });
  }

  sendInput(cmd) {
    if (!this.ready) return;
    this.ws.send(JSON.stringify({ t: C2S.INPUT, c: [packInput(cmd)], r: Math.round(this.rtt) }));
  }

  pump(dt) {
    this._pingTimer -= dt;
    if (this._pingTimer <= 0 && this.ready) {
      this._pingTimer = 1;
      const id = Math.random().toString(36).slice(2, 8);
      this._pendingPings.set(id, performance.now());
      this.ws.send(JSON.stringify({ t: C2S.PING, id }));
    }
  }

  close() { this.ready = false; try { this.ws?.close(); } catch {} }
}

export class LoopbackTransport extends Emitter {
  /**
   * @param {object} world shared world
   * @param {object} opts  {bots: number, skill: [min,max], names: string[]}
   */
  constructor(world, opts = {}) {
    super();
    this.world = world;
    this.opts = opts;
    this.sim = null;
    this.selfId = 1;
    this.rtt = 0;
    this.acc = 0;
    this.snapAcc = 0;
    this.kind = 'solo';
    this.ready = false;
  }

  connect(name) {
    this.sim = new Sim(this.world);
    this.sim.add(this.selfId, { name, color: 0 });
    const count = this.opts.bots ?? 5;
    const [smin, smax] = this.opts.skill ?? [0.45, 0.92];
    const names = this.opts.names ?? BOT_NAMES;
    for (let i = 0; i < count; i++) {
      const skill = smin + (smax - smin) * (count === 1 ? 0.7 : i / Math.max(1, count - 1));
      this.sim.addBot(names[i % names.length], skill);
    }
    this.ready = true;
    return Promise.resolve({
      t: S2C.WELCOME, id: this.selfId, seed: this.world.seed,
      tick: 0, time: 0, mode: 'solo', v: PROTOCOL_VERSION,
    });
  }

  sendInput(cmd) {
    if (!this.ready) return;
    this.sim.input(this.selfId, unpackInput(packInput(cmd), 0));
  }

  pump(dt) {
    if (!this.ready) return;
    const step = 1 / CFG.TICK_RATE;
    this.acc = Math.min(this.acc + dt, 0.25);
    let steps = 0;
    while (this.acc >= step && steps < 8) {
      this.sim.step(step);
      this.acc -= step;
      steps++;
    }
    this.snapAcc += dt;
    const snapInterval = 1 / CFG.SNAPSHOT_RATE;
    while (this.snapAcc >= snapInterval) {
      this.snapAcc -= snapInterval;
      this.emit('message', { t: S2C.SNAPSHOT, ...this.sim.snapshot() });
    }
  }

  scoreboard() { return this.sim ? this.sim.scoreboard() : []; }
  close() { this.ready = false; this.sim = null; }
}

export const BOT_NAMES = [
  'KAZE', 'NULL', 'SHIRO', 'V-9', 'ORIN', 'HOLLOW', 'MACH-7', 'SABLE',
  'TENKO', 'DRIFT', 'AKIRA', 'GHOST', 'RONIN', 'ZERO', 'YUKI', 'BLINK',
];

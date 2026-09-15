/**
 * [MACH] — authoritative game server.
 *
 *   node server/server.js            # port 8787
 *   PORT=9000 BOTS=3 node server/server.js
 *
 * Then open the client with  ?server=ws://localhost:8787
 *
 * The server imports the SAME simulation modules the client predicts with
 * (../src/shared/*), so there is exactly one implementation of movement,
 * the katana state machine and the damage formula. Clients send inputs; the
 * server decides everything that matters:
 *
 *   - position, velocity and therefore SPEED
 *   - whether a blade connected (lag-compensated, rewound per attacker)
 *   - damage = speed * 0.5, applied to authoritative health
 *   - kills, respawns and credits
 *
 * A client that lies about its speed changes nothing: its inputs are replayed
 * through the same movement code here, and the result is what counts.
 */

import { WebSocketServer } from 'ws';
import { CFG } from '../src/core/Config.js';
import { buildWorld } from '../src/shared/WorldData.js';
import { Sim } from '../src/shared/Sim.js';
import { unpackInput } from '../src/net/Protocol.js';

const PORT = parseInt(process.env.PORT || '8787', 10);
const SEED = parseInt(process.env.SEED || '1337', 10);
const MIN_BOTS = parseInt(process.env.BOTS || '3', 10);
const MAX_PLAYERS = parseInt(process.env.MAX_PLAYERS || '10', 10);
const TICK_MS = 1000 / CFG.TICK_RATE;
const SNAP_EVERY = Math.max(1, Math.round(CFG.TICK_RATE / CFG.SNAPSHOT_RATE));

const world = buildWorld(SEED);
const sim = new Sim(world);
const clients = new Map();          // ws -> {id, name}
let nextId = 1;

/* ------------------------------------------------------------------ bots */

function syncBots() {
  const humans = [...sim.players.values()].filter((p) => !p.bot).length;
  const bots = [...sim.players.values()].filter((p) => p.bot);
  const want = Math.max(0, Math.min(MIN_BOTS, MAX_PLAYERS - humans));
  while (bots.length > want) sim.remove(bots.pop().id);
  const names = ['KAZE', 'NULL', 'SHIRO', 'V-9', 'ORIN', 'HOLLOW', 'MACH-7', 'SABLE'];
  let i = bots.length;
  while (i < want) {
    sim.addBot(names[i % names.length], 0.5 + Math.random() * 0.45);
    i++;
  }
}
syncBots();

/* ----------------------------------------------------------------- loop */

let tick = 0;
let accumulator = 0;
let last = process.hrtime.bigint();

setInterval(() => {
  const now = process.hrtime.bigint();
  let dt = Number(now - last) / 1e9;
  last = now;
  if (dt > 0.25) dt = 0.25;

  // Fixed-step regardless of timer jitter.
  accumulator += dt;
  let steps = 0;
  while (accumulator >= 1 / CFG.TICK_RATE && steps < 6) {
    sim.step(1 / CFG.TICK_RATE);
    accumulator -= 1 / CFG.TICK_RATE;
    steps++;
    tick++;
    if (tick % SNAP_EVERY === 0) broadcastSnapshot();
  }
}, TICK_MS);

setInterval(() => {
  const msg = JSON.stringify({ t: 'board', rows: sim.scoreboard() });
  for (const ws of clients.keys()) safeSend(ws, msg);
}, 1000);

function broadcastSnapshot() {
  const snap = sim.snapshot();
  const msg = JSON.stringify({ t: 'snap', ...snap });
  for (const ws of clients.keys()) safeSend(ws, msg);
}

function safeSend(ws, msg) {
  if (ws.readyState === 1) {
    try { ws.send(msg); } catch { /* client is gone; cleanup happens on close */ }
  }
}

/* --------------------------------------------------------------- server */

const wss = new WebSocketServer({ port: PORT });

wss.on('connection', (ws, req) => {
  const ip = req.socket.remoteAddress;
  let joined = false;

  ws.on('message', (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { return; }

    if (m.t === 'join') {
      if (joined) return;
      const humans = [...sim.players.values()].filter((p) => !p.bot).length;
      if (humans >= MAX_PLAYERS) { safeSend(ws, JSON.stringify({ t: 'full' })); ws.close(); return; }
      joined = true;
      const id = nextId++;
      const name = String(m.name || 'RUNNER').toUpperCase().replace(/[^A-Z0-9 _-]/g, '').slice(0, 12) || 'RUNNER';
      sim.add(id, { name, color: id % 6 });
      clients.set(ws, { id, name });
      syncBots();
      safeSend(ws, JSON.stringify({
        t: 'wel', id, seed: SEED, tick: sim.tick, time: sim.time, mode: 'online', v: 3,
      }));
      console.log(`[join] ${name} #${id} from ${ip} (${clients.size} online)`);
      return;
    }

    const c = clients.get(ws);
    if (!c) return;

    if (m.t === 'in' && Array.isArray(m.c)) {
      const rtt = Math.max(0, Math.min(400, m.r || 0)) / 1000;
      for (const raw2 of m.c) sim.input(c.id, unpackInput(raw2, rtt));
      return;
    }
    if (m.t === 'ping') { safeSend(ws, JSON.stringify({ t: 'pong', id: m.id })); return; }
  });

  ws.on('close', () => {
    const c = clients.get(ws);
    if (c) {
      sim.remove(c.id);
      clients.delete(ws);
      console.log(`[left] ${c.name} #${c.id} (${clients.size} online)`);
      syncBots();
    }
  });

  ws.on('error', () => { });
});

console.log(`[MACH] authoritative server on ws://localhost:${PORT}`);
console.log(`       seed ${SEED} · ${CFG.TICK_RATE} Hz sim · ${CFG.SNAPSHOT_RATE} Hz snapshots`);
console.log(`       open the client with ?server=ws://localhost:${PORT}`);

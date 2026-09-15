/**
 * Wire protocol. JSON, because at 8 players x 30 Hz the payload is a few KB/s
 * and being able to read a packet in devtools is worth more than the bytes.
 *
 * Clients send INPUTS. The server sends STATE. Nothing else is trusted.
 */

export const PROTOCOL_VERSION = 3;

export const C2S = {
  JOIN: 'join',
  INPUT: 'in',
  PING: 'ping',
  CHAT: 'chat',
};

export const S2C = {
  WELCOME: 'wel',
  SNAPSHOT: 'snap',
  PONG: 'pong',
  BOARD: 'board',
  BYE: 'bye',
  FULL: 'full',
};

/** Pack a client input command into the smallest sane JSON shape. */
export function packInput(cmd) {
  return {
    s: cmd.seq,
    x: Math.round(cmd.mx * 100) / 100,
    z: Math.round(cmd.mz * 100) / 100,
    y: Math.round(cmd.yaw * 1000) / 1000,
    p: Math.round(cmd.pitch * 1000) / 1000,
    f: (cmd.sprint ? 1 : 0) | (cmd.jump ? 2 : 0) | (cmd.attack ? 4 : 0) | (cmd.sheathe ? 8 : 0),
  };
}

export function unpackInput(o, rtt) {
  return {
    seq: o.s | 0,
    mx: o.x || 0,
    mz: o.z || 0,
    yaw: o.y || 0,
    pitch: o.p || 0,
    sprint: !!(o.f & 1),
    jump: !!(o.f & 2),
    attack: !!(o.f & 4),
    sheathe: !!(o.f & 8),
    rtt,
  };
}

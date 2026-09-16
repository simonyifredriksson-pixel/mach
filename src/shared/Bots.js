/**
 * [MACH] — bot runners.
 *
 * Bots play the same game you do: they produce input commands and go through
 * the identical movement and combat code. They have no special knowledge and no
 * aim assist — what they have is an intercept solver, which is exactly the
 * skill the game asks of a human.
 *
 * Skill (0..1) controls prediction noise, reaction delay, how early they commit
 * to a swing, and — critically — whether they know when to *slow down*.
 */

import { CFG, speedT } from '../core/Config.js';
import { clamp, clamp01, lerp, angleDelta } from '../core/Util.js';
import { WSTATE, attackArc, bladeHits } from './Combat.js';
import { GSTATE } from './Grapple.js';
import { blocked } from './Physics.js';

export function makeBotState(skill = 0.75) {
  return {
    skill: clamp01(skill),
    // Personality. Duelists shed speed and fight in the controllable band;
    // chargers commit to high-velocity intercept runs — spectacular when the
    // read is right, a free punish when it isn't.
    charger: Math.random() < 0.4,
    targetId: null,
    think: 0,
    wp: Math.floor(Math.random() * 12),
    aimYaw: Math.random() * 6.28,
    mode: 'cruise',
    commit: 0,
    reaction: 0,
    strafe: 0,
    strafeTimer: 0,
    wantDraw: true,
    jumpCd: 0,
    lastAttack: 0,
    grappleCd: 2 + Math.random() * 6,
    grapplePitch: 0,
  };
}

const CMD = {
  seq: 0, mx: 0, mz: 0, yaw: 0, pitch: 0,
  sprint: false, jump: false, attack: false, sheathe: false, grapple: false,
};

export function botInput(sim, p, dt) {
  const b = p.bot_;
  const w = sim.world;
  const pos = p.move.pos;
  const skill = b.skill;

  b.think -= dt;
  b.jumpCd -= dt;
  b.strafeTimer -= dt;
  b.reaction = Math.max(0, b.reaction - dt);

  /* ------------------------------------------------------- pick a target */
  if (b.think <= 0) {
    b.think = lerp(0.42, 0.16, skill);
    let best = null, bestD = Infinity;
    for (const o of sim.players.values()) {
      if (o === p || !o.alive) continue;
      const d = Math.hypot(o.move.pos.x - pos.x, o.move.pos.z - pos.z);
      if (d < bestD) { bestD = d; best = o; }
    }
    // Bots disengage from very distant fights and go build speed instead.
    b.targetId = best && bestD < 2200 ? best.id : null;
    if (!b.targetId) {
      const wp = w.waypoints[b.wp];
      if (Math.hypot(wp.x - pos.x, wp.z - pos.z) < 320) b.wp = (b.wp + 3 + (Math.random() * 5 | 0)) % w.waypoints.length;
    }
    if (b.strafeTimer <= 0) {
      b.strafe = Math.random() < 0.3 ? (Math.random() < 0.5 ? -1 : 1) : 0;
      b.strafeTimer = lerp(1.2, 0.5, skill);
    }
  }

  const target = b.targetId != null ? sim.players.get(b.targetId) : null;
  const alive = target && target.alive;

  let goalX, goalZ, wantSprint = true, wantAttack = false;
  const speed = p.move.speed;

  if (alive) {
    const t = target.move;
    const dx = t.pos.x - pos.x, dz = t.pos.z - pos.z;
    const dist = Math.hypot(dx, dz);

    // --- intercept solve: aim where they WILL be, not where they are.
    const closing = Math.max(60, speed + 60);
    let lead = clamp(dist / closing, 0, 1.1);
    const noise = (1 - skill) * 0.55;
    lead *= 1 + (Math.random() * 2 - 1) * noise;
    const px = t.pos.x + t.vel.x * lead;
    const pz = t.pos.z + t.vel.z * lead;

    goalX = px; goalZ = pz;

    // --- speed discipline. This is the skill the game is really about: a bot
    // that floors it into every duel can barely turn and has a 24-degree arc,
    // so good bots shed speed on approach and fight in the controllable band.
    const arc = attackArc(speed);
    const straightness = clamp01(1 - Math.abs(angleDelta(
      Math.atan2(dz, dx), Math.atan2(t.vel.z || 0.001, t.vel.x || 0.001))) / Math.PI);

    let desired;
    if (b.charger) {
      // Never lifts. Picks a line and lives with it.
      desired = dist > 240 ? CFG.MAX_SPEED : lerp(420, 300, 1 - skill);
    } else if (dist > 800) desired = CFG.MAX_SPEED;          // close the gap
    else if (dist > 300) desired = lerp(460, 330, skill);    // line up
    else desired = lerp(340, 195, skill);                    // duel speed
    // A target running a dead-straight line is worth intercepting fast.
    if (straightness > 0.55 && dist > 180) desired += 90 * skill;
    wantSprint = speed < desired;

    // --- commit: would this swing land if I threw it right now?
    const wind = CFG.SWING.windup;
    const myX = pos.x + p.move.vel.x * wind, myZ = pos.z + p.move.vel.z * wind;
    const myY = pos.y + Math.max(0, p.move.vel.y) * wind;
    const tx = t.pos.x + t.vel.x * wind * (1 + (Math.random() * 2 - 1) * noise);
    const tz = t.pos.z + t.vel.z * wind * (1 + (Math.random() * 2 - 1) * noise);

    const predicted = bladeHits(myX, myY, myZ, b.aimYaw, speed, tx, t.pos.y, tz);
    const ready = p.combat.state === WSTATE.READY || p.combat.state === WSTATE.SHEATHED;
    const gate = lerp(0.12, 0.02, skill);     // sloppy bots need a fatter window
    if (ready && b.reaction <= 0) {
      if (predicted && predicted.quality > gate) {
        wantAttack = true;
      } else if (dist < arc.reach + 16) {
        // In the pocket but not lined up: take the shot anyway. Low-skill bots
        // do this constantly and eat the whiff recovery for it — which is
        // exactly the punish loop the player is learning to exploit.
        const nerve = lerp(0.55, 0.12, skill);
        if (Math.random() < nerve) wantAttack = true;
      }
      if (wantAttack) b.reaction = lerp(0.55, 0.18, skill);
    }

    // Overshot? Peel off, rebuild speed, come back around.
    if (dist < 90 && speed > 240) { goalX = pos.x + p.move.vel.x * 2; goalZ = pos.z + p.move.vel.z * 2; }
  } else {
    const wp = w.waypoints[b.wp];
    goalX = wp.x; goalZ = wp.z;
    if (Math.hypot(wp.x - pos.x, wp.z - pos.z) < 260) b.wp = (b.wp + 1) % w.waypoints.length;
  }

  /* --------------------------------------------------- steer around walls */
  let desired = Math.atan2(-(goalX - pos.x), -(goalZ - pos.z));
  const probe = clamp(60 + speed * 0.5, 80, 320);
  const eyeY = pos.y + 10;
  if (blocked(w, pos.x, eyeY, pos.z, pos.x - Math.sin(desired) * probe, eyeY, pos.z - Math.cos(desired) * probe)) {
    let found = false;
    for (const off of [0.45, -0.45, 0.9, -0.9, 1.45, -1.45, 2.2, -2.2]) {
      const a = desired + off;
      if (!blocked(w, pos.x, eyeY, pos.z, pos.x - Math.sin(a) * probe, eyeY, pos.z - Math.cos(a) * probe)) {
        desired = a; found = true; break;
      }
    }
    if (!found) desired += 2.6;
    if (b.jumpCd <= 0 && p.move.grounded && Math.random() < 0.5) { b.jumpCd = 1.4; CMD.jump = true; }
  }

  // Bots are bound by the same turn-rate reality as players: no snap aiming.
  const aimRate = lerp(3.0, 7.5, skill);
  b.aimYaw += clamp(angleDelta(b.aimYaw, desired), -aimRate * dt, aimRate * dt);

  /* ------------------------------------------------- grapple (skilled bots) */
  // Better bots use the hook to close ground and to keep their speed up. They
  // aim slightly high so they catch rooftops and gantries rather than kerbs.
  b.grappleCd -= dt;
  let wantGrapple = false;
  if (p.grapple.state === GSTATE.IDLE) {
    const eager = skill > 0.55 && b.grappleCd <= 0 && (speed < 330 || (alive && b.targetId != null));
    if (eager && Math.random() < 0.03) {
      wantGrapple = true;
      b.grapplePitch = 0.18 + Math.random() * 0.34;
      b.grappleCd = lerp(9, 3.5, skill) + Math.random() * 3;
    }
  } else if (p.grapple.state === GSTATE.ATTACHED) {
    // Let go once the swing has paid off, or immediately if a target is close.
    if (p.grapple.time > lerp(1.6, 0.8, skill) || (alive && Math.hypot(
      sim.players.get(b.targetId).move.pos.x - pos.x,
      sim.players.get(b.targetId).move.pos.z - pos.z) < 160)) {
      wantGrapple = true;
    }
  }

  /* ------------------------------------------------------------- command */
  CMD.seq = 0;
  CMD.yaw = b.aimYaw;
  CMD.pitch = wantGrapple && p.grapple.state === GSTATE.IDLE ? b.grapplePitch : 0;
  CMD.grapple = wantGrapple;
  CMD.mz = 1;
  CMD.mx = alive && Math.hypot(goalX - pos.x, goalZ - pos.z) < 400 ? b.strafe * 0.6 : 0;
  CMD.sprint = wantSprint;
  CMD.attack = wantAttack;
  CMD.sheathe = false;
  if (CMD.jump === undefined) CMD.jump = false;

  // Draw the blade once a fight is actually on; otherwise stay sheathed for the
  // iai opener.
  if (b.wantDraw && alive && p.combat.state === WSTATE.SHEATHED && Math.random() < 0.02) {
    CMD.sheathe = true;
  }

  const out = { ...CMD };
  CMD.jump = false;
  return out;
}

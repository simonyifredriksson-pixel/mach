/**
 * Procedural item icons. Every cosmetic gets a drawn card image derived from
 * its own spec colours, so the crate reel, the locker and the reveal all show
 * the actual item rather than a placeholder box.
 */

import { RARITY } from '../economy/Rarity.js';

const cache = new Map();
const SIZE = 128;

const hex = (n) => '#' + (n >>> 0).toString(16).padStart(6, '0').slice(-6);

function base(g, item) {
  const r = RARITY[item.rarity];
  const grd = g.createLinearGradient(0, 0, 0, SIZE);
  grd.addColorStop(0, r.dim);
  grd.addColorStop(1, '#0c0d11');
  g.fillStyle = grd;
  g.fillRect(0, 0, SIZE, SIZE);
  // halftone
  g.fillStyle = 'rgba(255,255,255,0.05)';
  for (let y = 0; y < SIZE; y += 7) {
    for (let x = (y / 7) % 2 ? 3.5 : 0; x < SIZE; x += 7) {
      const d = 1 + 1.6 * (1 - y / SIZE);
      g.beginPath(); g.arc(x, y, d, 0, 6.28); g.fill();
    }
  }
  // corner wedge in the rarity colour
  g.fillStyle = r.color;
  g.beginPath();
  g.moveTo(SIZE, SIZE); g.lineTo(SIZE, SIZE - 26); g.lineTo(SIZE - 26, SIZE);
  g.closePath(); g.fill();
}

function katanaIcon(g, item) {
  const s = item.spec;
  const cx = SIZE / 2, cy = SIZE / 2;
  g.save();
  g.translate(cx, cy);
  g.rotate(-Math.PI / 4);
  const len = Math.min(56, 30 + (s.blade.len ?? 11) * 2.1);
  const w = Math.max(2.4, (s.blade.width ?? 0.62) * 8);

  // blade
  if (!s.blade.invisible) {
    g.fillStyle = hex(s.blade.color);
    g.beginPath();
    g.moveTo(-w, -6);
    g.quadraticCurveTo(-w - (s.blade.curve ?? 0.9) * 2.2, -len * 0.6, -w * 0.4, -len);
    g.lineTo(w * 0.2, -len + 3);
    g.quadraticCurveTo(w - (s.blade.curve ?? 0.9) * 1.2, -len * 0.55, w, -6);
    g.closePath();
    g.fill();
    if (s.blade.emissive) {
      g.globalAlpha = 0.55;
      g.shadowColor = hex(s.blade.emissive);
      g.shadowBlur = 14;
      g.fill();
      g.shadowBlur = 0;
      g.globalAlpha = 1;
    }
    g.strokeStyle = 'rgba(255,255,255,0.55)';
    g.lineWidth = 1;
    g.beginPath();
    g.moveTo(-w * 0.45, -8);
    g.quadraticCurveTo(-w, -len * 0.6, -w * 0.3, -len + 4);
    g.stroke();
  } else {
    g.strokeStyle = 'rgba(255,255,255,0.35)';
    g.setLineDash([3, 5]);
    g.lineWidth = 2;
    g.beginPath(); g.moveTo(0, -8); g.lineTo(0, -len); g.stroke();
    g.setLineDash([]);
  }

  // guard
  g.fillStyle = hex(s.fittings ?? 0x2a2c32);
  const shape = s.tsuba ?? 'disc';
  if (shape === 'square') g.fillRect(-9, -7, 18, 5);
  else if (shape === 'cross') { g.fillRect(-11, -6.5, 22, 4); g.fillRect(-2, -12, 4, 14); }
  else if (shape === 'none') { /* nothing */ }
  else if (shape === 'sun') {
    g.beginPath(); g.arc(0, -4, 8.5, 0, 6.28); g.fill();
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * 6.28;
      g.beginPath();
      g.moveTo(Math.cos(a) * 8, -4 + Math.sin(a) * 8);
      g.lineTo(Math.cos(a) * 12.5, -4 + Math.sin(a) * 12.5);
      g.lineWidth = 2; g.strokeStyle = hex(s.fittings ?? 0x2a2c32); g.stroke();
    }
  } else if (shape === 'ring') {
    g.lineWidth = 3; g.strokeStyle = hex(s.fittings ?? 0x2a2c32);
    g.beginPath(); g.arc(0, -4, 7.5, 0, 6.28); g.stroke();
  } else { g.beginPath(); g.ellipse(0, -4, 9, 3.4, 0, 0, 6.28); g.fill(); }

  // handle
  g.fillStyle = hex(s.wrap ?? 0x14151a);
  g.fillRect(-2.6, -2, 5.2, 24);
  g.fillStyle = hex(s.fittings ?? 0x2a2c32);
  for (let i = 0; i < 5; i++) {
    g.save();
    g.translate(0, 2 + i * 4.4);
    g.rotate(Math.PI / 4);
    g.fillRect(-1.7, -1.7, 3.4, 3.4);
    g.restore();
  }
  g.fillRect(-3.2, 21, 6.4, 3);
  g.restore();
}

function figureIcon(g, item) {
  const s = item.spec;
  g.save();
  g.translate(SIZE / 2, SIZE / 2 + 6);
  // body
  g.fillStyle = hex(s.suit);
  g.fillRect(-14, -18, 28, 26);
  g.fillRect(-10, 8, 9, 22);
  g.fillRect(1, 8, 9, 22);
  // arms
  g.fillStyle = hex(s.trim);
  g.fillRect(-20, -16, 6, 24);
  g.fillRect(14, -16, 6, 24);
  // chest plate
  g.fillStyle = hex(s.accent);
  g.fillRect(-9, -13, 18, 11);
  // head
  g.fillStyle = hex(s.suit);
  g.fillRect(-9, -38, 18, 18);
  g.fillStyle = hex(s.visor);
  g.fillRect(-7, -32, 14, 5);
  if (s.coat) {
    g.fillStyle = hex(s.cloth);
    g.globalAlpha = 0.9;
    g.beginPath();
    g.moveTo(-14, -16); g.lineTo(-22, 34); g.lineTo(22, 34); g.lineTo(14, -16);
    g.closePath(); g.fill();
    g.globalAlpha = 1;
  }
  if (s.ghost) {
    g.globalAlpha = 0.28;
    for (let i = 1; i <= 2; i++) { g.translate(-9, 0); g.fillStyle = '#ffffff'; g.fillRect(-14, -38, 28, 68); }
    g.globalAlpha = 1;
  }
  g.restore();
}

function swooshIcon(g, item, style) {
  const c = hex(item.spec.color);
  g.save();
  g.translate(SIZE / 2, SIZE / 2);
  g.strokeStyle = c;
  g.lineCap = 'round';
  if (style === 'trail') {
    for (let i = 0; i < 4; i++) {
      g.globalAlpha = 1 - i * 0.22;
      g.lineWidth = 11 - i * 2.4;
      g.beginPath();
      g.moveTo(-46 + i * 5, 16 - i * 3);
      g.quadraticCurveTo(-4, 26 - i * 4, 44, -18 - i * 3);
      g.stroke();
    }
  } else if (style === 'slash') {
    g.lineWidth = 9;
    g.beginPath();
    g.arc(0, 8, 40, Math.PI * 1.15, Math.PI * 1.85);
    g.stroke();
    g.globalAlpha = 0.5;
    g.lineWidth = 3;
    g.beginPath();
    g.arc(0, 12, 48, Math.PI * 1.2, Math.PI * 1.8);
    g.stroke();
  } else if (style === 'kill') {
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * 6.28;
      g.globalAlpha = 0.5 + (i % 3) * 0.2;
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(Math.cos(a) * 12, Math.sin(a) * 12);
      g.lineTo(Math.cos(a) * (28 + (i % 4) * 9), Math.sin(a) * (28 + (i % 4) * 9));
      g.stroke();
    }
  } else if (style === 'spawn') {
    g.lineWidth = 5;
    for (let i = 0; i < 3; i++) {
      g.globalAlpha = 1 - i * 0.28;
      g.beginPath(); g.ellipse(0, 22 - i * 4, 34 - i * 8, 11 - i * 2.5, 0, 0, 6.28); g.stroke();
    }
    g.globalAlpha = 1;
    g.beginPath(); g.moveTo(0, -34); g.lineTo(0, 10); g.stroke();
    g.beginPath(); g.moveTo(-10, 0); g.lineTo(0, 12); g.lineTo(10, 0); g.stroke();
  }
  g.restore();
}

function sheathIcon(g, item) {
  const s = item.spec;
  g.save();
  g.translate(SIZE / 2, SIZE / 2);
  g.rotate(-Math.PI / 4);
  g.fillStyle = hex(s.color);
  g.fillRect(-5, -48, 10, 92);
  g.fillStyle = hex(s.trim);
  for (let i = 0; i < 4; i++) g.fillRect(-6.5, -40 + i * 24, 13, 4);
  g.fillRect(-6.5, -50, 13, 5);
  g.restore();
}

/** Returns a data URL for the item's card art (cached). */
export function iconFor(item) {
  const key = item.type + ':' + item.id;
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas');
  c.width = c.height = SIZE;
  const g = c.getContext('2d');
  base(g, item);
  switch (item.type) {
    case 'katana': katanaIcon(g, item); break;
    case 'skin': figureIcon(g, item); break;
    case 'trail': swooshIcon(g, item, 'trail'); break;
    case 'slash': swooshIcon(g, item, 'slash'); break;
    case 'kill': swooshIcon(g, item, 'kill'); break;
    case 'spawn': swooshIcon(g, item, 'spawn'); break;
    case 'sheath': sheathIcon(g, item); break;
  }
  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}

/** Crate box art — themed per case, drawn rather than shipped. */
export function crateArt(crate, size = 320) {
  const key = 'crate:' + crate.id + ':' + size;
  if (cache.has(key)) return cache.get(key);
  const c = document.createElement('canvas');
  c.width = size; c.height = size;
  const g = c.getContext('2d');
  const S = size;

  g.fillStyle = crate.ink;
  g.fillRect(0, 0, S, S);

  // body
  const pad = S * 0.12;
  g.fillStyle = '#1a1c22';
  g.fillRect(pad, pad * 1.4, S - pad * 2, S - pad * 2.6);
  g.strokeStyle = crate.accent;
  g.lineWidth = S * 0.018;
  g.strokeRect(pad, pad * 1.4, S - pad * 2, S - pad * 2.6);

  // lid
  g.fillStyle = '#23262e';
  g.fillRect(pad, pad * 1.4, S - pad * 2, S * 0.18);
  g.fillStyle = crate.accent;
  g.fillRect(pad, pad * 1.4 + S * 0.18, S - pad * 2, S * 0.016);

  // motif
  g.save();
  g.translate(S / 2, S * 0.60);
  if (crate.motif === 'chevron') {
    g.fillStyle = crate.accent;
    for (let i = 0; i < 3; i++) {
      g.beginPath();
      const o = -S * 0.10 + i * S * 0.09;
      g.moveTo(-S * 0.16, o); g.lineTo(0, o + S * 0.09); g.lineTo(S * 0.16, o);
      g.lineTo(S * 0.16, o + S * 0.04); g.lineTo(0, o + S * 0.13); g.lineTo(-S * 0.16, o + S * 0.04);
      g.closePath(); g.fill();
    }
  } else if (crate.motif === 'grid') {
    g.strokeStyle = crate.accent;
    g.lineWidth = S * 0.012;
    for (let i = -2; i <= 2; i++) {
      g.beginPath(); g.moveTo(i * S * 0.07, -S * 0.15); g.lineTo(i * S * 0.07, S * 0.15); g.stroke();
      g.beginPath(); g.moveTo(-S * 0.15, i * S * 0.07); g.lineTo(S * 0.15, i * S * 0.07); g.stroke();
    }
    g.fillStyle = crate.accent;
    g.fillRect(-S * 0.04, -S * 0.04, S * 0.08, S * 0.08);
  } else {
    g.fillStyle = crate.accent;
    g.beginPath(); g.arc(0, 0, S * 0.14, 0, 6.28); g.fill();
    g.fillStyle = crate.ink;
    g.font = `bold ${Math.round(S * 0.16)}px "Archivo Black", Impact, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('斬', 0, S * 0.01);
  }
  g.restore();

  // hazard stripe foot
  g.save();
  g.beginPath(); g.rect(pad, S - pad * 1.5, S - pad * 2, S * 0.07); g.clip();
  g.fillStyle = crate.accent;
  g.fillRect(pad, S - pad * 1.5, S - pad * 2, S * 0.07);
  g.fillStyle = crate.ink;
  for (let x = -S; x < S * 2; x += S * 0.08) {
    g.beginPath();
    g.moveTo(x, S); g.lineTo(x + S * 0.04, S); g.lineTo(x + S * 0.04 + S * 0.07, S - pad * 1.5);
    g.lineTo(x + S * 0.07, S - pad * 1.5); g.closePath(); g.fill();
  }
  g.restore();

  // label
  g.fillStyle = '#0d0e12';
  g.fillRect(pad * 0.7, S * 0.30, S - pad * 1.4, S * 0.09);
  g.fillStyle = '#f3f4f6';
  g.font = `bold ${Math.round(S * 0.055)}px "Barlow Condensed", Impact, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(crate.name, S / 2, S * 0.345);

  const url = c.toDataURL();
  cache.set(key, url);
  return url;
}

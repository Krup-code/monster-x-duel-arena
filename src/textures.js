// Procedural PBR texture + material library. Every surface in the game is generated at load
// time (albedo, normal and packed AO/roughness/metalness maps), so the game downloads no
// image assets. Texture resolution follows the "Texture quality" setting.
import * as THREE from 'three';
import { PALETTE } from './config.js';

// ---------- noise ----------
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function valueNoise(size, period, seed) {
  const r = mulberry32(seed);
  const lat = new Float32Array(period * period);
  for (let i = 0; i < lat.length; i++) lat[i] = r();
  const out = new Float32Array(size * size);
  const s = period / size;
  for (let y = 0; y < size; y++) {
    const fy = y * s, iy = Math.floor(fy), ty = fy - iy;
    const sy = ty * ty * (3 - 2 * ty);
    const y0 = (iy % period) * period, y1 = ((iy + 1) % period) * period;
    for (let x = 0; x < size; x++) {
      const fx = x * s, ix = Math.floor(fx), tx = fx - ix;
      const sx = tx * tx * (3 - 2 * tx);
      const x0 = ix % period, x1 = (ix + 1) % period;
      const a = lat[y0 + x0], b = lat[y0 + x1], c = lat[y1 + x0], d = lat[y1 + x1];
      out[y * size + x] = a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy;
    }
  }
  return out;
}

function fbm(size, basePeriod, octaves, seed, gain = 0.5) {
  const out = new Float32Array(size * size);
  let amp = 1, total = 0, period = basePeriod;
  for (let o = 0; o < octaves; o++) {
    if (period > size) break;
    const n = valueNoise(size, period, seed + o * 1013);
    for (let i = 0; i < out.length; i++) out[i] += n[i] * amp;
    total += amp;
    amp *= gain;
    period *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= total;
  return out;
}

// ---------- canvas helpers ----------
function canvas(size, h = size) {
  const c = document.createElement('canvas');
  c.width = size; c.height = h;
  return c;
}

function readGray(c) {
  const ctx = c.getContext('2d');
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const out = new Float32Array(c.width * c.height);
  for (let i = 0; i < out.length; i++) out[i] = d[i * 4] / 255;
  return out;
}

function normalFromHeight(h, size, strength) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let y = 0; y < size; y++) {
    const ym = ((y - 1 + size) % size) * size, yp = ((y + 1) % size) * size, yc = y * size;
    for (let x = 0; x < size; x++) {
      const xm = (x - 1 + size) % size, xp = (x + 1) % size;
      const dx = (h[yc + xp] - h[yc + xm]) * strength;
      const dy = (h[yp + x] - h[ym + x]) * strength;
      const inv = 1 / Math.sqrt(dx * dx + dy * dy + 1);
      const i = (yc + x) * 4;
      d[i] = (-dx * inv * 0.5 + 0.5) * 255;
      d[i + 1] = (dy * inv * 0.5 + 0.5) * 255;
      d[i + 2] = (inv * 0.5 + 0.5) * 255;
      d[i + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Pack AO (R), roughness (G), metalness (B).
function ormCanvas(size, ao, rough, metal) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  for (let i = 0; i < size * size; i++) {
    d[i * 4] = (typeof ao === 'number' ? ao : ao[i]) * 255;
    d[i * 4 + 1] = (typeof rough === 'number' ? rough : rough[i]) * 255;
    d[i * 4 + 2] = (typeof metal === 'number' ? metal : metal[i]) * 255;
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

function albedoFrom(size, fn) {
  const c = canvas(size);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(size, size);
  const d = img.data;
  const col = [0, 0, 0];
  // Authoring values are "perceptual darkness"; lift them so dark surfaces still have a
  // physically plausible albedo (sRGB 30 would be ~1% reflectance and read as pure black).
  const lift = (v) => 255 * Math.pow(Math.max(0, Math.min(255, v)) / 255, 0.62);
  for (let i = 0; i < size * size; i++) {
    fn(i, col);
    d[i * 4] = lift(col[0]);
    d[i * 4 + 1] = lift(col[1]);
    d[i * 4 + 2] = lift(col[2]);
    d[i * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

// ---------- texture sets ----------
function concreteSet(size, seed) {
  const big = fbm(size, 4, 5, seed);
  const fine = fbm(size, 32, 3, seed + 7);
  // Height canvas: expansion joints + cracks
  const hc = canvas(size);
  const g = hc.getContext('2d');
  g.fillStyle = '#808080'; g.fillRect(0, 0, size, size);
  g.strokeStyle = '#3a3a3a'; g.lineWidth = Math.max(2, size / 220);
  g.beginPath(); g.moveTo(size / 2, 0); g.lineTo(size / 2, size); g.moveTo(0, size / 2); g.lineTo(size, size / 2); g.stroke();
  const r = mulberry32(seed + 3);
  g.strokeStyle = '#555'; g.lineWidth = Math.max(1, size / 512);
  for (let k = 0; k < 6; k++) {
    let x = r() * size, y = r() * size;
    g.beginPath(); g.moveTo(x, y);
    for (let s = 0; s < 18; s++) { x += (r() - 0.5) * size * 0.06; y += (r() - 0.3) * size * 0.05; g.lineTo(x, y); }
    g.stroke();
  }
  const hd = readGray(hc);
  const h = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) {
    h[i] = hd[i] * 0.7 + fine[i] * 0.3;
    const wet = clamp01((big[i] - 0.58) * 6);
    rough[i] = 0.92 - wet * 0.45 - fine[i] * 0.06;
    ao[i] = 0.75 + hd[i] * 0.25;
  }
  const albedo = albedoFrom(size, (i, c) => {
    const v = 30 + big[i] * 26 + fine[i] * 14 - (1 - hd[i] * 2) * 10;
    const wet = clamp01((big[i] - 0.58) * 6);
    c[0] = v * (1 - wet * 0.35); c[1] = v * (1.02 - wet * 0.33); c[2] = v * (1.0 - wet * 0.3);
  });
  return { albedo, normal: normalFromHeight(h, size, size / 90), orm: ormCanvas(size, ao, rough, 0) };
}

function diamondPlateSet(size, seed) {
  const grime = fbm(size, 4, 5, seed);
  const fine = fbm(size, 64, 2, seed + 5);
  const h = new Float32Array(size * size);
  const n = 8; // diamonds per side
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x / size) * n, v = (y / size) * n;
      const cu = Math.floor(u), cv = Math.floor(v);
      const fu = u - cu - 0.5, fv = v - cv - 0.5;
      const flip = (cu + cv) & 1;
      // Elongated lozenge rotated ±45°
      const a = flip ? (fu + fv) : (fu - fv);
      const b = flip ? (fu - fv) : (fu + fv);
      const d = Math.abs(a) / 0.42 + Math.abs(b) / 0.1;
      h[y * size + x] = d < 1 ? 1 - d * d * 0.6 : 0;
    }
  }
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  for (let i = 0; i < h.length; i++) {
    const g = clamp01((grime[i] - 0.45) * 2.2);
    rough[i] = 0.42 + g * 0.35 - h[i] * 0.12 + fine[i] * 0.05;
    metal[i] = 0.92 - g * 0.4;
  }
  const albedo = albedoFrom(size, (i, c) => {
    const g = clamp01((grime[i] - 0.45) * 2.2);
    const v = 70 + h[i] * 35 + fine[i] * 15 - g * 40;
    c[0] = v; c[1] = v * 1.03; c[2] = v * 1.05;
  });
  for (let i = 0; i < h.length; i++) h[i] = h[i] * 0.8 + fine[i] * 0.2;
  return { albedo, normal: normalFromHeight(h, size, size / 40), orm: ormCanvas(size, 1, rough, metal) };
}

function grateSet(size, seed) {
  const cells = 12;
  const fine = fbm(size, 32, 3, seed);
  const h = new Float32Array(size * size);
  const alpha = canvas(size);
  const actx = alpha.getContext('2d');
  const aimg = actx.createImageData(size, size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = ((x / size) * cells) % 1, v = ((y / size) * cells) % 1;
      const du = Math.min(u, 1 - u), dv = Math.min(v, 1 - v);
      const bar = Math.min(du, dv);
      const solid = bar < 0.11 ? 1 : 0;
      // Main structural bars every 4 cells are thicker
      const mu = ((x / size) * (cells / 4)) % 1, mv = ((y / size) * (cells / 4)) % 1;
      const main = Math.min(Math.min(mu, 1 - mu), Math.min(mv, 1 - mv)) < 0.02 ? 1 : 0;
      const s = Math.max(solid, main);
      const i = y * size + x;
      h[i] = s ? 0.6 + (0.11 - Math.min(bar, 0.11)) * 3 : 0;
      const a = i * 4;
      aimg.data[a] = aimg.data[a + 1] = aimg.data[a + 2] = s ? 255 : 0;
      aimg.data[a + 3] = 255;
    }
  }
  actx.putImageData(aimg, 0, 0);
  const albedo = albedoFrom(size, (i, c) => {
    const v = 52 + fine[i] * 30 + h[i] * 20;
    c[0] = v; c[1] = v * 1.04; c[2] = v * 1.02;
  });
  const rough = new Float32Array(size * size);
  for (let i = 0; i < rough.length; i++) rough[i] = 0.45 + fine[i] * 0.2;
  return { albedo, normal: normalFromHeight(h, size, size / 60), orm: ormCanvas(size, 1, rough, 0.9), alpha };
}

function wallPanelSet(size, seed) {
  const grime = fbm(size, 4, 5, seed);
  const fine = fbm(size, 48, 3, seed + 9);
  // vertical streaks
  const streak = new Float32Array(size * size);
  const sn = valueNoise(size, 64, seed + 21);
  const sv = fbm(size, 4, 3, seed + 33);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    streak[y * size + x] = sn[(Math.floor(y * 0.02) % size) * size + x] * sv[y * size + x];
  }
  const hc = canvas(size);
  const g = hc.getContext('2d');
  g.fillStyle = '#909090'; g.fillRect(0, 0, size, size);
  const half = size / 2;
  const seam = Math.max(3, size / 128);
  // Panel seams
  g.fillStyle = '#202020';
  for (const p of [0, half]) { g.fillRect(p - seam / 2, 0, seam, size); g.fillRect(0, p - seam / 2, size, seam); }
  g.fillRect(size - seam / 2, 0, seam, size); g.fillRect(0, size - seam / 2, size, seam);
  // Inset sub-panel on two panels
  g.fillStyle = '#7a7a7a';
  g.fillRect(size * 0.06, size * 0.06, half * 0.76, half * 0.76);
  g.fillStyle = '#9c9c9c';
  g.fillRect(half + size * 0.04, half + size * 0.04, half * 0.84, half * 0.3);
  // Vent slots
  g.fillStyle = '#303030';
  for (let k = 0; k < 7; k++) g.fillRect(half + size * 0.08, half + size * 0.25 + k * size * 0.03, half * 0.7, size * 0.012);
  // Rivets
  g.fillStyle = '#d0d0d0';
  const rr = Math.max(1.5, size / 300);
  for (const px of [0, half]) for (const py of [0, half]) {
    for (let k = 0; k < 6; k++) {
      const t = (k + 0.5) / 6;
      for (const [x, y] of [[px + t * half, py + size * 0.02], [px + t * half, py + half - size * 0.02], [px + size * 0.02, py + t * half], [px + half - size * 0.02, py + t * half]]) {
        g.beginPath(); g.arc(x, y, rr, 0, Math.PI * 2); g.fill();
      }
    }
  }
  const hd = readGray(hc);
  const h = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  const ao = new Float32Array(size * size);
  const r = mulberry32(seed + 77);
  const tints = [0, 1, 2, 3].map(() => 0.85 + r() * 0.3);
  for (let i = 0; i < h.length; i++) {
    const wear = clamp01((fine[i] - 0.62) * 5) * (hd[i] > 0.85 ? 1 : 0.3);
    h[i] = hd[i] * 0.85 + fine[i] * 0.15;
    rough[i] = 0.62 + grime[i] * 0.2 - wear * 0.3 - streak[i] * 0.1;
    metal[i] = 0.35 + wear * 0.6;
    ao[i] = hd[i] < 0.3 ? 0.4 : 0.85 + hd[i] * 0.15;
  }
  const albedo = albedoFrom(size, (i, c) => {
    const x = i % size, y = (i / size) | 0;
    const panel = (x < half ? 0 : 1) + (y < half ? 0 : 2);
    const t = tints[panel];
    const wear = clamp01((fine[i] - 0.62) * 5) * (hd[i] > 0.85 ? 1 : 0.3);
    const base = (24 + grime[i] * 14 - streak[i] * 12) * t;
    c[0] = base * 0.95 + wear * 60; c[1] = base * 1.02 + wear * 62; c[2] = base * 1.0 + wear * 64;
    if (hd[i] < 0.3) { c[0] *= 0.4; c[1] *= 0.4; c[2] *= 0.4; }
  });
  return { albedo, normal: normalFromHeight(h, size, size / 70), orm: ormCanvas(size, ao, rough, metal) };
}

function hazardSet(size, seed) {
  const fine = fbm(size, 32, 4, seed);
  const scratches = fbm(size, 128, 2, seed + 3);
  const h = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  const albedo = albedoFrom(size, (i, c) => {
    const x = i % size, y = (i / size) | 0;
    const stripe = (((x + y) / size) * 6) % 1 < 0.5;
    const worn = fine[i] * 0.7 + scratches[i] * 0.3 > 0.66;
    h[i] = worn ? 0.3 : 0.7;
    rough[i] = worn ? 0.35 : 0.6;
    metal[i] = worn ? 0.9 : 0.2;
    if (worn) { c[0] = 92; c[1] = 96; c[2] = 98; }
    else if (stripe) { c[0] = 92; c[1] = 196; c[2] = 22; }
    else { c[0] = c[1] = c[2] = 14; }
    const d = 0.8 + fine[i] * 0.3;
    c[0] *= d; c[1] *= d; c[2] *= d;
  });
  return { albedo, normal: normalFromHeight(h, size, size / 160), orm: ormCanvas(size, 1, rough, metal) };
}

function corrugatedSet(size, seed) {
  const grime = fbm(size, 4, 5, seed);
  const fine = fbm(size, 48, 3, seed + 2);
  const rust = fbm(size, 8, 4, seed + 4);
  const h = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  const metal = new Float32Array(size * size);
  const ribs = 16;
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    const u = (x / size) * ribs;
    const prof = Math.abs(((u % 1) - 0.5) * 2); // trapezoid-ish
    const rib = Math.min(1, Math.max(0, (prof - 0.25) * 2));
    const frame = y < size * 0.04 || y > size * 0.96 ? 1 : 0;
    h[i] = frame ? 1 : rib * 0.8 + fine[i] * 0.1;
    const r = clamp01((rust[i] - 0.6) * 4);
    rough[i] = 0.55 + r * 0.35 + grime[i] * 0.1;
    metal[i] = 0.6 - r * 0.5;
  }
  const albedo = albedoFrom(size, (i, c) => {
    const y = (i / size) | 0;
    const r = clamp01((rust[i] - 0.6) * 4);
    const streak = clamp01((grime[i] - 0.5) * 2) * (y / size);
    const v = 150 + fine[i] * 50 - streak * 70;
    c[0] = v * (1 - r) + 110 * r; c[1] = v * (1 - r) + 60 * r; c[2] = v * (1 - r) + 30 * r;
  });
  return { albedo, normal: normalFromHeight(h, size, size / 50), orm: ormCanvas(size, 1, rough, metal) };
}

function brushedSet(size, seed) {
  const r = mulberry32(seed);
  const lines = new Float32Array(size);
  for (let y = 0; y < size; y++) lines[y] = r();
  const grime = fbm(size, 4, 4, seed + 1);
  const h = new Float32Array(size * size);
  const rough = new Float32Array(size * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = y * size + x;
    h[i] = lines[y] * 0.3;
    rough[i] = 0.26 + lines[y] * 0.12 + grime[i] * 0.15;
  }
  const albedo = albedoFrom(size, (i, c) => {
    const y = (i / size) | 0;
    const v = 120 + lines[y] * 40 - grime[i] * 40;
    c[0] = v; c[1] = v * 1.02; c[2] = v * 1.05;
  });
  return { albedo, normal: normalFromHeight(h, size, size / 300), orm: ormCanvas(size, 1, rough, 1) };
}

function gravelSet(size, seed) {
  const r = mulberry32(seed);
  const hc = canvas(size);
  const ac = canvas(size);
  const g = hc.getContext('2d'), a = ac.getContext('2d');
  g.fillStyle = '#202020'; g.fillRect(0, 0, size, size);
  a.fillStyle = '#1c1b19'; a.fillRect(0, 0, size, size);
  const count = Math.floor(size * size / 90);
  for (let k = 0; k < count; k++) {
    const x = r() * size, y = r() * size, rad = (0.4 + r() * 1.0) * size / 96;
    for (const [ox, oy] of [[0, 0], [size, 0], [-size, 0], [0, size], [0, -size]]) {
      const gr = g.createRadialGradient(x + ox - rad * 0.3, y + oy - rad * 0.3, 0, x + ox, y + oy, rad);
      gr.addColorStop(0, '#ffffff'); gr.addColorStop(1, '#303030');
      g.fillStyle = gr; g.beginPath(); g.ellipse(x + ox, y + oy, rad, rad * (0.7 + r() * 0.3), r() * 3, 0, Math.PI * 2); g.fill();
      const v = 40 + r() * 50, w = r() * 12;
      a.fillStyle = `rgb(${v + w},${v + w * 0.6},${v})`;
      a.beginPath(); a.ellipse(x + ox, y + oy, rad, rad * 0.85, r() * 3, 0, Math.PI * 2); a.fill();
    }
  }
  const h = readGray(hc);
  const rough = new Float32Array(size * size).fill(0.93);
  const ao = new Float32Array(size * size);
  for (let i = 0; i < ao.length; i++) ao[i] = 0.5 + h[i] * 0.5;
  return { albedo: ac, normal: normalFromHeight(h, size, size / 45), orm: ormCanvas(size, ao, rough, 0) };
}

function noiseSet(size, seed, base, roughBase, metal, contrast = 30) {
  const n = fbm(size, 8, 5, seed);
  const albedo = albedoFrom(size, (i, c) => {
    const v = n[i] * contrast - contrast / 2;
    c[0] = base[0] + v; c[1] = base[1] + v; c[2] = base[2] + v;
  });
  const rough = new Float32Array(size * size);
  for (let i = 0; i < rough.length; i++) rough[i] = roughBase + (n[i] - 0.5) * 0.2;
  return { albedo, normal: normalFromHeight(n, size, size / 200), orm: ormCanvas(size, 1, rough, metal) };
}

// ---------- signs, graffiti, decals, sprites ----------
const FONT = '"Teko", "Rajdhani", "Arial Narrow", Impact, sans-serif';

export function drawXEmblem(ctx, cx, cy, s, color = '#7dff1a', glow = true) {
  // Original angular "X" mark made of two serrated blades inside a hex badge.
  ctx.save();
  ctx.translate(cx, cy);
  if (glow) { ctx.shadowColor = color; ctx.shadowBlur = s * 0.25; }
  ctx.strokeStyle = color; ctx.lineWidth = s * 0.07;
  ctx.beginPath();
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    const x = Math.cos(a) * s, y = Math.sin(a) * s;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath(); ctx.stroke();
  ctx.fillStyle = color;
  const blade = (flip) => {
    ctx.save();
    ctx.scale(flip, 1);
    ctx.beginPath();
    ctx.moveTo(-s * 0.62, -s * 0.7);
    ctx.lineTo(-s * 0.36, -s * 0.7);
    ctx.lineTo(-s * 0.1, -s * 0.28);
    ctx.lineTo(-s * 0.02, -s * 0.38);
    ctx.lineTo(s * 0.08, -s * 0.12);
    ctx.lineTo(s * 0.62, s * 0.7);
    ctx.lineTo(s * 0.36, s * 0.7);
    ctx.lineTo(s * 0.08, s * 0.24);
    ctx.lineTo(-s * 0.02, s * 0.34);
    ctx.lineTo(-s * 0.1, s * 0.1);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };
  blade(1); blade(-1);
  ctx.restore();
}

function signTexture(w, h, draw) {
  const c = canvas(w, h);
  const ctx = c.getContext('2d');
  draw(ctx, w, h);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

function makeSigns() {
  const S = {};
  S.logo = signTexture(1024, 384, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    drawXEmblem(g, h * 0.5, h * 0.5, h * 0.38);
    g.shadowColor = '#7dff1a'; g.shadowBlur = 24;
    g.fillStyle = '#7dff1a';
    g.font = `700 ${h * 0.56}px ${FONT}`;
    g.textBaseline = 'middle';
    g.fillText('MONSTER-X', h * 1.0, h * 0.44);
    g.shadowBlur = 8;
    g.fillStyle = '#f2f5f0';
    g.font = `600 ${h * 0.2}px ${FONT}`;
    g.fillText('E N E R G Y', h * 1.05, h * 0.82);
  });
  S.facility = signTexture(1024, 256, (g, w, h) => {
    g.fillStyle = '#050605'; g.fillRect(0, 0, w, h);
    g.strokeStyle = '#7dff1a'; g.lineWidth = 6; g.strokeRect(10, 10, w - 20, h - 20);
    g.shadowColor = '#7dff1a'; g.shadowBlur = 18; g.fillStyle = '#7dff1a';
    g.font = `700 ${h * 0.5}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('THE BLACKOUT FACILITY', w / 2, h * 0.45);
    g.shadowBlur = 0; g.fillStyle = '#c8d0c4'; g.font = `500 ${h * 0.16}px ${FONT}`;
    g.fillText('SUBLEVEL 7 · EXTREME KINETICS RESEARCH · DECOMMISSIONED', w / 2, h * 0.8);
  });
  S.voltage = signTexture(512, 256, (g, w, h) => {
    g.fillStyle = '#ff7a1a'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#0b0d0c'; g.fillRect(8, 8, w - 16, h - 16);
    g.fillStyle = '#ff7a1a'; g.font = `700 ${h * 0.34}px ${FONT}`; g.textAlign = 'center';
    g.fillText('⚡ DANGER', w / 2, h * 0.45);
    g.font = `600 ${h * 0.2}px ${FONT}`; g.fillText('HIGH VOLTAGE · 40kV', w / 2, h * 0.78);
  });
  S.reactor = signTexture(1024, 160, (g, w, h) => {
    g.fillStyle = '#0b0d0c'; g.fillRect(0, 0, w, h);
    for (let x = -h; x < w; x += 40) { g.fillStyle = '#7dff1a'; g.beginPath(); g.moveTo(x, h); g.lineTo(x + 20, h); g.lineTo(x + 20 + h * 0.25, h * 0.75); g.lineTo(x + h * 0.25, h * 0.75); g.fill(); }
    g.fillStyle = '#f2f5f0'; g.font = `700 ${h * 0.5}px ${FONT}`; g.textAlign = 'center';
    g.fillText('X-CORE REACTOR · AUTHORIZED PERSONNEL ONLY', w / 2, h * 0.52);
  });
  S.sectorA = signTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#0b0d0c'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#7dff1a'; g.font = `700 ${h * 0.62}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('01', w / 2, h * 0.5);
    g.font = `500 ${h * 0.14}px ${FONT}`; g.fillStyle = '#ddd'; g.fillText('BAY  WEST', w / 2, h * 0.88);
  });
  S.sectorB = signTexture(256, 256, (g, w, h) => {
    g.fillStyle = '#0b0d0c'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#ff8a1f'; g.font = `700 ${h * 0.62}px ${FONT}`; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText('02', w / 2, h * 0.5);
    g.font = `500 ${h * 0.14}px ${FONT}`; g.fillStyle = '#ddd'; g.fillText('BAY  EAST', w / 2, h * 0.88);
  });
  S.arrowUp = signTexture(512, 128, (g, w, h) => {
    g.fillStyle = '#0b0d0c'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#7dff1a'; g.font = `700 ${h * 0.6}px ${FONT}`; g.textBaseline = 'middle';
    g.fillText('▲ CATWALK  ·  ▼ TUNNELS', 24, h * 0.55);
  });
  S.holoAd = signTexture(512, 768, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    // energy can silhouette
    const cx = w / 2, top = h * 0.12, cw = w * 0.36, ch = h * 0.5;
    const grad = g.createLinearGradient(cx - cw / 2, 0, cx + cw / 2, 0);
    grad.addColorStop(0, '#0d1a08'); grad.addColorStop(0.5, '#1f3a10'); grad.addColorStop(1, '#0d1a08');
    g.fillStyle = grad;
    g.beginPath(); g.roundRect(cx - cw / 2, top, cw, ch, 18); g.fill();
    g.strokeStyle = '#7dff1a'; g.lineWidth = 4; g.stroke();
    drawXEmblem(g, cx, top + ch * 0.45, cw * 0.36);
    g.fillStyle = '#7dff1a'; g.shadowColor = '#7dff1a'; g.shadowBlur = 20;
    g.font = `700 ${w * 0.17}px ${FONT}`; g.textAlign = 'center';
    g.fillText('MONSTER-X', cx, h * 0.75);
    g.shadowBlur = 6; g.fillStyle = '#f2f5f0'; g.font = `600 ${w * 0.08}px ${FONT}`;
    g.fillText('UNLEASH THE X', cx, h * 0.83);
    g.font = `500 ${w * 0.05}px ${FONT}`; g.fillStyle = '#a6ff4d';
    g.fillText('ZERO SUGAR · MAXIMUM CHAOS', cx, h * 0.9);
  });
  S.holoAd2 = signTexture(768, 384, (g, w, h) => {
    g.clearRect(0, 0, w, h);
    g.fillStyle = '#7dff1a'; g.shadowColor = '#7dff1a'; g.shadowBlur = 24;
    g.font = `700 ${h * 0.36}px ${FONT}`; g.textAlign = 'center';
    g.fillText('1V1. NO EXCUSES.', w / 2, h * 0.42);
    g.shadowBlur = 8; g.fillStyle = '#f2f5f0'; g.font = `600 ${h * 0.14}px ${FONT}`;
    g.fillText('MONSTER-X DUEL LEAGUE · SEASON 0', w / 2, h * 0.66);
    drawXEmblem(g, w / 2, h * 0.86, h * 0.09);
  });
  S.vending = signTexture(256, 512, (g, w, h) => {
    g.fillStyle = '#060806'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#0f1d0a'; g.fillRect(14, 14, w * 0.62, h * 0.72);
    for (let r = 0; r < 5; r++) for (let c = 0; c < 4; c++) {
      const x = 22 + c * (w * 0.62 - 16) / 4, y = 26 + r * h * 0.135;
      g.fillStyle = (r + c) % 3 === 0 ? '#ff8a1f' : '#7dff1a';
      g.fillRect(x, y, w * 0.1, h * 0.1);
      g.fillStyle = '#000'; g.fillRect(x + w * 0.02, y + h * 0.03, w * 0.06, h * 0.03);
    }
    g.fillStyle = '#7dff1a'; g.font = `700 ${w * 0.16}px ${FONT}`; g.textAlign = 'center';
    g.save(); g.translate(w * 0.86, h * 0.4); g.rotate(-Math.PI / 2); g.fillText('MONSTER-X', 0, 0); g.restore();
    g.fillStyle = '#111'; g.fillRect(14, h * 0.8, w * 0.62, h * 0.14);
    g.fillStyle = '#7dff1a'; g.font = `600 ${w * 0.08}px ${FONT}`; g.fillText('PRESS E', w * 0.36, h * 0.89);
  });
  S.arcade = signTexture(256, 192, (g, w, h) => {
    g.fillStyle = '#020302'; g.fillRect(0, 0, w, h);
    g.fillStyle = '#7dff1a'; g.font = `700 ${h * 0.24}px ${FONT}`; g.textAlign = 'center';
    g.fillText('X-RACER 86', w / 2, h * 0.32);
    g.fillStyle = '#ff8a1f'; g.font = `500 ${h * 0.12}px ${FONT}`;
    g.fillText('HI-SCORE  000915', w / 2, h * 0.52);
    g.fillStyle = '#f2f5f0'; g.fillText('INSERT CAN', w / 2, h * 0.8);
  });
  return S;
}

function graffitiTexture(text, color, w = 1024, h = 384, seed = 1, sub = '') {
  return signTexture(w, h, (g) => {
    const r = mulberry32(seed);
    g.clearRect(0, 0, w, h);
    g.save();
    g.translate(w / 2, h / 2);
    g.rotate((r() - 0.5) * 0.18);
    g.font = `700 ${h * 0.5}px "Permanent Marker", ${FONT}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    // Overspray
    g.shadowColor = color; g.shadowBlur = 14;
    g.lineJoin = 'round';
    g.strokeStyle = '#050605'; g.lineWidth = h * 0.07; g.strokeText(text, 0, 0);
    g.fillStyle = color; g.fillText(text, 0, 0);
    g.shadowBlur = 0;
    // Drips
    g.fillStyle = color;
    const m = g.measureText(text).width;
    for (let k = 0; k < 14; k++) {
      const x = (r() - 0.5) * m, y = h * 0.12 + r() * h * 0.05, len = h * (0.05 + r() * 0.22);
      g.fillRect(x, y, Math.max(2, h * 0.008), len);
      g.beginPath(); g.arc(x + 1, y + len, Math.max(2, h * 0.008), 0, Math.PI * 2); g.fill();
    }
    if (sub) { g.font = `600 ${h * 0.14}px ${FONT}`; g.fillStyle = '#f2f5f0'; g.fillText(sub, 0, h * 0.34); }
    // Speckle overspray dots
    for (let k = 0; k < 300; k++) {
      g.globalAlpha = r() * 0.5;
      g.fillRect((r() - 0.5) * m * 1.1, (r() - 0.5) * h * 0.7, 2, 2);
    }
    g.restore();
  });
}

function decalTexture(kind) {
  const s = 128;
  const c = canvas(s);
  const g = c.getContext('2d');
  const r = mulberry32(kind === 'hole' ? 11 : 23);
  if (kind === 'hole') {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(0,0,0,1)');
    gr.addColorStop(0.16, 'rgba(5,5,5,1)');
    gr.addColorStop(0.24, 'rgba(70,72,70,0.9)');
    gr.addColorStop(0.42, 'rgba(20,20,20,0.55)');
    gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    g.strokeStyle = 'rgba(15,15,15,0.6)'; g.lineWidth = 1.5;
    for (let k = 0; k < 7; k++) {
      const a = r() * Math.PI * 2, l = s * (0.2 + r() * 0.2);
      g.beginPath(); g.moveTo(s / 2 + Math.cos(a) * s * 0.12, s / 2 + Math.sin(a) * s * 0.12);
      g.lineTo(s / 2 + Math.cos(a + (r() - 0.5) * 0.4) * l, s / 2 + Math.sin(a + (r() - 0.5) * 0.4) * l); g.stroke();
    }
  } else {
    for (let k = 0; k < 40; k++) {
      const a = r() * Math.PI * 2, d = r() * s * 0.3;
      const gr = g.createRadialGradient(s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, 0, s / 2 + Math.cos(a) * d, s / 2 + Math.sin(a) * d, s * (0.1 + r() * 0.2));
      gr.addColorStop(0, 'rgba(0,0,0,0.35)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
    }
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function spriteTexture(kind) {
  const s = 64;
  const c = canvas(s);
  const g = c.getContext('2d');
  if (kind === 'dot') {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
  } else if (kind === 'smoke') {
    const r = mulberry32(5);
    for (let k = 0; k < 22; k++) {
      const x = s / 2 + (r() - 0.5) * s * 0.4, y = s / 2 + (r() - 0.5) * s * 0.4, rad = s * (0.15 + r() * 0.25);
      const gr = g.createRadialGradient(x, y, 0, x, y, rad);
      gr.addColorStop(0, 'rgba(255,255,255,0.22)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = gr; g.fillRect(0, 0, s, s);
    }
  } else if (kind === 'flare') {
    const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.15, 'rgba(255,255,230,0.9)'); gr.addColorStop(0.5, 'rgba(255,255,200,0.15)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, s, s);
    g.globalCompositeOperation = 'lighter';
    g.strokeStyle = 'rgba(255,255,255,0.7)'; g.lineWidth = 2;
    for (let k = 0; k < 6; k++) {
      const a = (k / 6) * Math.PI * 2 + 0.3;
      g.beginPath(); g.moveTo(s / 2, s / 2); g.lineTo(s / 2 + Math.cos(a) * s * 0.5, s / 2 + Math.sin(a) * s * 0.5); g.stroke();
    }
  } else if (kind === 'ring') {
    g.strokeStyle = 'rgba(255,255,255,1)'; g.lineWidth = 5;
    g.shadowColor = '#fff'; g.shadowBlur = 8;
    g.beginPath(); g.arc(s / 2, s / 2, s * 0.4, 0, Math.PI * 2); g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------- library ----------
const SIZES = { low: 256, medium: 512, high: 1024 };

function toTex(c, srgb, aniso) {
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.needsUpdate = true;
  return t;
}

/**
 * Build all textures and materials. onProgress(0..1). Yields between textures so the
 * loading bar can animate.
 */
export async function buildMaterialLibrary(quality = 'high', renderer = null, onProgress = () => {}) {
  const size = SIZES[quality] || 512;
  const small = Math.max(256, size / 2);
  const aniso = renderer ? Math.min(quality === 'high' ? 8 : 4, renderer.capabilities.getMaxAnisotropy()) : 4;
  const jobs = [
    ['concrete', () => concreteSet(size, 101)],
    ['plate', () => diamondPlateSet(small, 202)],
    ['grate', () => grateSet(small, 303)],
    ['wall', () => wallPanelSet(size, 404)],
    ['hazard', () => hazardSet(small, 505)],
    ['corrugated', () => corrugatedSet(small, 606)],
    ['brushed', () => brushedSet(small, 707)],
    ['gravel', () => gravelSet(small, 808)],
    ['rubber', () => noiseSet(256, 909, [18, 19, 19], 0.85, 0, 14)],
    ['paint', () => noiseSet(256, 919, [190, 192, 188], 0.5, 0.2, 26)],
  ];
  const sets = {};
  let done = 0;
  for (const [name, fn] of jobs) {
    const s = fn();
    sets[name] = {
      map: toTex(s.albedo, true, aniso),
      normalMap: toTex(s.normal, false, aniso),
      orm: toTex(s.orm, false, aniso),
      alphaMap: s.alpha ? toTex(s.alpha, false, aniso) : null,
    };
    done++;
    onProgress(done / (jobs.length + 2));
    await new Promise((r) => setTimeout(r, 0));
  }
  const signs = makeSigns();
  const graffiti = {
    noExcuses: graffitiTexture('NO EXCUSES', '#7dff1a', 1024, 384, 3),
    oneVone: graffitiTexture('1V1 ME', '#ff8a1f', 768, 384, 5),
    rush: graffitiTexture('RUSH', '#f2f5f0', 768, 384, 7, 'BOOST OR BUST'),
    blackout: graffitiTexture('BLACKOUT', '#7dff1a', 1024, 384, 9),
    xmark: graffitiTexture('X', '#7dff1a', 384, 384, 11),
    devs: graffitiTexture('DEVS WUZ HERE', '#a6ff4d', 1024, 384, 13, 'thanks for finding this · gg'),
    gg: graffitiTexture('GG EZ?', '#ff8a1f', 768, 384, 15, 'rematch.'),
    secret: graffitiTexture('SHHH', '#f2f5f0', 768, 384, 17, 'the 7th can is a lie'),
  };
  onProgress((jobs.length + 1) / (jobs.length + 2));
  await new Promise((r) => setTimeout(r, 0));
  const decals = { hole: decalTexture('hole'), scorch: decalTexture('scorch') };
  const sprites = { dot: spriteTexture('dot'), smoke: spriteTexture('smoke'), flare: spriteTexture('flare'), ring: spriteTexture('ring') };
  onProgress(1);
  return createMaterials(sets, { signs, graffiti, decals, sprites });
}

function pbr(set, opts = {}) {
  const m = new THREE.MeshStandardMaterial({
    map: set.map,
    normalMap: set.normalMap,
    roughnessMap: set.orm,
    metalnessMap: set.orm,
    aoMap: set.orm,
    aoMapIntensity: opts.ao ?? 0.8,
    roughness: opts.roughness ?? 1,
    metalness: opts.metalness ?? 1,
    color: new THREE.Color(opts.color ?? 0xffffff),
    envMapIntensity: opts.env ?? 1,
  });
  if (opts.normalScale) m.normalScale.set(opts.normalScale, opts.normalScale);
  if (set.alphaMap && opts.alpha) {
    m.alphaMap = set.alphaMap;
    m.alphaTest = 0.5;
    m.side = THREE.DoubleSide;
  }
  return m;
}

export function neon(color, intensity = 3) {
  const c = new THREE.Color(color).multiplyScalar(intensity);
  return new THREE.MeshBasicMaterial({ color: c, fog: true });
}

function createMaterials(sets, extra) {
  const M = {
    concrete: pbr(sets.concrete, { normalScale: 0.9 }),
    concreteDark: pbr(sets.concrete, { color: 0xb4b8b4, normalScale: 0.9 }),
    plate: pbr(sets.plate, { normalScale: 1.0, env: 1.2 }),
    grate: pbr(sets.grate, { alpha: true, env: 1.1 }),
    wall: pbr(sets.wall, { normalScale: 1.0 }),
    wallGreen: pbr(sets.wall, { color: 0xb8f0a0 }),
    hazard: pbr(sets.hazard),
    container: pbr(sets.corrugated, { color: 0x5c6468 }),
    containerGreen: pbr(sets.corrugated, { color: 0x58902e }),
    containerOrange: pbr(sets.corrugated, { color: 0xc8641e }),
    containerWhite: pbr(sets.corrugated, { color: 0xc4c8c4 }),
    trim: pbr(sets.brushed, { env: 1.3 }),
    darkMetal: pbr(sets.brushed, { color: 0x7a8288, env: 1.0 }),
    gravel: pbr(sets.gravel, { normalScale: 1.2 }),
    rubber: pbr(sets.rubber),
    pipe: pbr(sets.paint, { color: 0x7c8682 }),
    pipeGreen: pbr(sets.paint, { color: 0x4a9a22 }),
    pipeWhite: pbr(sets.paint, { color: 0xb8bcb6 }),
    machine: pbr(sets.wall, { color: 0x9aa0a0 }),
    glass: new THREE.MeshPhysicalMaterial({
      color: 0x9dffb0, metalness: 0, roughness: 0.05, transmission: 0, transparent: true, opacity: 0.18,
      envMapIntensity: 1.6, side: THREE.DoubleSide, depthWrite: false,
    }),
    reactorGlass: new THREE.MeshPhysicalMaterial({
      color: 0xb0ffc0, metalness: 0.1, roughness: 0.04, transparent: true, opacity: 0.22,
      envMapIntensity: 2.0, side: THREE.DoubleSide, depthWrite: false, clearcoat: 1, clearcoatRoughness: 0.05,
    }),
    neonGreen: neon(PALETTE.acid, 4),
    neonGreenSoft: neon(PALETTE.acid, 1.6),
    neonWhite: neon(0xffffff, 3.2),
    neonWhiteSoft: neon(0xe8f0ff, 1.4),
    neonRed: neon(PALETTE.warnRed, 4),
    neonOrange: neon(PALETTE.warnOrange, 3.5),
    black: new THREE.MeshStandardMaterial({ color: 0x050505, roughness: 0.6, metalness: 0.2 }),
  };
  // World-space UV materials repeat every 4 m, so scale is baked into geometry UVs.
  return { M, sets, ...extra };
}

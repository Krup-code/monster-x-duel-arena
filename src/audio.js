// MONSTER-X: DUEL ARENA - procedural audio engine.
//
// There are no audio assets. Everything is synthesized with the Web Audio API:
//  * one-shot SFX are rendered into AudioBuffers during init() via OfflineAudioContext,
//  * music is generated live by a lookahead step sequencer that drives persistent synth
//    voices (reese bass, sub, pads, alarm) plus pre-rendered drum hits,
//  * announcer lines combine a synthesized stinger with window.speechSynthesis.
//
// Live bus layout:
//   sfxIn -> sfxFilter -> sfxDuck -> sfxVol --+------------------------------> master
//                                             +-> sfxSend --+
//   annIn -> annVol --------------------------+-------------|----------------> master
//                                             +-> annSend --+-> reverbHP -> convolver -> reverbTone -> master
//   uiIn  -> uiVol ------------------------------------------------------------> master
//   musicIn -> musicPulse -> musicFilter -> musicDuck -> musicVol -------------> master
//   master -> limiter (DynamicsCompressor) -> out -> destination
//
// Positions are duck-typed {x, y, z} (THREE.Vector3 works), so 'three' is not imported.

// ---------------------------------------------------------------------------------------
// Small math / util helpers
// ---------------------------------------------------------------------------------------

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const semis = (n) => Math.pow(2, n / 12);
const yieldToLoop = () => new Promise((r) => setTimeout(r, 0));
const nowMs = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());
const volCurve = (v) => Math.pow(clamp(+v || 0, 0, 1), 1.5); // slider -> perceptual gain
const finite3 = (v) => v && Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded RNG with a few convenience helpers (deterministic per sound variant). */
function makeRng(seed) {
  const r = mulberry32(seed);
  r.range = (a, b) => a + (b - a) * r();
  r.vary = (x, frac) => x * (1 + (r() * 2 - 1) * frac);
  r.pick = (arr) => arr[Math.floor(r() * arr.length) % arr.length];
  return r;
}

function hashStr(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/** Cancel future automation on a param while holding its current value. */
function holdParam(param, t) {
  if (param.cancelAndHoldAtTime) {
    try {
      param.cancelAndHoldAtTime(t);
      return;
    } catch (_) { /* fall through */ }
  }
  const v = param.value;
  param.cancelScheduledValues(t);
  param.setValueAtTime(v, t);
}

/** Smoothly move a param toward a value starting now (cancels pending automation). */
function glideParam(param, value, t, tc) {
  holdParam(param, t);
  param.setTargetAtTime(value, t, Math.max(0.001, tc));
}

const curveCache = new Map();
/** tanh soft-clip transfer curve; k = steepness. */
function driveCurve(k) {
  const key = Math.round(k * 100);
  if (curveCache.has(key)) return curveCache.get(key);
  const n = 2048;
  const c = new Float32Array(n);
  const norm = Math.tanh(k);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    c[i] = Math.tanh(k * x) / norm;
  }
  curveCache.set(key, c);
  return c;
}

// ---------------------------------------------------------------------------------------
// Sample-buffer helpers (plain Float32Array DSP)
// ---------------------------------------------------------------------------------------

/** Crossfade the tail (x samples) into the head so the result loops seamlessly. */
function loopify(data, x, tonal) {
  const L = data.length - x;
  if (x <= 0 || L <= x) return data;
  const out = new Float32Array(L);
  out.set(data.subarray(0, L));
  for (let i = 0; i < x; i++) {
    const w = i / x;
    // equal-power for uncorrelated noise, linear for periodic/tonal content
    const a = tonal ? w : Math.sqrt(w);
    const b = tonal ? 1 - w : Math.sqrt(1 - w);
    out[i] = data[i] * a + data[L + i] * b;
  }
  return out;
}

function normalize(data, level) {
  let peak = 0;
  for (let i = 0; i < data.length; i++) {
    const v = Math.abs(data[i]);
    if (v > peak) peak = v;
  }
  if (peak < 1e-6 || !Number.isFinite(peak)) return;
  const s = level / peak;
  for (let i = 0; i < data.length; i++) data[i] *= s;
}

function fadeEdges(data, sr, inSec, outSec) {
  const ni = Math.min(data.length, Math.floor(inSec * sr));
  const no = Math.min(data.length, Math.floor(outSec * sr));
  for (let i = 0; i < ni; i++) data[i] *= i / ni;
  for (let i = 0; i < no; i++) data[data.length - 1 - i] *= i / no;
}

function toBuffer(ctx, channels) {
  const buf = ctx.createBuffer(channels.length, channels[0].length, ctx.sampleRate);
  channels.forEach((d, ch) => {
    if (buf.copyToChannel) buf.copyToChannel(d, ch);
    else buf.getChannelData(ch).set(d);
  });
  return buf;
}

/** Shared loopable white / pink / brown noise buffers (usable from any context). */
function buildNoise(ctx, seconds = 3) {
  const sr = ctx.sampleRate;
  const x = Math.floor(sr * 0.05);
  const n = Math.floor(sr * seconds) + x;
  const rnd = mulberry32(0xbeef);
  const white = new Float32Array(n);
  const pink = new Float32Array(n);
  const brown = new Float32Array(n);
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0, br = 0;
  for (let i = 0; i < n; i++) {
    const w = rnd() * 2 - 1;
    white[i] = w;
    // Paul Kellet's refined pink filter
    b0 = 0.99886 * b0 + w * 0.0555179;
    b1 = 0.99332 * b1 + w * 0.0750759;
    b2 = 0.969 * b2 + w * 0.153852;
    b3 = 0.8665 * b3 + w * 0.3104856;
    b4 = 0.55 * b4 + w * 0.5329522;
    b5 = -0.7616 * b5 - w * 0.016898;
    pink[i] = b0 + b1 + b2 + b3 + b4 + b5 + b6 + w * 0.5362;
    b6 = w * 0.115926;
    br = (br + 0.02 * w) / 1.02;
    brown[i] = br;
  }
  const mk = (d) => {
    const l = loopify(d, x, false);
    normalize(l, 0.95);
    return toBuffer(ctx, [l]);
  };
  return { white: mk(white), pink: mk(pink), brown: mk(brown) };
}

/** Industrial-hall impulse response: early slaps, metallic flutter, darkening diffuse tail. */
function buildImpulse(ctx, seconds = 1.9) {
  const sr = ctx.sampleRate;
  const len = Math.floor(sr * seconds);
  const pre = Math.floor(0.011 * sr);
  const rnd = mulberry32(1337);
  const chans = [new Float32Array(len), new Float32Array(len)];
  for (let ch = 0; ch < 2; ch++) {
    const d = chans[ch];
    let lp = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      const env = Math.exp(-t * 3.3) * Math.min(1, t / 0.025) * (1 - t / (seconds + 0.01));
      const coeff = 0.72 * Math.exp(-t * 1.7) + 0.05; // high frequencies die first
      lp += coeff * (rnd() * 2 - 1 - lp);
      d[i] = lp * env;
    }
    // early reflections off concrete / steel walls
    const taps = [[0.009, 0.7], [0.017, 0.5], [0.026, 0.55], [0.038, 0.4], [0.052, 0.33], [0.068, 0.27], [0.085, 0.2]];
    for (const [tt, g] of taps) {
      const idx = Math.floor((tt + (ch ? 0.0021 : 0) + rnd() * 0.0015) * sr);
      if (idx + 1 < len) {
        const s = rnd() < 0.5 ? -1 : 1;
        d[idx] += g * s;
        d[idx + 1] += g * 0.45 * s;
      }
    }
    // parallel-wall flutter gives the metallic "hangar" ring
    for (let k = 1; k < 16; k++) {
      const idx = Math.floor((0.029 * k + (ch ? 0.0013 : 0)) * sr);
      if (idx < len) d[idx] += 0.24 * Math.pow(0.82, k) * (k % 2 ? 1 : -1);
    }
  }
  return toBuffer(ctx, chans);
}

function renderOffline(octx) {
  return new Promise((resolve, reject) => {
    octx.oncomplete = (e) => resolve(e.renderedBuffer);
    try {
      const p = octx.startRendering();
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

// ---------------------------------------------------------------------------------------
// Kit: tiny synthesis toolkit bound to one OfflineAudioContext
// ---------------------------------------------------------------------------------------

class Kit {
  constructor(ctx, noise, rng, len) {
    this.ctx = ctx;
    this.noiseBufs = noise;
    this.R = rng;
    this.len = len;
    this.out = ctx.createGain();
  }

  connect(...nodes) {
    for (let i = 0; i < nodes.length - 1; i++) nodes[i].connect(nodes[i + 1]);
    return nodes[nodes.length - 1];
  }

  gain(v = 1) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    return g;
  }

  osc(type, f0, t = 0, dur = 0.3, f1 = null, glide = null, detune = 0) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f0;
    o.frequency.setValueAtTime(f0, t);
    if (f1 != null && f1 !== f0) {
      o.frequency.exponentialRampToValueAtTime(Math.max(1, f1), t + Math.max(0.002, glide ?? dur));
    }
    if (detune) o.detune.value = detune;
    o.start(t);
    o.stop(t + dur + 0.03);
    return o;
  }

  noiseSrc(color = 'white', t = 0, dur = 0.3, rate = 1) {
    const s = this.ctx.createBufferSource();
    s.buffer = this.noiseBufs[color] || this.noiseBufs.white;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(t, this.R() * s.buffer.duration * 0.9);
    s.stop(t + dur + 0.03);
    return s;
  }

  /** Biquad; for lowpass/highpass Q is in dB (Web Audio semantics), bandpass Q is linear. */
  filter(type, f, q, f1 = null, t = 0, glide = 0.1) {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.frequency.setValueAtTime(f, t);
    if (f1 != null && f1 !== f) b.frequency.exponentialRampToValueAtTime(Math.max(10, f1), t + Math.max(0.002, glide));
    b.Q.value = q ?? (type === 'lowpass' || type === 'highpass' ? 0 : 1);
    return b;
  }

  /** Filter from a spec: number = static cutoff, [f0, f1, glideSec] = sweep. */
  fspec(type, spec, q, t) {
    if (spec == null) return null;
    if (Array.isArray(spec)) return this.filter(type, spec[0], q, spec[1], t, spec[2]);
    return this.filter(type, spec, q);
  }

  /** Percussive AR envelope: linear attack, optional hold, exponential decay. */
  env(t, a, d, peak = 1, hold = 0) {
    const g = this.ctx.createGain();
    const p = g.gain;
    const pk = Math.max(1e-4, peak);
    const at = Math.max(0.0005, a);
    const dt = Math.max(0.002, d);
    p.value = 0;
    p.setValueAtTime(0, t);
    p.linearRampToValueAtTime(pk, t + at);
    if (hold > 0) p.setValueAtTime(pk, t + at + hold);
    p.exponentialRampToValueAtTime(1e-4, t + at + hold + dt);
    p.setValueAtTime(0, t + at + hold + dt + 0.002);
    return g;
  }

  filters(chain, t, { lp, lpq = 0, hp, hpq = 0, bp, bpq = 1 }) {
    const h = this.fspec('highpass', hp, hpq, t);
    const b = this.fspec('bandpass', bp, bpq, t);
    const l = this.fspec('lowpass', lp, lpq, t);
    if (h) chain.push(h);
    if (b) chain.push(b);
    if (l) chain.push(l);
  }

  /** Enveloped oscillator layer. */
  tone({ type = 'sine', f = 440, f1 = null, glide = null, t = 0, a = 0.002, d = 0.2, hold = 0, g = 1,
    detune = 0, lp, lpq, hp, bp, bpq, dest = this.out } = {}) {
    const dur = a + hold + d;
    const o = this.osc(type, f, t, dur, f1, glide ?? dur, detune);
    const chain = [o];
    this.filters(chain, t, { lp, lpq, hp, bp, bpq });
    chain.push(this.env(t, a, d, g, hold), dest);
    this.connect(...chain);
    return o;
  }

  /** Enveloped, filtered noise layer. */
  noise({ color = 'white', t = 0, a = 0.001, d = 0.1, hold = 0, g = 1, rate = 1, lp, lpq, hp, hpq,
    bp, q = 1, dest = this.out } = {}) {
    const chain = [this.noiseSrc(color, t, a + hold + d, rate)];
    this.filters(chain, t, { lp, lpq, hp, hpq, bp, bpq: q });
    chain.push(this.env(t, a, d, g, hold), dest);
    this.connect(...chain);
  }

  /** Very short high-passed transient. */
  click(t = 0, g = 1, hp = 2500, d = 0.005) {
    this.noise({ t, a: 0.0005, d, g, hp });
  }

  /** Pitch-dropping sine body ("thump"). */
  thump(t, f0, f1, d, g = 1, glide = 0.05) {
    return this.tone({ f: f0, f1, glide, t, a: 0.001, d, g });
  }

  /** Inharmonic metallic partials; higher partials decay faster. */
  ring(t, freqs, d, g = 0.2, type = 'sine', dest = this.out) {
    freqs.forEach((f, i) => this.tone({ type, f, t, a: 0.0008, d: d / (1 + i * 0.35), g: g / (1 + i * 0.45), dest }));
  }

  /** Random micro-bursts of noise through one shared filter (debris, crackle, gravel). */
  grains({ t0 = 0, t1 = 0.2, n = 10, d0 = 0.002, d1 = 0.008, g = 0.5, decay = 1.5, type = 'highpass',
    f = 3000, q = 0.7, color = 'white', amp = 'down', dest = this.out } = {}) {
    const flt = this.filter(type, f, q);
    flt.connect(dest);
    const R = this.R;
    const span = Math.max(1e-3, t1 - t0);
    for (let i = 0; i < n; i++) {
      const u = Math.pow(R(), decay);
      const t = t0 + span * u;
      const d = lerp(d0, d1, R());
      const shape = amp === 'down' ? Math.pow(1 - u, 1.2) : amp === 'up' ? u : 1;
      const pk = Math.max(0.002, g * lerp(0.35, 1, R()) * shape);
      this.connect(this.noiseSrc(color, t, d + 0.002), this.env(t, 0.0005, d, pk), flt);
    }
  }

  /** Random short sine/triangle pings (glass shards, bubbles, shimmer). */
  pings({ t0 = 0, t1 = 0.5, n = 10, f0 = 2000, f1 = 6000, d0 = 0.02, d1 = 0.1, g = 0.2, decay = 1.5,
    type = 'sine', bend = 0, amp = 'down', dest = this.out } = {}) {
    const R = this.R;
    const span = Math.max(1e-3, t1 - t0);
    for (let i = 0; i < n; i++) {
      const u = Math.pow(R(), decay);
      const t = t0 + span * u;
      const f = f0 * Math.pow(f1 / f0, R());
      const d = lerp(d0, d1, R());
      const shape = amp === 'down' ? Math.pow(1 - u, 1.1) : amp === 'up' ? 0.3 + 0.7 * u : 1;
      this.tone({ type, f, f1: bend ? f * (1 + bend) : null, glide: d, t, a: 0.0008, d, g: g * lerp(0.4, 1, R()) * shape, dest });
    }
  }

  /** Connect an LFO (osc * depth) into an AudioParam. */
  lfo(param, rate, depth, t = 0, dur = 1, type = 'sine') {
    const o = this.osc(type, rate, t, dur);
    const g = this.gain(depth);
    o.connect(g);
    g.connect(param);
    return o;
  }

  /** Tremolo gain node (range 1-2*depth .. 1) routed to dest; connect sources into it. */
  trem(rate, depth, t = 0, dur = 1, type = 'sine', dest = this.out) {
    const g = this.gain(1 - depth);
    this.lfo(g.gain, rate, depth, t, dur, type);
    g.connect(dest);
    return g;
  }
}

// ---------------------------------------------------------------------------------------
// Shared sound-design building blocks
// ---------------------------------------------------------------------------------------

// Band-passed noise carries far less energy per unit gain than a sine thump; compensate so the
// crack / mid layers sit level with the body (keeps guns crisp on small speakers too).
const NOISE_COMP = 2.2;

/** Generic firearm: transient click + band-passed crack + mid punch + body thump + baked tail. */
function gunshot(K, p) {
  K.click(0, p.click ?? 1, p.clickHp ?? 2500, p.clickD ?? 0.004);
  K.noise({ bp: p.crackF, q: p.crackQ ?? 0.9, d: p.crackD, g: (p.crackG ?? 1) * NOISE_COMP });
  if (p.midF) K.noise({ color: 'pink', bp: p.midF, q: p.midQ ?? 1, d: p.midD, g: (p.midG ?? 0.6) * NOISE_COMP });
  K.thump(0, p.thumpF0, p.thumpF1, p.thumpD, p.thumpG ?? 1, p.thumpGlide ?? 0.05);
  if (p.tailD) K.noise({ color: 'pink', lp: [p.tailLp, p.tailLp1 ?? 400, p.tailD * 0.8], a: 0.004, d: p.tailD, g: p.tailG ?? 0.25 });
}

/** Big layered explosion: crack, boom, sub drop, body rumble, mid blast, debris. */
function boom(K, s = 1) {
  K.click(0, 1.2, 1200, 0.008);
  K.noise({ lp: [9000, 1200, 0.08], d: 0.1, g: 1.2 });
  K.thump(0, 78 * s, 24, 0.9, 1.2, 0.45);
  K.tone({ f: 48 * s, f1: 18, glide: 1.3, a: 0.008, d: 1.4, g: 0.6 });
  K.noise({ color: 'brown', lp: [1100, 140, 1.6], a: 0.004, d: 1.9, g: 1.2 });
  K.noise({ color: 'pink', bp: 520, q: 0.7, d: 0.5, g: 1.5 * NOISE_COMP });
  K.noise({ color: 'pink', bp: 1400, q: 0.6, d: 0.3, g: NOISE_COMP }); // mid crunch (what laptop speakers hear)
  K.grains({ t0: 0.08, t1: 1.7, n: 34, d0: 0.002, d1: 0.012, g: 0.5, decay: 1.7, type: 'bandpass', f: 3200, q: 0.6 });
  K.grains({ t0: 0.15, t1: 1.2, n: 10, d0: 0.012, d1: 0.04, g: 0.3, decay: 1.4, type: 'lowpass', f: 900, color: 'pink' });
}

/** Detuned-saw chord through a sweeping lowpass. */
function chordStab(K, t, freqs, { a = 0.004, d = 0.5, hold = 0, g = 0.2, lp = [4000, 800, 0.4], lpq = 3,
  type = 'sawtooth', drop = 0, spread = 9 } = {}) {
  const flt = K.fspec('lowpass', lp, lpq, t);
  K.connect(flt, K.env(t, a, d, g, hold), K.out);
  const dur = a + hold + d;
  for (const f of freqs) {
    for (const det of [-spread, spread]) K.osc(type, f, t, dur, drop ? f * semis(drop) : null, dur, det).connect(flt);
  }
}

/** Formant-filtered saw: a crude vocal grunt. */
function grunt(K, t, pitch, d, g = 0.6, bend = 0.72) {
  const o = K.osc('sawtooth', pitch, t, d + 0.05, pitch * bend, d);
  K.lfo(o.frequency, 6.5, pitch * 0.025, t, d);
  const e = K.env(t, 0.015, d, g);
  o.connect(e);
  for (const [f, q, gg] of [[650, 4, 1], [1080, 5, 0.6], [2450, 6, 0.25]]) {
    K.connect(e, K.filter('bandpass', f, q), K.gain(gg * 3), K.out);
  }
  K.noise({ color: 'pink', t, bp: 900, q: 1, a: 0.01, d: d * 0.7, g: g * 0.15 });
}

/** 808-style metallic square cluster (hats / cymbals). */
function metalCluster(K, t, d, g, mult = 1, hp = 7000) {
  const h = K.filter('highpass', hp, 0);
  const b = K.filter('bandpass', 10000, 0.8);
  K.connect(h, b, K.env(t, 0.0005, d, g), K.out);
  for (const f of [205.3, 304.4, 369.6, 522.7, 540, 800]) K.osc('square', f * mult, t, d + 0.01).connect(h);
}

// ---------------------------------------------------------------------------------------
// Sound definitions. dur = seconds rendered, level = output peak, drive = saturation,
// loop = crossfade seconds for seamless loops, variants = distinct renders.
// ---------------------------------------------------------------------------------------

const SOUND_DEFS = {
  // ---- Footsteps & movement ----
  step_concrete: { dur: 0.3, variants: 4, level: 0.55, render: (K, R) => {
    K.thump(0, R.vary(120, 0.1), 48, 0.09, 1, 0.035);
    K.noise({ color: 'brown', lp: R.vary(650, 0.15), d: 0.07, g: 0.9 });
    K.noise({ bp: R.vary(2200, 0.2), q: 1.2, d: 0.025, g: 0.25 });
    K.grains({ t0: 0.004, t1: 0.06, n: 4, g: 0.12, f: 3500, d1: 0.006 });
  } },
  step_metal: { dur: 0.4, variants: 4, level: 0.55, render: (K, R) => {
    K.thump(0, R.vary(150, 0.1), 70, 0.07, 0.9, 0.03);
    K.click(0, 0.5, 2500, 0.004);
    const b = R.range(480, 620);
    K.ring(0.001, [b, b * 2.32, b * 3.71, b * 5.13].map((f) => R.vary(f, 0.03)), 0.17, 0.24, 'triangle');
    K.noise({ bp: R.vary(1800, 0.2), q: 2, d: 0.04, g: 0.35 });
  } },
  step_grate: { dur: 0.42, variants: 4, level: 0.55, render: (K, R) => {
    K.thump(0, R.vary(110, 0.1), 55, 0.06, 0.6, 0.03);
    const n = 3 + Math.floor(R() * 3);
    let t = 0;
    for (let i = 0; i < n; i++) {
      const g = 0.55 * (1 - i / (n + 1));
      K.noise({ t, bp: R.range(1600, 3600), q: 3, d: 0.012, g });
      K.ring(t, [R.range(700, 1100), R.range(1900, 2600)], 0.05, 0.02 + g * 0.16, 'triangle');
      t += R.range(0.012, 0.028);
    }
    K.noise({ color: 'pink', bp: R.vary(420, 0.15), q: 6, d: 0.12, g: 1.1 }); // hollow cavity
  } },
  step_gravel: { dur: 0.34, variants: 4, level: 0.55, render: (K, R) => {
    K.thump(0, R.vary(95, 0.1), 45, 0.06, 0.55, 0.03);
    K.noise({ color: 'brown', lp: 500, d: 0.05, g: 0.4 });
    K.grains({ t0: 0, t1: R.range(0.08, 0.12), n: 18 + Math.floor(R() * 8), d0: 0.002, d1: 0.007, g: 0.7, decay: 1.6, type: 'bandpass', f: R.range(2500, 3800), q: 0.8 });
    K.grains({ t0: 0.005, t1: 0.06, n: 8, d0: 0.003, d1: 0.01, g: 0.3, type: 'bandpass', f: 1200, q: 1.2 });
  } },
  jump: { dur: 0.35, level: 0.45, render: (K) => {
    K.thump(0, 110, 60, 0.06, 0.6, 0.04);
    K.noise({ color: 'pink', bp: [400, 1600, 0.16], q: 1.2, a: 0.03, d: 0.14, g: 0.7 });
    K.noise({ bp: 3000, q: 1, d: 0.03, g: 0.15 });
  } },
  land: { dur: 0.4, variants: 2, level: 0.6, render: (K, R) => {
    K.thump(0, R.vary(120, 0.08), 42, 0.13, 1, 0.05);
    K.noise({ color: 'brown', lp: 900, d: 0.09, g: 0.8 });
    K.noise({ color: 'pink', bp: 1500, q: 1, d: 0.05, g: 0.25 });
    K.grains({ t0: 0.01, t1: 0.08, n: 5, g: 0.18, type: 'bandpass', f: 3000, q: 2 });
  } },
  land_hard: { dur: 0.7, level: 0.85, drive: 1.5, render: (K) => {
    K.thump(0, 95, 32, 0.28, 1.2, 0.08);
    K.click(0, 0.6, 1800, 0.006);
    K.noise({ color: 'brown', lp: [1200, 200, 0.2], d: 0.2, g: 1 });
    K.ring(0.004, [340, 820, 1530, 2470], 0.22, 0.12, 'triangle');
    K.grains({ t0: 0.01, t1: 0.2, n: 10, g: 0.25, type: 'bandpass', f: 2600, q: 1.5 });
  } },
  slide: { dur: 1.1, loop: 0.12, fadeEdges: true, level: 0.5, render: (K) => {
    const L = K.len;
    const bp = K.filter('bandpass', 1150, 1.3);
    K.lfo(bp.frequency, 7.3, 280, 0, L);
    K.lfo(bp.frequency, 2.3, 200, 0, L, 'triangle');
    K.connect(K.noiseSrc('pink', 0, L), bp, K.gain(1.1), K.out);
    const grit = K.trem(17, 0.45, 0, L, 'square');
    K.connect(K.noiseSrc('white', 0, L), K.filter('highpass', 3800), K.gain(0.25), grit);
    K.connect(K.noiseSrc('brown', 0, L), K.filter('lowpass', 240), K.gain(0.7), K.out);
    K.grains({ t0: 0, t1: L, n: 26, decay: 1, amp: 'flat', g: 0.25, type: 'bandpass', f: 2600, q: 1.2, d0: 0.003, d1: 0.01 });
  } },
  mantle: { dur: 0.5, level: 0.55, render: (K) => {
    K.ring(0, [620, 1490, 2380], 0.08, 0.15, 'triangle');
    K.click(0, 0.4, 2000, 0.004);
    K.thump(0, 140, 80, 0.05, 0.5, 0.03);
    K.noise({ color: 'pink', bp: [500, 1400, 0.25], q: 1, a: 0.06, d: 0.2, g: 0.6 });
    K.noise({ t: 0.04, bp: 2600, q: 1.5, a: 0.02, d: 0.12, g: 0.18 });
    K.thump(0.24, 120, 55, 0.07, 0.55, 0.04);
  } },
  jumppad: { dur: 0.9, level: 0.85, drive: 1.2, render: (K) => {
    K.tone({ f: 150, f1: 42, glide: 0.18, d: 0.3, g: 1.2 });
    K.noise({ color: 'brown', lp: [300, 2400, 0.3], a: 0.01, d: 0.3, g: 0.6 });
    K.tone({ type: 'sawtooth', f: 180, f1: 2600, glide: 0.38, t: 0.02, a: 0.03, hold: 0.05, d: 0.4, g: 0.35, lp: 5000 });
    K.tone({ type: 'square', f: 360, f1: 3900, glide: 0.4, t: 0.03, a: 0.04, d: 0.35, g: 0.12, lp: 6000 });
    K.noise({ bp: [400, 6000, 0.45], q: 2, t: 0.02, a: 0.2, d: 0.35, g: 0.45 });
    K.grains({ t0: 0.08, t1: 0.6, n: 16, g: 0.25, f: 5000, d1: 0.006 });
  } },
  wallkick: { dur: 0.45, level: 0.6, render: (K) => {
    K.thump(0, 160, 60, 0.08, 1, 0.04);
    K.click(0, 0.5, 2200, 0.005);
    K.ring(0.002, [470, 1130, 1920], 0.1, 0.12, 'triangle');
    K.noise({ color: 'pink', bp: [600, 2000, 0.15], q: 1, t: 0.02, a: 0.03, d: 0.15, g: 0.45 });
  } },

  // ---- Weapons ----
  pistol_fire: { dur: 0.7, variants: 2, level: 0.9, drive: 1.5, render: (K, R) => {
    gunshot(K, { click: 1, clickHp: 3000, crackF: R.vary(2300, 0.05), crackQ: 0.9, crackD: 0.07, crackG: 1.2,
      midF: 750, midD: 0.06, midG: 1.1, thumpF0: 180, thumpF1: 60, thumpD: 0.12, thumpG: 0.75,
      tailLp: 2400, tailLp1: 500, tailD: 0.6, tailG: 0.4 });
    K.noise({ t: 0.055, hp: 4000, d: 0.01, g: 0.18 }); // slide cycling
    K.ring(0.055, [3400, 5200], 0.03, 0.05);
  } },
  razor_fire: { dur: 0.75, variants: 3, level: 0.92, drive: 2, render: (K, R) => {
    gunshot(K, { click: 1.1, crackF: R.vary(1500, 0.05), crackQ: 0.75, crackD: 0.085, crackG: 1.3,
      midF: 450, midQ: 1.2, midD: 0.08, midG: 1.2, thumpF0: 140, thumpF1: 48, thumpD: 0.11, thumpG: 0.8,
      tailLp: 1800, tailLp1: 380, tailD: 0.65, tailG: 0.45 });
    K.tone({ type: 'triangle', f: 240, f1: 95, glide: 0.04, d: 0.05, g: 0.35, lp: 1200 });
    K.noise({ color: 'pink', bp: 950, q: 0.9, d: 0.06, g: 0.9 * NOISE_COMP }); // mid weight
    K.noise({ hp: 3500, d: 0.03, g: 0.9 }); // crisp top crack
    K.noise({ t: 0.035, bp: 3800, q: 3, d: 0.012, g: 0.12 }); // bolt carrier
  } },
  volt_fire: { dur: 0.45, variants: 3, level: 0.8, drive: 1.6, render: (K, R) => {
    gunshot(K, { click: 0.9, clickHp: 4500, crackF: R.vary(3300, 0.06), crackQ: 1.1, crackD: 0.045, crackG: 1.1,
      midF: 1300, midD: 0.04, midG: 0.4, thumpF0: 240, thumpF1: 95, thumpD: 0.05, thumpG: 0.55,
      tailLp: 4200, tailLp1: 900, tailD: 0.36, tailG: 0.25 });
    K.tone({ type: 'square', f: 2200, f1: 700, glide: 0.035, d: 0.035, g: 0.12, lp: 6000 }); // electric zip
    K.grains({ t0: 0.004, t1: 0.08, n: 6, g: 0.18, f: 6000, d1: 0.004 });
  } },
  crush_fire: { dur: 1.6, variants: 2, level: 1, drive: 2.4, render: (K, R) => {
    K.click(0, 1.3, 1500, 0.006);
    K.noise({ lp: [7000, 1500, 0.1], d: 0.12, g: 1.4 }); // blast
    K.noise({ hp: 2800, d: 0.035, g: 0.7 }); // crack
    K.noise({ color: 'pink', bp: 320, q: 0.8, d: 0.25, g: 1.4 * NOISE_COMP }); // body
    K.noise({ color: 'pink', bp: 950, q: 0.7, d: 0.14, g: 1.6 * NOISE_COMP }); // mid blast
    K.noise({ bp: 2200, q: 0.8, d: 0.06, g: 0.8 * NOISE_COMP });
    K.thump(0, 110, 36, 0.32, 0.85, 0.14);
    K.tone({ f: 62, f1: 26, glide: 0.4, a: 0.003, d: 0.45, g: 0.45 });
    K.ring(0.002, [310, 787, 1460, 2210].map((f) => R.vary(f, 0.03)), 0.32, 0.16, 'triangle');
    K.noise({ color: 'pink', lp: [1400, 260, 1], a: 0.006, d: 1.2, g: 0.45 });
    K.grains({ t0: 0.01, t1: 0.08, n: 8, g: 0.3, f: 2500, type: 'bandpass', q: 1 }); // pellet spray
  } },
  crush_pump: { dur: 0.6, level: 0.75, drive: 1.2, render: (K) => {
    K.click(0, 0.6, 2500, 0.005);
    K.ring(0, [880, 2270, 3650], 0.07, 0.14, 'triangle');
    K.thump(0, 230, 120, 0.04, 0.5, 0.02);
    K.noise({ t: 0.02, bp: [1800, 1200, 0.12], q: 2, a: 0.02, d: 0.1, g: 0.25 });
    K.click(0.21, 0.9, 2000, 0.006);
    K.ring(0.21, [760, 1980, 3300], 0.12, 0.18, 'triangle');
    K.thump(0.21, 200, 85, 0.07, 0.8, 0.03);
    K.noise({ t: 0.21, color: 'pink', bp: 900, q: 1.2, d: 0.06, g: 0.5 });
  } },
  venom_fire: { dur: 2, variants: 2, level: 1, drive: 2.2, render: (K) => {
    gunshot(K, { click: 1.4, clickHp: 2000, crackF: 1900, crackQ: 1.3, crackD: 0.11, crackG: 1.6,
      midF: 620, midD: 0.12, midG: 1, thumpF0: 160, thumpF1: 44, thumpD: 0.2, thumpG: 0.9, thumpGlide: 0.07,
      tailLp: 2800, tailLp1: 320, tailD: 1.7, tailG: 0.45 });
    K.noise({ hp: 2600, d: 0.03, g: 1.4 }); // supersonic snap
    for (const [t, g] of [[0.11, 0.32], [0.24, 0.2], [0.41, 0.12]]) {
      K.noise({ t, color: 'pink', bp: 1300, q: 0.9, d: 0.12, g }); // wall slapback
    }
    K.ring(0.005, [1250, 2130], 0.4, 0.04);
  } },
  chaos_fire: { dur: 1.6, level: 0.95, drive: 1.8, render: (K) => {
    K.thump(0, 85, 33, 0.28, 1.3, 0.12);
    K.click(0, 0.9, 1500, 0.006);
    K.noise({ color: 'pink', bp: 900, q: 1, d: 0.09, g: 0.8 });
    K.noise({ color: 'pink', bp: [380, 2800, 0.6], q: 0.9, t: 0.01, a: 0.05, d: 0.95, g: 0.85 }); // whoosh
    K.noise({ color: 'brown', lp: [600, 300, 1], t: 0.02, a: 0.04, d: 1.1, g: 0.6 }); // roar
    K.noise({ hp: 4000, t: 0.03, a: 0.05, d: 0.7, g: 0.2 });
    K.grains({ t0: 0.03, t1: 0.6, n: 22, g: 0.3, f: 3000, type: 'bandpass', q: 0.8 });
  } },
  rail_fire: { dur: 1.8, level: 1, drive: 2, render: (K) => {
    K.tone({ type: 'sawtooth', f: 4200, f1: 110, glide: 0.25, d: 0.3, g: 0.75, lp: 9000 }); // zap
    K.tone({ type: 'square', f: 2100, f1: 70, glide: 0.3, d: 0.3, g: 0.3, lp: 6000 });
    K.thump(0, 120, 30, 0.55, 1, 0.2); // boom
    K.noise({ color: 'pink', bp: 700, q: 0.8, d: 0.2, g: 0.8 });
    K.noise({ hp: 3000, d: 0.05, g: 1.1 });
    K.click(0, 1.2, 2500, 0.004);
    K.grains({ t0: 0.02, t1: 1.1, n: 50, g: 0.6, f: 5200, decay: 1.4, d0: 0.002, d1: 0.008 }); // sizzle
    K.noise({ hp: 6500, a: 0.01, d: 0.8, g: 0.35 });
    const o = K.tone({ f: 880, d: 0.7, g: 0.16 });
    K.lfo(o.frequency, 23, 30, 0, 0.8);
    K.tone({ f: 1320, d: 0.5, g: 0.1 });
    K.noise({ color: 'pink', lp: [3200, 450, 1.2], a: 0.005, d: 1.4, g: 0.32 });
  } },
  rail_charge: { dur: 1.8, level: 0.6, render: (K) => {
    const T = 1.42;
    const vca = K.gain(0.65);
    vca.connect(K.out);
    const trem = K.osc('sine', 6, 0, T, 34, T); // tremolo speeds up as charge builds
    const tg = K.gain(0.35);
    trem.connect(tg);
    tg.connect(vca.gain);
    K.tone({ type: 'sawtooth', f: 160, f1: 1450, glide: T, a: T * 0.92, d: 0.08, g: 0.45, bp: [320, 2900, T], bpq: 3, dest: vca });
    K.tone({ f: 330, f1: 2900, glide: T, a: T * 0.95, d: 0.06, g: 0.25, dest: vca });
    K.noise({ hp: [2000, 7000, T], a: T * 0.9, d: 0.08, g: 0.2, dest: vca });
    K.click(T, 0.5, 4000, 0.003); // "ready" ping
    K.tone({ f: 2637, t: T, d: 0.28, g: 0.5 });
    K.tone({ f: 3951, t: T + 0.05, d: 0.25, g: 0.4 });
    K.tone({ type: 'triangle', f: 5274, t: T + 0.05, d: 0.12, g: 0.15 });
  } },
  dry_fire: { dur: 0.15, level: 0.5, render: (K) => {
    K.click(0, 0.8, 3500, 0.004);
    K.ring(0.001, [3200, 5100], 0.03, 0.2);
    K.thump(0, 420, 200, 0.02, 0.4, 0.015);
  } },
  reload_mag_out: { dur: 0.35, level: 0.55, render: (K) => {
    K.click(0, 0.6, 3000, 0.004);
    K.ring(0, [1600, 3500], 0.04, 0.12, 'triangle');
    K.noise({ t: 0.02, bp: [2200, 1300, 0.12], q: 2.5, a: 0.03, d: 0.1, g: 0.3 });
    K.thump(0.13, 300, 160, 0.03, 0.25, 0.02);
  } },
  reload_mag_in: { dur: 0.32, level: 0.65, render: (K) => {
    K.noise({ bp: [1200, 2200, 0.05], q: 2, a: 0.02, d: 0.03, g: 0.2 });
    K.thump(0.05, 280, 140, 0.05, 0.8, 0.025);
    K.click(0.05, 0.9, 2500, 0.005);
    K.ring(0.05, [1400, 3100, 4700], 0.06, 0.16, 'triangle');
    K.click(0.11, 0.5, 4000, 0.003); // latch
    K.ring(0.11, [2800, 5300], 0.03, 0.08);
  } },
  reload_bolt: { dur: 0.45, level: 0.65, render: (K) => {
    K.click(0, 0.7, 2500, 0.004);
    K.ring(0, [1100, 2700], 0.05, 0.12, 'triangle');
    K.noise({ t: 0.01, bp: [1600, 2600, 0.1], q: 2, a: 0.02, d: 0.08, g: 0.25 });
    K.click(0.17, 1, 2000, 0.006); // slam forward
    K.thump(0.17, 240, 110, 0.06, 0.8, 0.03);
    K.ring(0.17, [900, 2150, 3600, 5200], 0.1, 0.18, 'triangle');
  } },
  shell_insert: { dur: 0.25, variants: 2, level: 0.5, render: (K) => {
    K.noise({ bp: [2600, 1800, 0.04], q: 2, a: 0.015, d: 0.03, g: 0.25 });
    K.click(0.045, 0.7, 3000, 0.004);
    K.ring(0.045, [1800, 4200], 0.05, 0.12, 'triangle');
    K.thump(0.045, 320, 180, 0.03, 0.4, 0.02);
  } },
  weapon_switch: { dur: 0.4, level: 0.5, render: (K) => {
    K.noise({ color: 'pink', bp: [600, 1900, 0.14], q: 1.2, a: 0.04, d: 0.1, g: 0.5 });
    K.click(0.12, 0.7, 2500, 0.005);
    K.ring(0.12, [1250, 2900], 0.05, 0.12, 'triangle');
    K.thump(0.12, 220, 110, 0.04, 0.5, 0.02);
  } },
  melee_swing: { dur: 0.35, variants: 2, level: 0.55, render: (K, R) => {
    K.noise({ color: 'pink', bp: [R.vary(300, 0.1), R.vary(2200, 0.1), 0.14], q: 1.6, a: 0.09, d: 0.16, g: 0.9 });
    K.noise({ hp: 3000, a: 0.08, d: 0.08, g: 0.12 });
  } },
  melee_hit: { dur: 0.4, level: 0.85, drive: 2, render: (K) => {
    K.thump(0, 150, 45, 0.13, 1.2, 0.05);
    K.noise({ color: 'brown', lp: 1300, d: 0.07, g: 0.9 });
    K.noise({ bp: 1900, q: 2, d: 0.03, g: 1 });
    K.noise({ color: 'pink', bp: 700, q: 1, d: 0.05, g: 0.8 });
    K.click(0, 0.7, 2000, 0.005);
    K.grains({ t0: 0, t1: 0.04, n: 6, g: 0.4, type: 'bandpass', f: 2500, q: 1.5 });
  } },

  // ---- Projectiles & impacts ----
  rocket_loop: { dur: 1, loop: 0.25, level: 0.6, render: (K) => {
    const L = K.len;
    K.connect(K.noiseSrc('brown', 0, L), K.filter('lowpass', 650, 3), K.gain(1), K.out);
    const hiss = K.filter('bandpass', 1600, 0.7);
    K.lfo(hiss.frequency, 5, 300, 0, L);
    K.connect(K.noiseSrc('pink', 0, L), hiss, K.gain(0.5), K.out);
    K.connect(K.noiseSrc('white', 0, L), K.filter('highpass', 5000), K.gain(0.12), K.out);
    const flutter = K.trem(31, 0.2, 0, L, 'square');
    K.connect(K.noiseSrc('pink', 0, L), K.filter('bandpass', 400, 1), K.gain(0.35), flutter);
  } },
  explosion: { dur: 2.4, variants: 2, level: 1, drive: 2.2, render: (K, R) => boom(K, R.vary(1, 0.06)) },
  barrel_explode: { dur: 2.6, level: 1, drive: 2.2, render: (K) => {
    boom(K, 1.1);
    K.ring(0.003, [175, 468, 893, 1431], 0.9, 0.16, 'triangle'); // drum body
    const fz = K.gain(1);
    K.lfo(fz.gain, 37, 0.6, 0, 1.6, 'square');
    fz.connect(K.out);
    K.noise({ hp: 3200, a: 0.05, d: 1.5, g: 0.3, dest: fz }); // chemical fizz
    K.grains({ t0: 0.1, t1: 1.5, n: 24, g: 0.2, f: 6000, decay: 1.2 });
  } },
  impact_concrete: { dur: 0.35, variants: 3, level: 0.6, render: (K, R) => {
    K.click(0, 0.9, 1800, 0.005);
    K.noise({ bp: R.vary(1700, 0.15), q: 1, d: 0.045, g: 0.9 });
    K.thump(0, 320, 120, 0.04, 0.5, 0.03);
    K.noise({ color: 'pink', lp: 3500, a: 0.004, d: 0.16, g: 0.22 });
    K.grains({ t0: 0.01, t1: 0.2, n: 8, g: 0.25, type: 'bandpass', f: 4000, q: 1 });
  } },
  impact_metal: { dur: 0.45, variants: 3, level: 0.6, render: (K, R) => {
    K.click(0, 0.9, 2500, 0.004);
    const b = R.range(1600, 2200);
    K.ring(0.001, [b, b * 1.61, b * 2.37, b * 3.19].map((f) => R.vary(f, 0.02)), 0.24, 0.22);
    K.noise({ bp: 3200, q: 3, d: 0.03, g: 0.6 });
    K.thump(0, 400, 180, 0.03, 0.35, 0.02);
  } },
  impact_glass: { dur: 0.35, variants: 3, level: 0.5, render: (K, R) => {
    K.click(0, 0.7, 4000, 0.003);
    K.ring(0, [3200, 4700, 6400, 8100].map((f) => R.vary(f, 0.05)), 0.16, 0.16);
    K.noise({ hp: 4500, d: 0.05, g: 0.4 });
    K.pings({ t0: 0.005, t1: 0.15, n: 5, f0: 4000, f1: 9000, d0: 0.02, d1: 0.06, g: 0.15 });
  } },
  glass_break: { dur: 1.2, variants: 2, level: 0.8, render: (K) => {
    K.noise({ hp: 1800, d: 0.12, g: 1 });
    K.click(0, 1, 2500, 0.004);
    K.thump(0, 200, 80, 0.06, 0.4, 0.04);
    K.pings({ t0: 0, t1: 0.9, n: 42, f0: 2500, f1: 9500, d0: 0.03, d1: 0.14, g: 0.35, decay: 1.8 });
    K.grains({ t0: 0.02, t1: 0.9, n: 30, g: 0.35, f: 5000, decay: 1.6 });
  } },
  bullet_whiz: { dur: 0.3, variants: 3, level: 0.6, render: (K, R) => {
    K.noise({ hp: 2500, d: 0.008, g: 1 });
    K.noise({ bp: [R.vary(5500, 0.1), 1400, 0.16], q: 3, a: 0.05, d: 0.12, g: 0.8 });
    K.noise({ color: 'pink', bp: [2500, 900, 0.18], q: 1.5, a: 0.04, d: 0.14, g: 0.4 });
  } },
  ricochet: { dur: 0.6, variants: 3, level: 0.55, render: (K, R) => {
    K.click(0, 0.8, 2500, 0.004);
    const f = R.range(3200, 4400);
    const o = K.tone({ f, f1: f * 0.5, glide: 0.4, a: 0.002, d: 0.45, g: 0.5 });
    K.lfo(o.frequency, R.range(18, 30), f * 0.012, 0, 0.5);
    K.noise({ bp: [f * 1.2, f * 0.6, 0.35], q: 8, a: 0.01, d: 0.35, g: 0.35 });
  } },
  spark: { dur: 0.45, variants: 3, level: 0.55, render: (K, R) => {
    K.grains({ t0: 0, t1: 0.32, n: 22, d0: 0.001, d1: 0.006, g: 0.8, decay: 1.4, f: R.range(4000, 6000) });
    const bz = K.gain(1);
    K.lfo(bz.gain, 50, 1, 0, 0.3, 'square');
    bz.connect(K.out);
    K.tone({ type: 'sawtooth', f: 120, d: 0.22, g: 0.25, bp: 2000, bpq: 2, dest: bz });
    K.click(0, 0.6, 3000, 0.003);
  } },

  // ---- Feedback ----
  hitmarker: { dur: 0.08, level: 0.45, render: (K) => {
    K.tone({ f: 2400, d: 0.035, g: 0.6 });
    K.tone({ type: 'triangle', f: 3600, d: 0.022, g: 0.3 });
    K.click(0, 0.5, 5000, 0.003);
  } },
  headshot_marker: { dur: 0.5, level: 0.5, render: (K) => {
    K.click(0, 0.5, 5000, 0.003);
    K.tone({ f: 3136, d: 0.38, g: 0.6 });
    K.tone({ f: 4699, d: 0.24, g: 0.3 });
    K.tone({ f: 6272, d: 0.12, g: 0.15 });
    K.tone({ type: 'triangle', f: 1568, d: 0.08, g: 0.25 });
  } },
  kill_confirm: { dur: 0.5, level: 0.65, drive: 1, render: (K) => {
    K.thump(0, 130, 60, 0.12, 1, 0.05);
    K.click(0, 0.5, 3000, 0.004);
    K.tone({ type: 'square', f: 880, d: 0.1, g: 0.35, lp: 3200 });
    K.tone({ type: 'square', f: 1319, t: 0.065, d: 0.2, g: 0.35, lp: 3600 });
    K.tone({ f: 2637, t: 0.065, d: 0.25, g: 0.2 });
    K.noise({ hp: 6000, t: 0.06, a: 0.01, d: 0.2, g: 0.12 });
  } },
  hurt: { dur: 0.4, variants: 3, level: 0.75, drive: 1.2, render: (K, R) => {
    K.thump(0, 110, 45, 0.15, 1, 0.06);
    K.noise({ color: 'brown', lp: 600, d: 0.09, g: 0.8 });
    grunt(K, 0.01, R.range(120, 160), 0.2, 0.55);
  } },
  armor_hit: { dur: 0.4, variants: 2, level: 0.65, drive: 1.5, render: (K, R) => {
    K.ring(0, [1250, 2730, 4100].map((f) => R.vary(f, 0.03)), 0.22, 0.25, 'triangle');
    K.noise({ bp: 2500, q: 1.5, d: 0.05, g: 0.8 });
    K.click(0, 0.8, 2500, 0.004);
    K.thump(0, 200, 90, 0.06, 0.6, 0.03);
    K.grains({ t0: 0, t1: 0.05, n: 5, g: 0.3, f: 3500 });
  } },
  death: { dur: 1.4, level: 0.8, drive: 1.5, render: (K) => {
    K.thump(0, 85, 28, 0.7, 1.2, 0.3);
    K.noise({ color: 'brown', lp: [1500, 150, 0.6], d: 0.6, g: 0.8 });
    K.tone({ type: 'sawtooth', f: 420, f1: 55, glide: 0.9, a: 0.01, d: 0.9, g: 0.35, lp: [2000, 200, 0.9] });
    grunt(K, 0.02, 115, 0.45, 0.6, 0.6);
  } },
  respawn: { dur: 1.5, level: 0.7, render: (K) => {
    K.noise({ bp: [200, 6500, 0.8], q: 1.5, a: 0.75, d: 0.1, g: 0.6 });
    K.tone({ type: 'sawtooth', f: 110, f1: 440, glide: 0.8, a: 0.7, d: 0.15, g: 0.25, lp: [400, 4000, 0.8] });
    K.tone({ type: 'sawtooth', f: 111.5, f1: 446, glide: 0.8, a: 0.7, d: 0.15, g: 0.25, lp: [400, 4000, 0.8] });
    K.pings({ t0: 0.2, t1: 0.85, n: 18, f0: 2000, f1: 7000, d0: 0.05, d1: 0.15, g: 0.12, decay: 0.6, amp: 'up' });
    const T = 0.82; // materialize pop
    K.click(T, 0.8, 2000, 0.005);
    K.tone({ f: 1760, t: T, d: 0.35, g: 0.45 });
    K.tone({ f: 2637, t: T, d: 0.25, g: 0.25 });
    K.thump(T, 140, 55, 0.25, 0.9, 0.08);
    K.noise({ color: 'pink', t: T, lp: [5000, 600, 0.4], d: 0.5, g: 0.3 });
  } },

  // ---- Pickups ----
  pickup_health: { dur: 0.65, level: 0.55, render: (K) => {
    [523.25, 659.25, 783.99, 1046.5].forEach((f, i) => {
      K.tone({ type: 'triangle', f, t: i * 0.055, d: 0.28, g: 0.45 });
      K.tone({ f: f * 2, t: i * 0.055, d: 0.12, g: 0.12 });
    });
    K.noise({ color: 'pink', bp: [800, 3000, 0.25], q: 1, a: 0.05, d: 0.2, g: 0.15 });
  } },
  pickup_armor: { dur: 0.6, level: 0.6, render: (K) => {
    K.click(0, 0.7, 2000, 0.005);
    K.ring(0.002, [600, 1500, 2600], 0.3, 0.2, 'triangle');
    K.thump(0, 160, 80, 0.08, 0.7, 0.04);
    K.tone({ type: 'square', f: 220, f1: 660, glide: 0.18, t: 0.05, a: 0.01, d: 0.25, g: 0.18, lp: 2400 });
    K.tone({ type: 'square', f: 330, f1: 990, glide: 0.18, t: 0.05, a: 0.01, d: 0.25, g: 0.1, lp: 2400 });
  } },
  pickup_energy: { dur: 1.1, level: 0.65, render: (K) => {
    K.click(0, 1, 2500, 0.004); // can tab crack
    K.noise({ bp: 1300, q: 3, d: 0.025, g: 0.8 });
    K.thump(0, 900, 400, 0.02, 0.3, 0.015);
    K.noise({ hp: 3500, t: 0.008, a: 0.004, d: 0.35, g: 0.7 }); // pressurised hiss
    K.noise({ bp: 6500, q: 0.8, t: 0.01, a: 0.01, d: 0.6, g: 0.25 });
    K.pings({ t0: 0.04, t1: 0.85, n: 36, f0: 1800, f1: 5200, d0: 0.006, d1: 0.02, g: 0.22, decay: 1.3, bend: 0.25 }); // fizz
    K.tone({ f: 1046.5, f1: 2093, glide: 0.4, t: 0.15, a: 0.15, d: 0.5, g: 0.22 }); // energy shimmer
    const tr = K.trem(14, 0.4, 0.15, 0.9);
    K.tone({ type: 'triangle', f: 1568, t: 0.2, a: 0.2, d: 0.5, g: 0.18, dest: tr });
    K.tone({ type: 'triangle', f: 1575, t: 0.2, a: 0.2, d: 0.5, g: 0.18, dest: tr });
  } },
  pickup_mega: { dur: 1.3, level: 0.75, drive: 1.2, render: (K) => {
    K.thump(0, 75, 40, 0.35, 1.2, 0.12);
    K.click(0, 0.7, 2000, 0.005);
    [349.23, 440, 523.25, 698.46, 880].forEach((f, i) => {
      const t = 0.04 + i * 0.05;
      K.tone({ type: 'sawtooth', f, t, d: 0.5, g: 0.18, lp: [3000, 900, 0.5] });
      K.tone({ type: 'sawtooth', f: f * 1.004, t, d: 0.5, g: 0.12, lp: [3000, 900, 0.5] });
    });
    K.pings({ t0: 0.1, t1: 0.9, n: 14, f0: 3000, f1: 8000, d0: 0.08, d1: 0.2, g: 0.1 });
    K.noise({ color: 'pink', bp: [400, 5000, 0.3], q: 1, a: 0.1, d: 0.6, g: 0.25 });
  } },
  pickup_weapon: { dur: 0.5, level: 0.65, render: (K) => {
    K.noise({ color: 'pink', bp: [500, 1800, 0.12], q: 1.2, a: 0.03, d: 0.08, g: 0.4 });
    K.click(0.08, 1, 2200, 0.006);
    K.thump(0.08, 210, 95, 0.07, 0.9, 0.03);
    K.ring(0.08, [820, 2050, 3400, 4900], 0.12, 0.2, 'triangle');
    K.click(0.2, 0.6, 3000, 0.004);
    K.ring(0.2, [1300, 3100], 0.05, 0.1, 'triangle');
  } },
  pickup_ammo: { dur: 0.35, level: 0.5, render: (K, R) => {
    for (let i = 0; i < 5; i++) {
      const t = i * 0.035 + R() * 0.01;
      K.click(t, 0.5, 3000, 0.003);
      K.ring(t, [R.range(1800, 2600), R.range(3800, 5200)], 0.04, 0.1, 'triangle');
    }
    K.thump(0, 180, 90, 0.06, 0.5, 0.03);
    K.noise({ color: 'pink', bp: 1200, q: 1, d: 0.05, g: 0.2 });
  } },
  energy_rush_start: { dur: 2.1, level: 1, drive: 1.8, render: (K) => {
    K.noise({ color: 'pink', bp: [200, 5200, 0.5], q: 1.2, a: 0.45, d: 0.15, g: 0.8 }); // whoosh in
    K.tone({ type: 'sawtooth', f: 300, f1: 3200, glide: 0.45, a: 0.4, d: 0.1, g: 0.25, lp: 6000 });
    const T = 0.42; // bass hit
    K.click(T, 1, 1500, 0.006);
    K.thump(T, 90, 30, 0.9, 1.4, 0.3);
    K.tone({ type: 'sawtooth', f: 55, t: T, d: 0.7, g: 0.5, lp: [900, 120, 0.6] });
    K.noise({ t: T, lp: [8000, 900, 0.3], d: 0.35, g: 0.8 });
    const tr = K.trem(16, 0.45, T, 1.4);
    for (const f of [2093, 2637, 3136]) K.tone({ f, t: T, a: 0.05, d: 1.1, g: 0.12, dest: tr });
    K.pings({ t0: T + 0.03, t1: 1.6, n: 20, f0: 2500, f1: 8000, d0: 0.05, d1: 0.18, g: 0.12 });
    K.grains({ t0: T, t1: 1.3, n: 20, g: 0.18, f: 5500 });
  } },
  energy_full: { dur: 0.6, level: 0.55, render: (K) => {
    K.tone({ f: 1318.5, d: 0.3, g: 0.4 });
    K.tone({ f: 1324, d: 0.3, g: 0.25 });
    K.tone({ f: 1760, t: 0.08, d: 0.4, g: 0.4 });
    K.tone({ f: 1767, t: 0.08, d: 0.4, g: 0.25 });
    K.tone({ type: 'sawtooth', f: 800, f1: 2400, glide: 0.12, d: 0.12, g: 0.1, lp: 5000 });
    K.noise({ hp: 6000, a: 0.02, d: 0.25, g: 0.08 });
  } },
  vending: { dur: 0.9, level: 0.65, render: (K) => {
    K.tone({ type: 'sawtooth', f: 85, a: 0.03, d: 0.32, g: 0.35, lp: 380 }); // motor whirr
    K.noise({ color: 'brown', lp: 500, a: 0.03, d: 0.3, g: 0.3 });
    K.thump(0.38, 240, 130, 0.09, 1, 0.04); // can lands in the tray
    K.noise({ t: 0.38, color: 'pink', bp: 850, q: 4, d: 0.14, g: 0.8 });
    K.click(0.38, 0.6, 1500, 0.006);
    K.ring(0.38, [520, 1270], 0.12, 0.1, 'triangle');
    K.thump(0.5, 260, 150, 0.05, 0.4, 0.03);
    K.noise({ t: 0.5, bp: 900, q: 4, d: 0.06, g: 0.35 });
    K.thump(0.57, 270, 160, 0.03, 0.2, 0.02);
  } },

  // ---- UI ----
  ui_hover: { dur: 0.04, level: 0.2, render: (K) => {
    K.tone({ f: 3200, d: 0.012, g: 0.4 });
    K.click(0, 0.3, 6000, 0.002);
  } },
  ui_click: { dur: 0.1, level: 0.4, render: (K) => {
    K.tone({ type: 'square', f: 1250, d: 0.02, g: 0.3, lp: 4000 });
    K.thump(0, 190, 90, 0.04, 0.6, 0.02);
    K.click(0, 0.4, 4000, 0.003);
  } },
  ui_back: { dur: 0.12, level: 0.35, render: (K) => {
    K.tone({ type: 'triangle', f: 950, f1: 480, glide: 0.07, d: 0.07, g: 0.4 });
    K.click(0, 0.3, 4000, 0.003);
  } },
  countdown_tick: { dur: 0.32, level: 0.6, render: (K) => {
    K.tone({ type: 'square', f: 880, d: 0.14, g: 0.3, lp: 3500 });
    K.tone({ f: 880, d: 0.18, g: 0.4 });
    K.tone({ f: 1760, d: 0.08, g: 0.15 });
    K.thump(0, 140, 60, 0.12, 0.8, 0.05);
    K.click(0, 0.6, 3000, 0.004);
  } },
  countdown_go: { dur: 1.1, level: 0.85, drive: 1.8, render: (K) => {
    chordStab(K, 0, [440, 554.37, 659.25, 880], { d: 0.7, g: 0.15, lp: [5000, 1200, 0.6] });
    K.thump(0, 110, 35, 0.5, 1.3, 0.15);
    K.click(0, 1, 2000, 0.005);
    K.noise({ color: 'pink', lp: [9000, 800, 0.5], d: 0.6, g: 0.5 });
  } },
  match_point: { dur: 1.4, level: 0.75, drive: 1.4, render: (K) => {
    K.thump(0, 90, 40, 0.3, 1.1, 0.1);
    K.thump(0.28, 90, 40, 0.4, 1.2, 0.1);
    const tr = K.trem(10, 0.4, 0, 1.3);
    K.tone({ type: 'square', f: 659.25, a: 0.01, d: 0.9, g: 0.15, lp: 2500, dest: tr });
    K.tone({ type: 'square', f: 622.25, t: 0.28, a: 0.01, d: 0.9, g: 0.15, lp: 2500, dest: tr });
    K.noise({ color: 'pink', t: 0.28, lp: [6000, 500, 0.6], d: 0.6, g: 0.4 });
  } },
  victory_sting: { dur: 3, level: 0.9, drive: 1.6, render: (K) => {
    const hits = [[0, [138.59, 174.61, 207.65], 0.28], [0.3, [155.56, 196, 233.08], 0.28], [0.6, [87.31, 174.61, 220, 261.63, 349.23], 2.2]];
    for (const [t, ch, d] of hits) {
      chordStab(K, t, ch, { d, g: 0.16, lp: [6000, 1200, d * 0.8], lpq: 2 });
      K.thump(t, 110, 40, d > 1 ? 0.8 : 0.25, 1.1, 0.1);
      K.click(t, 0.7, 2000, 0.005);
    }
    K.noise({ t: 0.6, hp: 3000, a: 0.002, d: 1.6, g: 0.35 }); // crash
    K.pings({ t0: 0.65, t1: 2.4, n: 22, f0: 2000, f1: 7000, d0: 0.1, d1: 0.3, g: 0.08, decay: 1.2 });
  } },
  defeat_sting: { dur: 3, level: 0.85, drive: 1.4, render: (K) => {
    chordStab(K, 0, [174.61, 207.65, 261.63], { d: 0.4, g: 0.16, lp: [3000, 900, 0.4] });
    K.thump(0, 100, 40, 0.3, 1, 0.1);
    chordStab(K, 0.45, [138.59, 174.61, 207.65], { d: 0.4, g: 0.16, lp: [2600, 800, 0.4] });
    K.thump(0.45, 95, 38, 0.3, 1, 0.1);
    chordStab(K, 0.9, [87.31, 130.81, 174.61, 207.65], { d: 2, g: 0.18, lp: [3000, 180, 1.9], drop: -1.2 });
    K.thump(0.9, 70, 24, 1.2, 1.4, 0.5);
    K.noise({ color: 'brown', t: 0.9, lp: [1500, 150, 1.5], d: 1.8, g: 0.6 });
  } },

  // ---- Internal: heartbeat loop (exactly 0.5 s = 120 bpm) ----
  heartbeat: { dur: 0.5, level: 0.9, drive: 1.5, render: (K) => {
    K.thump(0, 62, 38, 0.13, 1, 0.06);
    K.noise({ color: 'brown', lp: 160, d: 0.08, g: 0.7 });
    K.thump(0.17, 56, 34, 0.12, 0.75, 0.06);
    K.noise({ t: 0.17, color: 'brown', lp: 140, d: 0.07, g: 0.5 });
  } },

  // ---- Internal: announcer stingers ----
  ann_big: { dur: 2, level: 0.95, drive: 2.2, render: (K) => {
    K.noise({ color: 'pink', bp: [300, 3000, 0.12], q: 1, a: 0.11, d: 0.012, g: 0.5 }); // suck-in
    const T = 0.12;
    K.click(T, 1, 1500, 0.006);
    K.thump(T, 70, 26, 1, 1.5, 0.35);
    K.tone({ type: 'sawtooth', f: 55, t: T, d: 0.8, g: 0.6, lp: [1400, 120, 0.7], lpq: 6 });
    K.tone({ type: 'square', f: 41.2, t: T, d: 0.6, g: 0.3, lp: 300 });
    K.noise({ t: T, lp: [9000, 700, 0.8], d: 0.9, g: 0.55 });
    K.ring(T, [220, 557, 1031, 1643], 0.9, 0.08, 'triangle');
  } },
  ann_mid: { dur: 1.2, level: 0.85, drive: 2, render: (K) => {
    K.noise({ color: 'pink', bp: [400, 3500, 0.07], q: 1, a: 0.065, d: 0.01, g: 0.4 });
    const T = 0.07;
    K.click(T, 1, 1800, 0.005);
    K.thump(T, 80, 32, 0.55, 1.3, 0.2);
    K.tone({ type: 'sawtooth', f: 65, t: T, d: 0.4, g: 0.45, lp: [1200, 150, 0.4], lpq: 4 });
    K.noise({ t: T, lp: [8000, 900, 0.4], d: 0.45, g: 0.4 });
  } },
  ann_count: { dur: 0.7, level: 0.8, drive: 1.8, render: (K) => {
    K.click(0, 1, 2000, 0.005);
    K.thump(0, 120, 48, 0.28, 1.2, 0.08);
    K.noise({ lp: [7000, 900, 0.15], d: 0.18, g: 0.6 });
    K.ring(0.001, [440, 1108, 1870], 0.25, 0.08, 'triangle');
  } },
  ann_dark: { dur: 2.2, level: 0.9, drive: 2.4, render: (K) => {
    K.noise({ color: 'brown', lp: [200, 1200, 0.15], a: 0.14, d: 0.02, g: 0.6 });
    const T = 0.15;
    K.thump(T, 60, 22, 1.3, 1.5, 0.6);
    K.tone({ type: 'sawtooth', f: 49, f1: 36, glide: 1.4, t: T, d: 1.4, g: 0.6, lp: [800, 90, 1.2] });
    K.tone({ type: 'sawtooth', f: 98, f1: 73, glide: 1.5, t: T, d: 1.5, g: 0.3, lp: [1600, 200, 1.2] });
    K.noise({ t: T, lp: [3000, 300, 1], d: 1.2, g: 0.5 });
  } },

  // ---- Internal: music one-shots ----
  mx_kick: { dur: 0.42, level: 0.9, drive: 2, render: (K) => {
    K.thump(0, 190, 48, 0.3, 1.2, 0.045);
    K.tone({ f: 60, f1: 44, glide: 0.2, d: 0.32, g: 0.6 });
    K.click(0, 0.5, 3500, 0.003);
    K.noise({ color: 'pink', bp: 2800, q: 1, d: 0.012, g: 0.25 });
  } },
  mx_kick_heavy: { dur: 0.8, level: 0.9, drive: 2.6, render: (K) => {
    K.thump(0, 140, 34, 0.6, 1.3, 0.08);
    K.tone({ f: 46, f1: 32, glide: 0.5, d: 0.65, g: 0.7 });
    K.click(0, 0.6, 2500, 0.004);
    K.noise({ color: 'brown', lp: [1500, 200, 0.1], d: 0.12, g: 0.7 });
  } },
  mx_snare: { dur: 0.35, level: 0.85, drive: 2.2, render: (K) => {
    K.tone({ type: 'triangle', f: 230, f1: 175, glide: 0.06, d: 0.09, g: 0.7 });
    K.tone({ f: 340, d: 0.05, g: 0.3 });
    K.noise({ bp: 1900, q: 0.6, d: 0.17, g: 1 });
    K.noise({ hp: 5500, d: 0.11, g: 0.45 });
    K.click(0, 0.4, 3000, 0.003);
  } },
  mx_snare_heavy: { dur: 0.9, level: 0.85, drive: 2.5, render: (K) => {
    K.tone({ type: 'triangle', f: 210, f1: 160, glide: 0.08, d: 0.12, g: 0.7 });
    K.thump(0, 160, 90, 0.12, 0.6, 0.05);
    K.noise({ bp: 1700, q: 0.6, d: 0.22, g: 1 });
    K.noise({ hp: 5000, d: 0.14, g: 0.45 });
    K.noise({ color: 'pink', lp: [4000, 800, 0.5], a: 0.004, d: 0.6, g: 0.35 }); // room
    K.click(0, 0.5, 3000, 0.003);
  } },
  mx_hat: { dur: 0.08, level: 0.5, render: (K) => {
    metalCluster(K, 0, 0.035, 0.5, 1.6, 7000);
    K.noise({ hp: 8000, d: 0.025, g: 0.3 });
  } },
  mx_hat_open: { dur: 0.32, level: 0.45, render: (K) => {
    metalCluster(K, 0, 0.2, 0.5, 1.6, 6500);
    K.noise({ hp: 7500, d: 0.18, g: 0.3 });
  } },
  mx_shaker: { dur: 0.08, level: 0.4, render: (K) => {
    K.noise({ bp: 6500, q: 1.2, a: 0.012, d: 0.04, g: 1 });
  } },
  mx_metal: { dur: 1, variants: 2, level: 0.6, render: (K, R) => {
    K.click(0, 0.7, 2000, 0.004);
    K.ring(0.001, [523, 1187, 1830, 2741, 3911].map((f) => R.vary(f, 0.04)), 0.7, 0.22, 'triangle');
    K.noise({ bp: 2500, q: 2, d: 0.05, g: 0.4 });
    K.thump(0, 300, 150, 0.04, 0.3, 0.03);
  } },
  mx_crash: { dur: 2, level: 0.6, render: (K) => {
    metalCluster(K, 0, 1.4, 0.6, 1.1, 4500);
    K.noise({ hp: 3500, a: 0.002, d: 1.6, g: 0.7 });
    K.noise({ color: 'pink', bp: 6000, q: 0.5, d: 0.9, g: 0.3 });
  } },
  mx_stab: { dur: 0.5, level: 0.7, drive: 2, render: (K) => {
    chordStab(K, 0, [174.61, 207.65, 261.63, 349.23], { d: 0.32, g: 0.25, lp: [5200, 700, 0.28], lpq: 4 });
    K.tone({ type: 'sawtooth', f: 87.31, d: 0.3, g: 0.3, lp: [2000, 300, 0.25] });
  } },
  mx_riser: { dur: 2.85, level: 0.6, render: (K) => {
    K.noise({ bp: [300, 9000, 2.7], q: 2, a: 2.6, d: 0.08, g: 0.8 });
    K.noise({ color: 'pink', hp: [200, 3000, 2.7], a: 2.6, d: 0.08, g: 0.4 });
    K.tone({ type: 'sawtooth', f: 87.31, f1: 698.46, glide: 2.7, a: 2.6, d: 0.08, g: 0.15, lp: [400, 6000, 2.7] });
  } },
  mx_sweep: { dur: 5.5, level: 0.5, render: (K) => {
    const f = K.filter('bandpass', 180, 3);
    f.frequency.exponentialRampToValueAtTime(2400, 2.6);
    f.frequency.exponentialRampToValueAtTime(200, 5.2);
    K.connect(K.noiseSrc('pink', 0, 5.3), f, K.env(0, 2.4, 2.8, 0.8), K.out);
  } },
  mx_impact: { dur: 1.5, level: 0.85, drive: 2, render: (K) => {
    K.thump(0, 62, 26, 1.1, 1.4, 0.5);
    K.noise({ color: 'brown', lp: [2000, 150, 0.8], d: 0.9, g: 0.8 });
    K.click(0, 0.6, 1500, 0.005);
  } },

  // ---- Internal: ambient loops ----
  amb_reactor_hum: { dur: 4, loop: 0.5, tonal: true, level: 0.38, render: (K) => {
    const L = K.len;
    for (const [f, g] of [[55, 0.5], [55.25, 0.35], [110, 0.25], [165, 0.12], [220.5, 0.06]]) {
      K.connect(K.osc('sine', f, 0, L), K.gain(g), K.out);
    }
    const nb = K.filter('bandpass', 380, 1.2);
    K.lfo(nb.frequency, 0.25, 120, 0, L);
    K.connect(K.noiseSrc('pink', 0, L), nb, K.gain(0.18), K.out);
    K.connect(K.noiseSrc('brown', 0, L), K.filter('lowpass', 180), K.gain(0.35), K.out);
  } },
  amb_machinery: { dur: 2.4, loop: 0.3, tonal: true, level: 0.5, render: (K) => {
    const L = K.len;
    K.connect(K.osc('sawtooth', 50, 0, L), K.filter('lowpass', 280), K.gain(0.3), K.out);
    K.connect(K.osc('sine', 100, 0, L), K.gain(0.2), K.out);
    [0, 0.6, 1.2, 1.8, 2.4].forEach((t, i) => {
      const p = i % 2 ? 0.8 : 1;
      K.thump(t, 170 * p, 80 * p, 0.08, 0.5, 0.03);
      K.ring(t, [310 * p, 740 * p, 1290 * p], 0.18, 0.12, 'triangle');
      K.noise({ t: t + 0.3, bp: 2200, q: 1, a: 0.02, d: 0.15, g: 0.18 }); // piston hiss
    });
  } },
  amb_electric_hum: { dur: 2, loop: 0.25, tonal: true, level: 0.22, render: (K) => {
    const L = K.len;
    K.connect(K.osc('sawtooth', 120, 0, L), K.filter('bandpass', 1500, 1), K.gain(0.3), K.out);
    K.connect(K.osc('sine', 60, 0, L), K.gain(0.4), K.out);
    K.connect(K.osc('sine', 180, 0, L), K.gain(0.15), K.out);
    K.connect(K.osc('square', 240, 0, L), K.filter('lowpass', 900), K.gain(0.05), K.out);
    K.grains({ t0: 0, t1: L, n: 6, decay: 1, amp: 'flat', g: 0.25, f: 5000, d0: 0.002, d1: 0.01 });
  } },
  amb_fan: { dur: 2, loop: 0.3, level: 0.42, render: (K) => {
    const L = K.len;
    const am = K.trem(12, 0.3, 0, L);
    K.connect(K.noiseSrc('pink', 0, L), K.filter('lowpass', 1100), am);
    K.connect(K.noiseSrc('brown', 0, L), K.filter('lowpass', 200), K.gain(0.5), K.out);
    K.connect(K.osc('sine', 48, 0, L), K.gain(0.15), K.out);
  } },
  amb_steam: { dur: 3, loop: 0.4, level: 0.42, render: (K) => {
    const L = K.len;
    const am = K.trem(1 / 3, 0.35, 0, L);
    K.connect(K.noiseSrc('white', 0, L), K.filter('highpass', 1800), K.filter('bandpass', 5000, 0.6), am);
    K.connect(K.noiseSrc('pink', 0, L), K.filter('bandpass', 900, 0.7), K.gain(0.2), K.out);
  } },
  amb_alarm: { dur: 2, loop: 0.1, tonal: true, level: 0.3, drive: 1.2, render: (K) => {
    for (let i = 0; i < 5; i++) {
      const t = i * 0.5;
      const f = i % 2 ? 520 : 660;
      K.tone({ type: 'square', f, t, a: 0.01, hold: 0.42, d: 0.05, g: 0.4, bp: 1400, bpq: 0.8 });
      K.tone({ type: 'sawtooth', f: f / 2, t, a: 0.01, hold: 0.42, d: 0.05, g: 0.15, lp: 1200 });
    }
  } },
};

// ---------------------------------------------------------------------------------------
// Tables: voice limits, announcer, music patterns
// ---------------------------------------------------------------------------------------

const VOICE_LIMITS = {
  pistol_fire: 5, razor_fire: 6, volt_fire: 6, crush_fire: 4, venom_fire: 4, chaos_fire: 4, rail_fire: 3,
  rail_charge: 2, rocket_loop: 4, explosion: 4, barrel_explode: 3, slide: 2, heartbeat: 1,
  hitmarker: 4, headshot_marker: 3, ui_hover: 2, ui_click: 3, bullet_whiz: 3, ricochet: 4, spark: 4,
  impact_concrete: 6, impact_metal: 6, impact_glass: 5, jump: 2, land: 2, land_hard: 2,
};
const STEP_LIMIT = 4;
const DEFAULT_LIMIT = 6;
const MAX_VOICES = 56;

const ANNOUNCER = {
  first_blood: { say: 'First blood', sting: 'ann_big' },
  double_down: { say: 'Double down', sting: 'ann_mid' },
  dominating: { say: 'Dominating', sting: 'ann_big' },
  revenge: { say: 'Revenge', sting: 'ann_mid', pitch: 0.94 },
  energy_rush_ready: { say: 'Energy rush ready', sting: 'ann_mid', pitch: 1.12 },
  match_point: { say: 'Match point', sting: 'ann_big' },
  sudden_death: { say: 'Sudden death', sting: 'ann_dark' },
  victory: { say: 'Victory', sting: 'ann_big' },
  defeat: { say: 'Defeat', sting: 'ann_dark' },
  fight: { say: 'Fight!', sting: 'ann_big', now: true, rate: 1.05 },
  three: { say: 'Three', sting: 'ann_count', now: true },
  two: { say: 'Two', sting: 'ann_count', now: true, pitch: 1.06 },
  one: { say: 'One', sting: 'ann_count', now: true, pitch: 1.12 },
  eliminated: { say: 'Eliminated', sting: 'ann_dark', vol: 0.75 },
  headshot: { say: 'Headshot', sting: 'ann_mid', pitch: 1.1 },
};
const PREFERRED_VOICES = ['Google UK English Male', 'Microsoft Guy', 'Microsoft Davis', 'Microsoft Christopher',
  'Microsoft David', 'Microsoft Mark', 'Daniel', 'Alex', 'Fred', 'Ralph', 'Aaron', 'Arthur', 'Oliver', 'Rishi'];
const SPEECH_GAP_MS = 250;
const SPEECH_MAX_WAIT_MS = 2500;

const OPEN_FREQ = 20000;
const MUFFLE_SFX = 480;
const MUFFLE_MUSIC = 650;
const TRIM = { master: 0.9, sfx: 0.85, ui: 0.6, music: 0.55, announcer: 0.9, ambient: 0.5 };

const F1 = 43.654; // bass root (F1)
const MATCH_PROG = [0, 0, 3, 3, -4, -4, -2, -2]; // F, Ab, Db, Eb (semitones), one entry per bar
// [step, lengthSteps, reese offset in semitones]
const BASS_PATTERNS = [
  [[0, 10, 0], [10, 4, 0], [14, 2, 12]],
  [[0, 6, 0], [6, 4, 12], [10, 6, 0]],
  [[0, 14, 0], [14, 2, 7]],
  [[0, 3, 0], [3, 7, 0], [10, 3, 12], [13, 3, 7]],
];
const BASS_FILL = [[0, 8, 0], [8, 4, 12]];
const DRUM_PATTERNS = [
  { k: [0, 10], s: [4, 12] },
  { k: [0, 10], s: [4, 12], g: [7, 15] },
  { k: [0, 2, 10], s: [4, 12], g: [14] },
  { k: [0, 6, 10], s: [4, 12], g: [3, 9] },
  { k: [0, 10, 11], s: [4, 12], g: [7] },
];
const PHRASE = [0, 1, 0, 2, 0, 3, 4]; // bar 8 of each phrase is a fill
const FILL = { k: [0, 10], s: [4], roll: true };
const HAT_ACCENT = [0.42, 0.18, 0.32, 0.2];
const STAB_PATTERNS = [[0, 3, 6], [0, 3, 6, 10], [0, 6, 8, 11, 14], [2, 5, 8]];
const MENU_CHORDS = [[0, 7, 12, 15], [-4, 3, 8, 12], [3, 10, 15, 19], [-2, 5, 10, 14]]; // vs F2
const METAL_RATES = [0.5, 0.6667, 0.75, 1, 1.3333];

// ---------------------------------------------------------------------------------------
// Music tracks (live synthesis driven by the engine's lookahead scheduler)
// ---------------------------------------------------------------------------------------

class MusicTrack {
  constructor(eng, bpm) {
    this.eng = eng;
    this.ctx = eng.ctx;
    this.stepDur = 60 / bpm / 4; // 16th notes
    this.step = 0;
    this.nextTime = this.ctx.currentTime + 0.1;
    this.stopped = false;
    this.I = 0;
    this.sd = false;
    this._nodes = [];
    this._srcs = [];
    this._last = {};
    this.out = this.gainNode(0, eng.musicIn);
  }

  node(n) {
    this._nodes.push(n);
    return n;
  }

  gainNode(v, dest) {
    const g = this.ctx.createGain();
    g.gain.value = v;
    if (dest) g.connect(dest);
    return this.node(g);
  }

  filterNode(type, f, q, dest) {
    const b = this.ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    if (dest) b.connect(dest);
    return this.node(b);
  }

  osc(type, f, detune, dest) {
    const o = this.ctx.createOscillator();
    o.type = type;
    o.frequency.value = f;
    o.detune.value = detune || 0;
    if (dest) o.connect(dest);
    o.start();
    this._srcs.push(o);
    return this.node(o);
  }

  /** LFO osc -> depth gain -> param. */
  lfo(param, rate, depth, type = 'sine') {
    const g = this.gainNode(depth);
    g.connect(param);
    this.osc(type, rate, 0, g);
  }

  /** Fire-and-forget one-shot from a pre-rendered buffer. */
  hit(name, t, vel, dest, rate = 1, pan = 0) {
    const buf = this.eng._musicBuf(name);
    if (!buf || vel <= 0) return;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = buf;
    src.playbackRate.value = rate;
    const g = c.createGain();
    g.gain.value = vel;
    src.connect(g);
    let p = null;
    if (pan && c.createStereoPanner) {
      p = c.createStereoPanner();
      p.pan.value = clamp(pan, -1, 1);
      g.connect(p);
      p.connect(dest);
    } else {
      g.connect(dest);
    }
    src.onended = () => {
      src.disconnect();
      g.disconnect();
      if (p) p.disconnect();
    };
    src.start(Math.max(0, t));
  }

  /** Smoothed layer gain change; skips redundant automation. */
  setLayer(key, param, v, tc = 0.25) {
    const last = this._last[key];
    if (last !== undefined && Math.abs(last - v) < 0.008) return;
    this._last[key] = v;
    param.setTargetAtTime(v, this.ctx.currentTime, tc);
  }

  /** Sidechain-style pump on the bass/pad bus. */
  duck(t, depth = 0.25) {
    const g = this.pump.gain;
    g.setTargetAtTime(depth, t, 0.003);
    g.setTargetAtTime(1, t + 0.05, 0.08);
  }

  update(I, sd) {
    this.I = I;
    this.sd = sd;
  }

  schedule(now, until) {
    if (this.stopped) return;
    if (this.nextTime < now - 0.02) {
      // throttled tab / hitch: skip missed steps instead of bursting them
      const miss = Math.ceil((now - this.nextTime) / this.stepDur);
      this.step += miss;
      this.nextTime += miss * this.stepDur;
    }
    while (this.nextTime < until) {
      try {
        this.playStep(this.step, this.nextTime);
      } catch (e) { /* never let one bad step kill the scheduler */ }
      this.step++;
      this.nextTime += this.stepDur;
    }
  }

  fadeIn(sec) {
    const g = this.out.gain;
    const now = this.ctx.currentTime;
    g.setValueAtTime(0, now);
    g.linearRampToValueAtTime(1, now + sec);
  }

  stop(sec) {
    if (this.stopped) return;
    this.stopped = true;
    const g = this.out.gain;
    const now = this.ctx.currentTime;
    holdParam(g, now);
    g.linearRampToValueAtTime(0, now + sec);
    setTimeout(() => this.dispose(), (sec + 0.4) * 1000);
  }

  dispose() {
    for (const s of this._srcs) {
      try { s.stop(); } catch (_) { /* already stopped */ }
    }
    for (const n of this._nodes) {
      try { n.disconnect(); } catch (_) { /* ignore */ }
    }
    this._srcs.length = 0;
    this._nodes.length = 0;
    const i = this.eng._tracks.indexOf(this);
    if (i >= 0) this.eng._tracks.splice(i, 1);
  }

  playStep() {}
}

/** Dark half-time industrial D&B for menus: drone, pad, sparse heavy drums, metal hits. */
class MenuTrack extends MusicTrack {
  constructor(eng) {
    super(eng, 172);
    const c = this.ctx;
    this.level = this.gainNode(0.9, this.out);
    this.drums = this.gainNode(0.75, this.level);
    this.pump = this.gainNode(1, this.level);
    // evolving detuned pad
    const padOut = this.gainNode(0.07, this.pump);
    this.padFilter = this.filterNode('lowpass', 650, 4, padOut);
    this.lfo(this.padFilter.frequency, 0.05, 380);
    this.padOscs = [];
    for (const s of MENU_CHORDS[0]) {
      for (const det of [-9, 9]) this.padOscs.push(this.osc('sawtooth', F1 * 2 * semis(s), det, this.padFilter));
    }
    // sub drone
    this.subGain = this.gainNode(0.38, this.pump);
    this.sub = this.osc('sine', F1, 0, this.subGain);
    // filtered noise "air" bed
    const air = this.gainNode(0.05, this.level);
    const airF = this.filterNode('bandpass', 500, 0.9, air);
    this.lfo(airF.frequency, 0.031, 300);
    const n = c.createBufferSource();
    n.buffer = eng._noise.pink;
    n.loop = true;
    n.connect(airF);
    n.start();
    this._srcs.push(n);
    this.node(n);
  }

  onBar(bar, t) {
    if (bar % 4 === 0) {
      const ch = MENU_CHORDS[(bar >> 2) % MENU_CHORDS.length];
      this.padOscs.forEach((o, i) => o.frequency.setTargetAtTime(F1 * 2 * semis(ch[i >> 1]), t, 0.6));
      this.sub.frequency.setTargetAtTime(F1 * semis(ch[0] > 6 ? ch[0] - 12 : ch[0]), t, 0.3);
    }
    if (bar % 8 === 4) this.hit('mx_sweep', t, 0.5, this.level);
    if (bar % 16 === 0 && bar > 0) this.hit('mx_crash', t, 0.2, this.drums);
  }

  playStep(step, t) {
    const s = step & 15;
    const bar = step >> 4;
    if (s === 0) this.onBar(bar, t);
    if (bar < 2) return; // atmospheric intro
    if (s === 0) { this.hit('mx_kick_heavy', t, 0.95, this.drums); this.duck(t, 0.5); }
    if (s === 8) this.hit('mx_snare_heavy', t, 0.85, this.drums);
    if (bar % 2 === 1 && s === 14) { this.hit('mx_kick_heavy', t, 0.55, this.drums); this.duck(t, 0.65); }
    if (bar % 4 === 3 && s === 11) this.hit('mx_kick_heavy', t, 0.45, this.drums);
    if (s % 4 === 2) this.hit('mx_hat', t, 0.14 + Math.random() * 0.04, this.drums);
    if (bar % 2 === 0 && s === 6) this.hit('mx_hat_open', t, 0.1, this.drums);
    if ((s & 1) && Math.random() < 0.07) {
      const rate = METAL_RATES[Math.floor(Math.random() * METAL_RATES.length)];
      this.hit('mx_metal', t, 0.18 + Math.random() * 0.14, this.drums, rate, Math.random() * 1.4 - 0.7);
    }
    if (bar % 8 === 7 && s >= 12) this.hit('mx_snare', t, 0.12 + (s - 12) * 0.06, this.drums, 0.9);
  }
}

/** 174 bpm D&B / industrial with intensity layers and a sudden-death alarm. */
class MatchTrack extends MusicTrack {
  constructor(eng) {
    super(eng, 174);
    this.level = this.gainNode(0.75, this.out);
    this.drums = this.gainNode(0.75, this.level);
    this.hats = this.gainNode(0, this.level);
    this.pump = this.gainNode(1, this.level);
    this.reeseLayer = this.gainNode(0, this.pump);
    this.lead = this.gainNode(0, this.level);
    this.alarmLayer = this.gainNode(0, this.level);
    // Reese: detuned saws -> resonant LP (LFO) -> drive -> tame -> VCA
    this.reeseVCA = this.gainNode(0, this.gainNode(0.3, this.reeseLayer));
    const tame = this.filterNode('lowpass', 2600, 0, this.reeseVCA);
    const shaper = this.node(this.ctx.createWaveShaper());
    shaper.curve = driveCurve(3);
    shaper.oversample = '2x';
    shaper.connect(tame);
    const pre = this.gainNode(0.45, shaper);
    this.reeseFilter = this.filterNode('lowpass', 400, 7, pre);
    this.lfo(this.reeseFilter.frequency, 174 / 60 / 2, 320);
    this.reeseOscs = [
      this.osc('sawtooth', F1 * 2, -16, this.reeseFilter),
      this.osc('sawtooth', F1 * 2, 14, this.reeseFilter),
      this.osc('sawtooth', F1, 5, this.reeseFilter),
    ];
    // Sub
    this.subVCA = this.gainNode(0, this.gainNode(0.55, this.pump));
    this.sub = this.osc('sine', F1, 0, this.subVCA);
    // Sudden-death alarm synth
    this.alarmVCA = this.gainNode(0, this.gainNode(0.22, this.alarmLayer));
    const af = this.filterNode('bandpass', 1500, 1.5, this.alarmVCA);
    this.alarmOscs = [this.osc('square', 740, -6, af), this.osc('square', 740, 6, af)];
    this.pat = DRUM_PATTERNS[0];
    this.bassMap = new Map();
    this.stab = null;
    this.root = 0;
    this.riser = false;
  }

  update(I, sd) {
    super.update(I, sd);
    this.setLayer('level', this.level.gain, 0.72 + 0.28 * I);
    this.setLayer('drums', this.drums.gain, 0.75 + 0.25 * I);
    this.setLayer('hats', this.hats.gain, 0.85 * smoothstep(0.3, 0.55, I));
    this.setLayer('reese', this.reeseLayer.gain, smoothstep(0.25, 0.55, I));
    this.setLayer('lead', this.lead.gain, smoothstep(0.7, 0.95, I));
    this.setLayer('alarm', this.alarmLayer.gain, sd ? 1 : 0, 0.4);
  }

  onBar(bar, t) {
    const pb = bar % 8;
    const I = this.I;
    this.root = MATCH_PROG[pb];
    if (pb === 7) {
      this.pat = FILL;
    } else {
      this.pat = DRUM_PATTERNS[PHRASE[pb]];
      if (Math.random() < 0.2) this.pat = DRUM_PATTERNS[1 + Math.floor(Math.random() * 4)];
    }
    const bp = pb === 7 ? BASS_FILL : BASS_PATTERNS[(pb + (bar >> 3)) % BASS_PATTERNS.length];
    this.bassMap.clear();
    for (const n of bp) this.bassMap.set(n[0], n);
    this.stab = bar % 2 === 1 ? STAB_PATTERNS[(bar >> 1) % STAB_PATTERNS.length] : null;
    this.reeseFilter.frequency.setTargetAtTime(240 + 760 * I + (pb >= 6 ? 250 : 0), t, 0.4);
    if (pb === 0) {
      if (I > 0.35 && bar > 0) this.hit('mx_crash', t, 0.45, this.drums);
      if (this.riser) this.hit('mx_impact', t, 0.8, this.drums);
      this.riser = false;
    }
    if (pb === 6 && I > 0.6) {
      this.hit('mx_riser', t, 0.6 * smoothstep(0.55, 0.9, I), this.level);
      this.riser = true;
    }
  }

  bassNote(t, semi, len, reeseOffset) {
    const f = F1 * semis(semi);
    const fr = f * semis(reeseOffset);
    const end = t + len * this.stepDur;
    const [a, b, c] = this.reeseOscs;
    a.frequency.setTargetAtTime(fr * 2, t, 0.008);
    b.frequency.setTargetAtTime(fr * 2, t, 0.008);
    c.frequency.setTargetAtTime(fr, t, 0.008);
    this.sub.frequency.setTargetAtTime(f, t, 0.008);
    for (const vca of [this.reeseVCA.gain, this.subVCA.gain]) {
      vca.setTargetAtTime(1, t, 0.004);
      vca.setTargetAtTime(0, Math.max(t + 0.01, end - 0.03), 0.02);
    }
  }

  playStep(step, t) {
    const s = step & 15;
    const bar = step >> 4;
    if (s === 0) this.onBar(bar, t);
    const P = this.pat;
    const I = this.I;
    const half = this.stepDur / 2;
    // kick / snare / ghosts / fills
    if (P.k.includes(s)) { this.hit('mx_kick', t, 0.95, this.drums); this.duck(t); }
    if (P.s.includes(s)) this.hit('mx_snare', t, 0.9, this.drums);
    if (P.g && P.g.includes(s)) this.hit('mx_snare', t, 0.2 + Math.random() * 0.08, this.drums, 1.04);
    if (P.roll && s >= 8) {
      const v = 0.25 + (0.7 * (s - 8)) / 7;
      this.hit('mx_snare', t, v, this.drums, 1 + (s - 8) * 0.012);
      if (s >= 12 && I > 0.45) this.hit('mx_snare', t + half, v * 0.8, this.drums, 1.1);
    }
    // hats: base offbeat 8ths always, 16th/shaker layer by intensity
    if (s % 4 === 2) this.hit('mx_hat', t, 0.3, this.drums);
    if ((this._last.hats || 0) > 0.02) {
      this.hit('mx_hat', t, HAT_ACCENT[s % 4] * (0.9 + Math.random() * 0.2), this.hats, s & 1 ? 1.04 : 1);
      if (s & 1) this.hit('mx_shaker', t + this.stepDur * 0.08, 0.25, this.hats);
      if ((s === 6 || s === 14) && bar % 2 === 1) this.hit('mx_hat_open', t, 0.3, this.hats);
    }
    if (this.sd) this.hit('mx_hat', t + half, 0.18, this.drums, 1.12); // sudden death: 32nd hats
    // bass
    const n = this.bassMap.get(s);
    if (n) this.bassNote(t, this.root, n[1], n[2]);
    // lead stabs
    if (this.stab && this.stab.includes(s) && (this._last.lead || 0) > 0.03) {
      this.hit('mx_stab', t, 0.55, this.lead, semis(this.root));
    }
    // sudden-death alarm: two-tone pulse every beat
    if (this.sd && s % 4 === 0) {
      const f = (step >> 2) & 1 ? 622.25 : 739.99;
      for (const o of this.alarmOscs) o.frequency.setValueAtTime(f, t);
      const g = this.alarmVCA.gain;
      g.setTargetAtTime(1, t, 0.006);
      g.setTargetAtTime(0, t + this.stepDur * 2.6, 0.03);
    }
  }
}

// ---------------------------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------------------------

function setPannerPosition(p, v) {
  if (!finite3(v)) return;
  if (p.positionX) {
    p.positionX.value = v.x;
    p.positionY.value = v.y;
    p.positionZ.value = v.z;
  } else if (p.setPosition) {
    p.setPosition(v.x, v.y, v.z);
  }
}

function pickVoice(voices) {
  if (!voices || !voices.length) return null;
  const en = voices.filter((v) => /^en/i.test(v.lang || ''));
  for (const pref of PREFERRED_VOICES) {
    const v = en.find((x) => x.name && x.name.includes(pref));
    if (v) return v;
  }
  const male = en.find((v) => /\b(male|man|guy|david|daniel|james|george)\b/i.test(v.name) && !/female/i.test(v.name));
  return male || en.find((v) => v.default) || en[0] || voices[0];
}

export class AudioEngine {
  constructor() {
    this.ctx = null;
    try {
      const AC = typeof window !== 'undefined' ? window.AudioContext || window.webkitAudioContext : null;
      if (AC) {
        try { this.ctx = new AC({ latencyHint: 'interactive' }); } catch (_) { this.ctx = new AC(); }
      }
    } catch (e) {
      this.ctx = null;
    }
    this._ready = false;
    this._graph = false;
    this._initPromise = null;
    this._buffers = new Map();
    this._lastVariant = new Map();
    this._voices = [];
    this._byName = new Map();
    this._ambient = new Set();
    this._tracks = [];
    this._track = null;
    this._musicMode = 'off';
    this._wantMusic = null;
    this._musicI = 0;
    this._musicTarget = 0;
    this._suddenDeath = false;
    this._muffled = false;
    this._slowRate = 1;
    this._slowUntil = 0;
    this._hb = null;
    this._hbNext = 0;
    this._vol = { master: 0.8, music: 0.5, effects: 0.9, announcer: 0.9 };
    this._lastResumeCall = 0;
    this._lastWall = nowMs();
    this._timer = null;
    // speech
    this._ss = null;
    this._voice = null;
    this._speechQueue = [];
    this._speaking = false;
    this._speechId = 0;
    this._speechDeadline = 0;
    this._lastSpeechEnd = 0;
    this._initSpeech();
  }

  get ready() {
    return this._ready;
  }

  // ----- lifecycle -----

  init(onProgress = () => {}) {
    if (!this._initPromise) this._initPromise = this._init(onProgress);
    return this._initPromise;
  }

  async _init(onProgress) {
    const report = (f) => {
      try { onProgress(clamp(f, 0, 1)); } catch (_) { /* caller's problem */ }
    };
    report(0);
    if (!this.ctx) { report(1); return; }
    try {
      this._noise = buildNoise(this.ctx);
      this._buildGraph();
    } catch (e) {
      console.warn('[audio] graph build failed', e);
      report(1);
      return;
    }
    await yieldToLoop();
    const OAC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const jobs = [];
    if (OAC) {
      for (const [name, def] of Object.entries(SOUND_DEFS)) {
        for (let v = 0; v < (def.variants || 1); v++) jobs.push([name, def, v]);
      }
    }
    const total = jobs.length + 1;
    let done = 1;
    report(done / total);
    const BATCH = 4;
    for (let i = 0; i < jobs.length; i += BATCH) {
      const batch = jobs.slice(i, i + BATCH);
      await Promise.all(batch.map(async ([name, def, v]) => {
        try {
          const buf = await this._renderSound(OAC, name, def, v);
          if (!this._buffers.has(name)) this._buffers.set(name, []);
          this._buffers.get(name)[v] = buf;
        } catch (e) {
          console.warn(`[audio] failed to render ${name}`, e);
        }
      }));
      done += batch.length;
      report(done / total);
      await yieldToLoop();
    }
    for (const [k, list] of this._buffers) this._buffers.set(k, list.filter(Boolean));
    this._ready = true;
    this._lastWall = nowMs();
    this._timer = setInterval(() => this._tick(), 25);
    if (this._wantMusic) this.startMusic(this._wantMusic);
    report(1);
  }

  async _renderSound(OAC, name, def, variant) {
    const sr = this.ctx.sampleRate;
    const loopX = def.loop || 0;
    const len = def.dur + loopX;
    const octx = new OAC(1, Math.max(1, Math.ceil(len * sr)), sr);
    const R = makeRng(hashStr(name) ^ Math.imul(variant + 1, 0x9e3779b1));
    const K = new Kit(octx, this._noise, R, len);
    let tail = K.out;
    if (def.drive) {
      const pre = octx.createGain();
      pre.gain.value = 0.25;
      const sh = octx.createWaveShaper();
      sh.curve = driveCurve(def.drive * 4);
      sh.oversample = '2x';
      K.out.connect(pre);
      pre.connect(sh);
      tail = sh;
    }
    tail.connect(octx.destination);
    def.render(K, R, variant);
    const rendered = await renderOffline(octx);
    let data = new Float32Array(rendered.getChannelData(0));
    if (loopX) data = loopify(data, Math.floor(loopX * sr), !!def.tonal);
    normalize(data, def.level ?? 0.8);
    if (!loopX) fadeEdges(data, sr, 0, 0.004);
    else if (def.fadeEdges) fadeEdges(data, sr, 0.004, 0.004);
    return toBuffer(this.ctx, [data]);
  }

  _buildGraph() {
    const c = this.ctx;
    const gain = (v = 1) => {
      const g = c.createGain();
      g.gain.value = v;
      return g;
    };
    const filt = (type, f, q = 0) => {
      const b = c.createBiquadFilter();
      b.type = type;
      b.frequency.value = f;
      b.Q.value = q;
      return b;
    };
    this.out = gain(0.92);
    this.out.connect(c.destination);
    this.limiter = c.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 10;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.2;
    this.limiter.connect(this.out);
    this.master = gain(1);
    this.master.connect(this.limiter);

    // reverb send bus
    this.reverb = c.createConvolver();
    this.reverb.buffer = buildImpulse(c);
    this.reverbHP = filt('highpass', 220);
    this.reverbTone = filt('lowpass', 6500);
    this.reverbReturn = gain(2.6); // convolver normalization is very quiet; make up here
    this.reverbHP.connect(this.reverb);
    this.reverb.connect(this.reverbTone);
    this.reverbTone.connect(this.reverbReturn);
    this.reverbReturn.connect(this.master);

    // sfx
    this.sfxIn = gain(1);
    this.sfxFilter = filt('lowpass', OPEN_FREQ);
    this.sfxDuck = gain(1);
    this.sfxVol = gain(1);
    this.sfxSend = gain(0.6);
    this.sfxIn.connect(this.sfxFilter);
    this.sfxFilter.connect(this.sfxDuck);
    this.sfxDuck.connect(this.sfxVol);
    this.sfxVol.connect(this.master);
    this.sfxVol.connect(this.sfxSend);
    this.sfxSend.connect(this.reverbHP);

    // ui
    this.uiIn = gain(1);
    this.uiVol = gain(1);
    this.uiIn.connect(this.uiVol);
    this.uiVol.connect(this.master);

    // announcer
    this.annIn = gain(1);
    this.annVol = gain(1);
    this.annSend = gain(0.5);
    this.annIn.connect(this.annVol);
    this.annVol.connect(this.master);
    this.annVol.connect(this.annSend);
    this.annSend.connect(this.reverbHP);

    // music
    this.musicIn = gain(1);
    this.musicPulse = filt('lowpass', OPEN_FREQ);
    this.musicFilter = filt('lowpass', OPEN_FREQ);
    this.musicDuck = gain(1);
    this.musicVol = gain(1);
    this.musicIn.connect(this.musicPulse);
    this.musicPulse.connect(this.musicFilter);
    this.musicFilter.connect(this.musicDuck);
    this.musicDuck.connect(this.musicVol);
    this.musicVol.connect(this.master);

    this._graph = true;
    this._applyVolumes(true);
  }

  resume() {
    const c = this.ctx;
    if (!c) return;
    this._lastResumeCall = nowMs();
    try {
      if (c.state !== 'running' && c.state !== 'closed') {
        const p = c.resume();
        if (p && p.catch) p.catch(() => {});
      }
    } catch (_) { /* ignore */ }
    if (this._ss && !this._voice) {
      try { this._voice = pickVoice(this._ss.getVoices()); } catch (_) { /* ignore */ }
    }
  }

  // ----- volumes / listener -----

  setVolumes(v = {}) {
    if (!v) return;
    for (const k of ['master', 'music', 'effects', 'announcer']) {
      if (v[k] != null && Number.isFinite(+v[k])) this._vol[k] = clamp(+v[k], 0, 1);
    }
    this._applyVolumes(false);
  }

  _applyVolumes(immediate) {
    if (!this._graph) return;
    const V = this._vol;
    const now = this.ctx.currentTime;
    const set = (p, val) => {
      if (immediate) p.value = val;
      else p.setTargetAtTime(val, now, 0.03);
    };
    set(this.master.gain, volCurve(V.master) * TRIM.master);
    set(this.sfxVol.gain, volCurve(V.effects) * TRIM.sfx);
    set(this.uiVol.gain, volCurve(V.effects) * TRIM.ui);
    set(this.musicVol.gain, volCurve(V.music) * TRIM.music);
    set(this.annVol.gain, volCurve(V.announcer) * TRIM.announcer);
  }

  setListener(position, forward, up) {
    if (!this.ctx || !finite3(position)) return;
    const L = this.ctx.listener;
    const f = finite3(forward) ? forward : { x: 0, y: 0, z: -1 };
    const u = finite3(up) ? up : { x: 0, y: 1, z: 0 };
    try {
      if (L.positionX) {
        L.positionX.value = position.x;
        L.positionY.value = position.y;
        L.positionZ.value = position.z;
        L.forwardX.value = f.x;
        L.forwardY.value = f.y;
        L.forwardZ.value = f.z;
        L.upX.value = u.x;
        L.upY.value = u.y;
        L.upZ.value = u.z;
      } else {
        L.setPosition(position.x, position.y, position.z);
        L.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
      }
    } catch (_) { /* ignore */ }
  }

  _makePanner(ambient = false) {
    const cfg = {
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      refDistance: ambient ? 2 : 2.5,
      rolloffFactor: ambient ? 1.4 : 1.15,
      maxDistance: ambient ? 60 : 90,
      coneInnerAngle: 360,
      coneOuterAngle: 360,
      coneOuterGain: 0,
    };
    let p;
    try {
      p = new PannerNode(this.ctx, cfg);
    } catch (_) {
      p = this.ctx.createPanner();
      Object.assign(p, cfg);
    }
    return p;
  }

  // ----- one-shots -----

  play(name, opts = {}) {
    try {
      return this._play(name, opts || {});
    } catch (e) {
      return null;
    }
  }

  _audible() {
    // While suspended (pre-gesture) one-shots would queue up and burst on resume; drop them,
    // except right after resume() was requested from a gesture.
    const st = this.ctx.state;
    return st === 'running' || nowMs() - this._lastResumeCall < 600;
  }

  _play(name, opts) {
    if (!this._ready) return null;
    const list = this._buffers.get(name);
    if (!list || !list.length) return null;
    const { position = null, volume = 1, pitch = 1, pitchVar = 0.04, bus = 'sfx', loop = false, delay = 0 } = opts;
    if (!loop && !this._audible()) return null;
    const c = this.ctx;
    const now = c.currentTime;
    const dest = bus === 'ui' ? this.uiIn : bus === 'announcer' ? this.annIn : this.sfxIn;
    this._enforceLimits(name);
    const src = c.createBufferSource();
    src.buffer = this._pickVariant(name, list);
    src.loop = !!loop;
    const pv = Number.isFinite(+pitchVar) ? +pitchVar : 0.04;
    const baseRate = clamp((+pitch || 1) * (1 + (Math.random() * 2 - 1) * pv), 0.05, 8);
    const voice = {
      name, src, gain: null, panner: null, bus, baseRate, loop: !!loop,
      noSlow: !!opts._noSlow || bus !== 'sfx', start: now + Math.max(0, +delay || 0), stopping: false, done: false,
    };
    src.playbackRate.value = baseRate * (!voice.noSlow && now < this._slowUntil ? this._slowRate : 1);
    const g = c.createGain();
    g.gain.value = Math.max(0, Number.isFinite(+volume) ? +volume : 1);
    voice.gain = g;
    src.connect(g);
    if (position && finite3(position)) {
      voice.panner = this._makePanner();
      setPannerPosition(voice.panner, position);
      g.connect(voice.panner);
      voice.panner.connect(dest);
    } else {
      g.connect(dest);
    }
    src.onended = () => this._cleanupVoice(voice);
    src.start(voice.start);
    this._voices.push(voice);
    if (!this._byName.has(name)) this._byName.set(name, []);
    this._byName.get(name).push(voice);
    if (!voice.noSlow && now < this._slowUntil) this._applyVoiceRate(voice, now);
    return this._makeHandle(voice);
  }

  _makeHandle(voice) {
    const eng = this;
    return {
      source: voice.src,
      stop(fadeSec = 0.05) {
        eng._stopVoice(voice, fadeSec);
      },
      setPosition(p) {
        if (voice.panner && !voice.done) setPannerPosition(voice.panner, p);
      },
      setPlaybackRate(r) {
        if (voice.done || !Number.isFinite(+r)) return;
        voice.baseRate = clamp(+r, 0.05, 8);
        try { eng._applyVoiceRate(voice, eng.ctx.currentTime); } catch (_) { /* ignore */ }
      },
    };
  }

  _pickVariant(name, list) {
    if (list.length === 1) return list[0];
    const last = this._lastVariant.get(name) ?? -1;
    let i = Math.floor(Math.random() * list.length);
    if (i === last) i = (i + 1 + Math.floor(Math.random() * (list.length - 1))) % list.length;
    this._lastVariant.set(name, i);
    return list[i];
  }

  _enforceLimits(name) {
    const limit = VOICE_LIMITS[name] ?? (name.startsWith('step_') ? STEP_LIMIT : DEFAULT_LIMIT);
    const same = (this._byName.get(name) || []).filter((v) => !v.stopping);
    for (let i = 0; i <= same.length - limit; i++) this._stopVoice(same[i], 0.03);
    const live = this._voices.filter((v) => !v.stopping);
    if (live.length >= MAX_VOICES) {
      const victim = live.find((v) => !v.loop) || live[0];
      this._stopVoice(victim, 0.03);
    }
  }

  /** Apply baseRate (and any active slow-mo, with a scheduled restore) to a voice. */
  _applyVoiceRate(voice, now) {
    const p = voice.src.playbackRate;
    holdParam(p, now);
    if (!voice.noSlow && now < this._slowUntil) {
      p.setTargetAtTime(voice.baseRate * this._slowRate, now, 0.04);
      p.setTargetAtTime(voice.baseRate, this._slowUntil, 0.12);
    } else {
      p.setTargetAtTime(voice.baseRate, now, 0.02);
    }
  }

  _stopVoice(voice, fade) {
    if (!voice || voice.done || voice.stopping) return;
    voice.stopping = true;
    const now = this.ctx.currentTime;
    const f = Math.max(0.005, +fade || 0);
    try {
      const g = voice.gain.gain;
      holdParam(g, now);
      g.linearRampToValueAtTime(0, now + f);
      voice.src.stop(now + f + 0.01);
    } catch (_) {
      this._cleanupVoice(voice);
    }
  }

  _cleanupVoice(voice) {
    if (voice.done) return;
    voice.done = true;
    voice.stopping = true;
    try { voice.src.disconnect(); } catch (_) { /* ignore */ }
    try { voice.gain.disconnect(); } catch (_) { /* ignore */ }
    if (voice.panner) {
      try { voice.panner.disconnect(); } catch (_) { /* ignore */ }
    }
    const i = this._voices.indexOf(voice);
    if (i >= 0) this._voices.splice(i, 1);
    const arr = this._byName.get(voice.name);
    if (arr) {
      const j = arr.indexOf(voice);
      if (j >= 0) arr.splice(j, 1);
    }
  }

  _musicBuf(name) {
    const list = this._buffers.get(name);
    if (!list || !list.length) return null;
    return list.length === 1 ? list[0] : list[Math.floor(Math.random() * list.length)];
  }

  // ----- heartbeat -----

  startHeartbeat() {
    if (!this._ready || this._hb) return;
    const h = this._play('heartbeat', { loop: true, volume: 0.95, pitchVar: 0, _noSlow: true });
    if (!h) return;
    this._hb = h;
    this._hbNext = this.ctx.currentTime;
  }

  stopHeartbeat() {
    if (this._hb) {
      this._hb.stop(0.35);
      this._hb = null;
    }
    if (this._graph) glideParam(this.musicPulse.frequency, OPEN_FREQ, this.ctx.currentTime, 0.2);
  }

  _scheduleHeartbeatPulses(now, until) {
    if (!this._hb) return;
    const p = this.musicPulse.frequency;
    if (this._hbNext < now) this._hbNext += Math.ceil((now - this._hbNext) / 0.5) * 0.5;
    while (this._hbNext < until) {
      const t = this._hbNext;
      p.setTargetAtTime(1100, t, 0.012);
      p.setTargetAtTime(5200, t + 0.07, 0.11);
      this._hbNext += 0.5;
    }
  }

  // ----- announcer -----

  _initSpeech() {
    try {
      const ss = typeof window !== 'undefined' ? window.speechSynthesis : null;
      if (!ss || typeof window.SpeechSynthesisUtterance !== 'function') return;
      this._ss = ss;
      const pick = () => {
        try { this._voice = pickVoice(ss.getVoices()); } catch (_) { /* ignore */ }
      };
      pick();
      if (ss.addEventListener) ss.addEventListener('voiceschanged', pick);
      else ss.onvoiceschanged = pick;
    } catch (_) {
      this._ss = null;
    }
  }

  announce(key) {
    try {
      const a = ANNOUNCER[key];
      if (!a) return;
      this._play(a.sting, { bus: 'announcer', volume: a.vol ?? 1, pitch: a.pitch ?? 1, pitchVar: 0 });
      if (!this._ss) return;
      if (a.now) {
        this._speechQueue.length = 0;
        try { this._ss.cancel(); } catch (_) { /* ignore */ }
        this._speakNow(a.say, a.rate ?? 1);
      } else {
        this._speechQueue.push({ text: a.say, rate: a.rate ?? 1, at: nowMs() });
        this._pumpSpeech(nowMs());
      }
    } catch (_) { /* never throw */ }
  }

  _speakNow(text, rate) {
    const ss = this._ss;
    if (!ss) return;
    const vol = clamp(this._vol.master * this._vol.announcer, 0, 1);
    if (vol <= 0.001) return;
    try {
      const u = new window.SpeechSynthesisUtterance(text);
      if (this._voice) {
        u.voice = this._voice;
        u.lang = this._voice.lang;
      } else {
        u.lang = 'en-US';
      }
      u.pitch = 0.55;
      u.rate = 0.95 * rate;
      u.volume = vol;
      const id = ++this._speechId;
      const done = () => {
        if (id !== this._speechId) return;
        this._speaking = false;
        this._lastSpeechEnd = nowMs();
      };
      u.onend = done;
      u.onerror = done;
      this._speaking = true;
      this._speechDeadline = nowMs() + 1500 + text.length * 110; // fallback if onend never fires
      if (ss.paused) ss.resume();
      ss.speak(u);
    } catch (_) {
      this._speaking = false;
    }
  }

  _pumpSpeech(t) {
    if (!this._ss) return;
    if (this._speaking && t > this._speechDeadline) {
      this._speaking = false;
      this._lastSpeechEnd = t;
    }
    const q = this._speechQueue;
    while (q.length && t - q[0].at > SPEECH_MAX_WAIT_MS) q.shift();
    if (this._speaking || !q.length || t - this._lastSpeechEnd < SPEECH_GAP_MS) return;
    const item = q.shift();
    this._speakNow(item.text, item.rate);
  }

  // ----- music -----

  startMusic(mode) {
    try {
      const m = mode === 'menu' || mode === 'match' ? mode : 'off';
      this._wantMusic = m;
      if (!this._ready || m === this._musicMode) return;
      this._musicMode = m;
      const fade = 1.5;
      if (this._track) {
        this._track.stop(fade);
        this._track = null;
      }
      if (m === 'off') return;
      const tr = m === 'menu' ? new MenuTrack(this) : new MatchTrack(this);
      tr.update(this._musicI, this._suddenDeath);
      tr.fadeIn(fade);
      this._track = tr;
      this._tracks.push(tr);
    } catch (e) {
      console.warn('[audio] music start failed', e);
    }
  }

  setMusicIntensity(x) {
    if (Number.isFinite(+x)) this._musicTarget = clamp(+x, 0, 1);
  }

  setSuddenDeath(on) {
    this._suddenDeath = !!on;
  }

  _tick() {
    if (!this._ready) return;
    try {
      const wall = nowMs();
      const dt = clamp((wall - this._lastWall) / 1000, 0, 2);
      this._lastWall = wall;
      const now = this.ctx.currentTime;
      const lookahead = clamp(dt * 1.5 + 0.1, 0.15, 1.2); // grows when the tab is throttled
      this._musicI += (this._musicTarget - this._musicI) * (1 - Math.exp(-dt / 0.7));
      for (const tr of this._tracks) {
        if (tr.stopped) continue;
        tr.update(this._musicI, this._suddenDeath);
        tr.schedule(now, now + lookahead);
      }
      this._scheduleHeartbeatPulses(now, now + lookahead);
      this._pumpSpeech(wall);
    } catch (e) { /* keep ticking */ }
  }

  // ----- ambient -----

  addAmbient(name, position, opts = {}) {
    const noop = { stop() {}, setVolume() {} };
    try {
      if (!this._ready) return noop;
      const list = this._buffers.get('amb_' + name);
      if (!list || !list.length) return noop;
      const c = this.ctx;
      const now = c.currentTime;
      const vol = () => Math.max(0, Number.isFinite(+entry.vol) ? +entry.vol : 1) * TRIM.ambient;
      const src = c.createBufferSource();
      src.buffer = list[0];
      src.loop = true;
      src.playbackRate.value = 1 + (Math.random() * 2 - 1) * 0.015; // de-phase identical emitters
      const g = c.createGain();
      const entry = { src, gain: g, panner: null, vol: (opts && opts.volume) ?? 1, done: false };
      g.gain.value = 0;
      g.gain.setValueAtTime(0, now);
      g.gain.linearRampToValueAtTime(vol(), now + 0.8);
      src.connect(g);
      if (finite3(position)) {
        entry.panner = this._makePanner(true);
        setPannerPosition(entry.panner, position);
        g.connect(entry.panner);
        entry.panner.connect(this.sfxIn);
      } else {
        g.connect(this.sfxIn);
      }
      src.start(now, Math.random() * src.buffer.duration * 0.95);
      const cleanup = () => {
        if (entry.done) return;
        entry.done = true;
        try { src.disconnect(); g.disconnect(); if (entry.panner) entry.panner.disconnect(); } catch (_) { /* ignore */ }
        this._ambient.delete(entry);
      };
      src.onended = cleanup;
      entry.stop = (fade = 0.4) => {
        if (entry.done || entry.stopping) return;
        entry.stopping = true;
        const t = c.currentTime;
        try {
          holdParam(g.gain, t);
          g.gain.linearRampToValueAtTime(0, t + Math.max(0.01, fade));
          src.stop(t + Math.max(0.01, fade) + 0.02);
        } catch (_) { cleanup(); }
      };
      this._ambient.add(entry);
      return {
        stop: (fade) => entry.stop(fade),
        setVolume: (v) => {
          if (entry.done || entry.stopping || !Number.isFinite(+v)) return;
          entry.vol = +v;
          glideParam(g.gain, vol(), c.currentTime, 0.1);
        },
      };
    } catch (e) {
      return noop;
    }
  }

  clearAmbient() {
    for (const e of [...this._ambient]) {
      try { e.stop(0.3); } catch (_) { /* ignore */ }
    }
  }

  // ----- global filters -----

  setSlowmo(factor = 0.35, duration = 0.3) {
    if (!this._graph) return;
    try {
      const now = this.ctx.currentTime;
      const f = clamp(Number.isFinite(+factor) ? +factor : 0.35, 0.05, 1);
      const dur = Math.max(0.05, Number.isFinite(+duration) ? +duration : 0.3);
      this._slowRate = clamp(0.55 + 0.45 * f, 0.5, 1);
      this._slowUntil = now + dur;
      const base = this._muffled ? MUFFLE_SFX : OPEN_FREQ;
      const sf = this.sfxFilter.frequency;
      holdParam(sf, now);
      sf.setTargetAtTime(Math.min(base, 600 + 3000 * f), now, 0.03);
      sf.setTargetAtTime(base, now + dur, 0.12);
      const d = this.musicDuck.gain;
      holdParam(d, now);
      d.setTargetAtTime(0.4 + 0.3 * f, now, 0.04);
      d.setTargetAtTime(1, now + dur, 0.2);
      for (const v of this._voices) {
        if (!v.noSlow && !v.stopping) this._applyVoiceRate(v, now);
      }
    } catch (_) { /* ignore */ }
  }

  setMuffled(on) {
    this._muffled = !!on;
    if (!this._graph) return;
    try {
      const now = this.ctx.currentTime;
      const tc = on ? 0.06 : 0.12;
      glideParam(this.sfxFilter.frequency, on ? MUFFLE_SFX : OPEN_FREQ, now, tc);
      glideParam(this.musicFilter.frequency, on ? MUFFLE_MUSIC : OPEN_FREQ, now, tc);
      glideParam(this.sfxDuck.gain, on ? 0.7 : 1, now, tc);
    } catch (_) { /* ignore */ }
  }
}

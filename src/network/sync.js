// Network sync primitives: compact binary player-state snapshots for the unreliable
// channel, a snapshot interpolation buffer for smooth remote players, clock offset
// estimation and packet sequencing / loss tracking.
import * as THREE from 'three';

export const PKT = { STATE: 1, PING: 2, PONG: 3 };

export const FLAG = {
  ground: 1, crouch: 2, slide: 4, sprint: 8, ads: 16, reload: 32, dead: 64, rush: 128, protect: 256, mantle: 512,
};

const STATE_SIZE = 52;

export function encodeState(s, seq, time, buf = new ArrayBuffer(STATE_SIZE)) {
  const v = new DataView(buf);
  v.setUint8(0, PKT.STATE);
  v.setUint8(1, s.life & 255);
  v.setUint16(2, seq & 0xffff, true);
  v.setFloat64(4, time, true);
  v.setFloat32(12, s.pos.x, true); v.setFloat32(16, s.pos.y, true); v.setFloat32(20, s.pos.z, true);
  v.setFloat32(24, s.vel.x, true); v.setFloat32(28, s.vel.y, true); v.setFloat32(32, s.vel.z, true);
  v.setFloat32(36, s.yaw, true); v.setFloat32(40, s.pitch, true);
  v.setFloat32(44, s.height, true);
  v.setUint16(48, s.flags & 0xffff, true);
  v.setUint8(50, s.weapon & 255);
  v.setUint8(51, s.anim & 255);
  return buf;
}

export function decodeState(buf) {
  const v = new DataView(buf);
  return {
    life: v.getUint8(1),
    seq: v.getUint16(2, true),
    time: v.getFloat64(4, true),
    pos: new THREE.Vector3(v.getFloat32(12, true), v.getFloat32(16, true), v.getFloat32(20, true)),
    vel: new THREE.Vector3(v.getFloat32(24, true), v.getFloat32(28, true), v.getFloat32(32, true)),
    yaw: v.getFloat32(36, true),
    pitch: v.getFloat32(40, true),
    height: v.getFloat32(44, true),
    flags: v.getUint16(48, true),
    weapon: v.getUint8(50),
    anim: v.getUint8(51),
  };
}

export function encodePing(type, a, b = 0) {
  const buf = new ArrayBuffer(17);
  const v = new DataView(buf);
  v.setUint8(0, type);
  v.setFloat64(1, a, true);
  v.setFloat64(9, b, true);
  return buf;
}

export function decodePing(buf) {
  const v = new DataView(buf);
  return { type: v.getUint8(0), a: v.getFloat64(1, true), b: v.getFloat64(9, true) };
}

function lerpAngle(a, b, t) {
  let d = b - a;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  return a + d * t;
}

/** 16-bit sequence comparison with wraparound. */
export function seqNewer(a, b) {
  return ((a - b) & 0xffff) < 0x8000 && a !== b;
}

/** Snapshot interpolation buffer (times are host-clock ms). */
export class SnapshotBuffer {
  constructor(max = 40) {
    this.max = max;
    this.snaps = [];
    this.out = {
      pos: new THREE.Vector3(), vel: new THREE.Vector3(), yaw: 0, pitch: 0, height: 1.8, flags: 0, weapon: 1, anim: 0, life: 0, valid: false, extrapolated: false,
    };
  }

  clear() { this.snaps.length = 0; this.out.valid = false; }

  push(s) {
    const a = this.snaps;
    if (a.length && s.time <= a[a.length - 1].time) {
      // out-of-order: insert sorted, drop duplicates
      if (a.some((x) => x.time === s.time)) return;
      let i = a.length - 1;
      while (i >= 0 && a[i].time > s.time) i--;
      a.splice(i + 1, 0, s);
    } else a.push(s);
    if (a.length > this.max) a.shift();
  }

  latest() { return this.snaps[this.snaps.length - 1] || null; }

  sample(t) {
    const a = this.snaps;
    const o = this.out;
    if (!a.length) { o.valid = false; return o; }
    o.valid = true;
    o.extrapolated = false;
    if (t <= a[0].time) return this._copy(a[0]);
    const last = a[a.length - 1];
    if (t >= last.time) {
      // Extrapolate briefly from the newest state, then hold.
      const dt = Math.min(0.1, (t - last.time) / 1000);
      this._copy(last);
      o.pos.addScaledVector(last.vel, dt);
      o.extrapolated = true;
      return o;
    }
    let i = a.length - 2;
    while (i > 0 && a[i].time > t) i--;
    const p = a[i], n = a[i + 1];
    const k = (t - p.time) / Math.max(1e-3, n.time - p.time);
    // Teleports (respawn / big jumps) snap instead of sliding across the map.
    if (p.life !== n.life || p.pos.distanceToSquared(n.pos) > 36) return this._copy(k < 0.5 ? p : n);
    o.pos.lerpVectors(p.pos, n.pos, k);
    o.vel.lerpVectors(p.vel, n.vel, k);
    o.yaw = lerpAngle(p.yaw, n.yaw, k);
    o.pitch = p.pitch + (n.pitch - p.pitch) * k;
    o.height = p.height + (n.height - p.height) * k;
    o.flags = n.flags;
    o.weapon = n.weapon;
    o.anim = n.anim;
    o.life = n.life;
    return o;
  }

  _copy(s) {
    const o = this.out;
    o.pos.copy(s.pos); o.vel.copy(s.vel); o.yaw = s.yaw; o.pitch = s.pitch; o.height = s.height;
    o.flags = s.flags; o.weapon = s.weapon; o.anim = s.anim; o.life = s.life;
    return o;
  }
}

/** Estimates (remoteClock - localClock) from ping/pong samples, preferring low-RTT samples. */
export class ClockSync {
  constructor() {
    this.samples = [];
    this.offset = 0;
    this.rtt = 0;
    this.jitter = 0;
    this.has = false;
  }

  addSample(t0, remoteTime, t1) {
    const rtt = t1 - t0;
    if (rtt < 0 || rtt > 5000) return;
    const offset = remoteTime + rtt / 2 - t1;
    this.samples.push({ rtt, offset });
    if (this.samples.length > 12) this.samples.shift();
    const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
    const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 3)));
    const target = best.reduce((s, x) => s + x.offset, 0) / best.length;
    this.offset = this.has ? this.offset + (target - this.offset) * 0.3 : target;
    const prev = this.rtt;
    this.rtt = this.has ? this.rtt * 0.7 + rtt * 0.3 : rtt;
    this.jitter = this.jitter * 0.8 + Math.abs(rtt - prev) * 0.2;
    this.has = true;
  }
}

/** Tracks packet loss from sequence gaps over a sliding window. */
export class LossTracker {
  constructor() { this.reset(); }

  reset() {
    this.last = -1;
    this.received = 0;
    this.expected = 0;
    this.loss = 0;
    this.window = [];
  }

  /** Returns false if the packet is stale/duplicate. */
  accept(seq) {
    if (this.last < 0) { this.last = seq; this.received++; this.expected++; return true; }
    if (!seqNewer(seq, this.last)) return false;
    const gap = (seq - this.last) & 0xffff;
    this.expected += gap;
    this.received += 1;
    this.last = seq;
    if (this.expected > 120) {
      this.window.push(1 - this.received / this.expected);
      if (this.window.length > 5) this.window.shift();
      this.loss = Math.max(0, this.window.reduce((a, b) => a + b, 0) / this.window.length);
      this.received = 0;
      this.expected = 0;
    }
    return true;
  }
}

/** Packets-per-second counter. */
export class RateCounter {
  constructor() { this.count = 0; this.rate = 0; this.t = performance.now(); }
  tick() { this.count++; }
  update() {
    const now = performance.now();
    if (now - this.t >= 1000) {
      this.rate = (this.count * 1000) / (now - this.t);
      this.count = 0;
      this.t = now;
    }
    return this.rate;
  }
}

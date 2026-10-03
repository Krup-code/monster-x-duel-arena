// Weapon handling: firing cadence, magazines, reloads (incl. shell-by-shell), switching,
// ADS, bloom/spread and recoil. Spread directions come from a seeded RNG so the host can
// reproduce exactly the pellets a client fired. ShotValidator is the host-side check.
import * as THREE from 'three';
import { WEAPONS, getWeapon } from './weapons/index.js';

export { WEAPONS, getWeapon };

export const SLOT_OF = (id) => getWeapon(id).slot;
export const MELEE = { damage: 55, range: 2.4, cooldown: 0.85, duration: 0.5 };

export function mulberry(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const _r = new THREE.Vector3();
const _u = new THREE.Vector3();
const WORLD_UP = new THREE.Vector3(0, 1, 0);

/** Deterministic pellet directions for a shot. */
export function spreadDirections(dir, seed, spreadDeg, pellets, out = []) {
  out.length = 0;
  const rnd = mulberry(seed);
  _r.crossVectors(dir, WORLD_UP);
  if (_r.lengthSq() < 1e-6) _r.set(1, 0, 0);
  _r.normalize();
  _u.crossVectors(_r, dir).normalize();
  const sr = THREE.MathUtils.degToRad(spreadDeg);
  for (let i = 0; i < pellets; i++) {
    let r, a;
    if (pellets > 1) {
      // Shotgun: one center pellet, the rest in two rings, with jitter -> consistent patterns.
      if (i === 0) { r = 0.08; a = rnd() * Math.PI * 2; }
      else {
        const ring = i <= 4 ? 0.5 : 1.0;
        const k = i <= 4 ? (i - 1) / 4 : (i - 5) / (pellets - 5);
        a = k * Math.PI * 2 + (i <= 4 ? 0.4 : 0) + (rnd() - 0.5) * 0.5;
        r = ring * (0.85 + rnd() * 0.3);
      }
      r *= sr;
    } else {
      // Single bullet: center-weighted
      r = sr * Math.sqrt(rnd()) * (0.6 + 0.4 * rnd());
      a = rnd() * Math.PI * 2;
    }
    const t = Math.tan(r);
    const d = new THREE.Vector3().copy(dir).addScaledVector(_r, Math.cos(a) * t).addScaledVector(_u, Math.sin(a) * t).normalize();
    out.push(d);
  }
  return out;
}

export function damageFalloff(def, dist) {
  const f = def.falloff;
  if (!f) return 1;
  if (dist <= f.start) return 1;
  if (dist >= f.end) return f.min;
  return 1 - (1 - f.min) * ((dist - f.start) / (f.end - f.start));
}

export const STARTING = { primary: 'razor', secondary: 'pistol', special: null };

export class WeaponController {
  constructor() {
    this.events = [];
    this.reset();
  }

  reset(loadout = STARTING) {
    this.inventory = { primary: loadout.primary, secondary: loadout.secondary, special: loadout.special };
    this.ammo = {};
    for (const id of Object.values(this.inventory)) if (id) this._fill(id);
    this.current = this.inventory.primary || this.inventory.secondary;
    this.prevWeapon = this.inventory.secondary;
    this.state = 'raising';
    this.stateT = 0.25;
    this.cooldown = 0;
    this.bloom = 0;
    this.ads = 0;
    this.adsHeld = false;
    this.reloadQueued = false;
    this.meleeCooldown = 0;
    this.meleeT = 0;
    this.pumpT = 0;
    this.fireBuffer = 0;
    this.shotsFired = 0;
    this.recoilPitch = 0; // degrees, consumed by the camera
    this.recoilYaw = 0;
    this.kick = 0; // viewmodel kick impulse
    this.events.length = 0;
    this.infiniteAmmo = false;
  }

  _fill(id) {
    const d = getWeapon(id);
    this.ammo[id] = { mag: d.mag, reserve: d.reserve };
  }

  get def() { return getWeapon(this.current); }

  has(id) { return Object.values(this.inventory).includes(id); }

  /** Returns 'new' | 'ammo' | 'swap' | 'full' describing what picking up `id` would do. */
  pickupAction(id) {
    const slot = SLOT_OF(id);
    const cur = this.inventory[slot];
    if (cur === id) {
      const a = this.ammo[id], d = getWeapon(id);
      if (a.reserve >= d.reserve && a.mag >= d.mag) return 'full';
      return 'ammo';
    }
    if (!cur) return 'new';
    return 'swap';
  }

  give(id, autoSwitch = true) {
    const slot = SLOT_OF(id);
    const cur = this.inventory[slot];
    if (cur === id) {
      const d = getWeapon(id);
      const a = this.ammo[id];
      a.reserve = d.reserve;
      return 'ammo';
    }
    if (cur) delete this.ammo[cur];
    this.inventory[slot] = id;
    this._fill(id);
    if (autoSwitch || this.current === cur) this._beginSwitch(id);
    return cur ? 'swap' : 'new';
  }

  _beginSwitch(id) {
    if (!id || (id === this.current && this.state !== 'reloading')) return;
    this.prevWeapon = this.current;
    this.current = id;
    this.state = 'raising';
    this.stateT = getWeapon(id).switchTime;
    this.reloadQueued = false;
    this.pumpT = 0;
    this.events.push({ type: 'switch', weapon: id });
  }

  slotWeapon(n) {
    return n === 1 ? this.inventory.primary : n === 2 ? this.inventory.secondary : this.inventory.special;
  }

  cycle(dir) {
    const order = [this.inventory.primary, this.inventory.secondary, this.inventory.special].filter(Boolean);
    if (order.length < 2) return;
    const i = order.indexOf(this.current);
    this._beginSwitch(order[(i + dir + order.length) % order.length]);
  }

  /** Effective spread in degrees given movement context. */
  spread(ctx) {
    const d = this.def;
    const s = d.spread;
    const speed = Math.min(1.4, (ctx.speed || 0) / 7);
    const base = THREE.MathUtils.lerp(s.base, s.ads, this.ads);
    let v = base + s.move * speed * (1 - this.ads * 0.5) + (ctx.onGround ? 0 : s.air) + this.bloom;
    if (ctx.crouching && ctx.onGround && !ctx.sliding) v *= 0.8;
    return Math.min(v, Math.max(s.max, base));
  }

  /**
   * Advance weapon state. inp = { fire, firePressed, ads, reload, slot, next, prev, melee }
   * ctx = { speed, onGround, sprinting, sliding, crouching, reloadMul, canFire }
   * Returns this.events (cleared at the start of each call).
   */
  update(dt, inp, ctx) {
    this.events.length = 0;
    const d = this.def;
    const a = this.ammo[this.current];
    this.cooldown = Math.max(-0.02, this.cooldown - dt);
    this.meleeCooldown -= dt;
    this.fireBuffer -= dt;
    this.bloom = Math.max(0, this.bloom - d.spread.recover * dt * (this.bloom > 0 ? 1 : 0));
    this.kick = Math.max(0, this.kick - dt * 8);
    const reloadMul = ctx.reloadMul || 1;

    // ADS blend
    const canAds = inp.ads && this.state !== 'reloading' && this.state !== 'raising' && this.state !== 'melee' && !ctx.sprinting;
    this.adsHeld = !!inp.ads;
    this.ads = THREE.MathUtils.clamp(this.ads + (canAds ? 1 : -1) * dt / d.adsTime, 0, 1);

    // weapon switching
    if (inp.slot) {
      const id = this.slotWeapon(inp.slot);
      if (id && id !== this.current) this._beginSwitch(id);
    } else if (inp.next) this.cycle(1);
    else if (inp.prev) this.cycle(-1);

    // melee
    if (inp.melee && this.meleeCooldown <= 0 && this.state !== 'melee') {
      this.meleePrevState = this.state === 'reloading' ? 'ready' : this.state;
      this.state = 'melee';
      this.stateT = MELEE.duration;
      this.meleeCooldown = MELEE.cooldown;
      this.reloadQueued = false;
      this.events.push({ type: 'melee' });
    }

    // state timers
    if (this.state === 'raising' || this.state === 'melee') {
      this.stateT -= dt;
      if (this.stateT <= 0) { this.state = 'ready'; if (this.ammo[this.current]?.mag === 0) this.reloadQueued = true; }
    } else if (this.state === 'reloading') {
      this.stateT -= dt * reloadMul;
      if (d.shellReload) {
        if (this.stateT <= 0) {
          if (a.mag < d.mag && (a.reserve > 0 || this.infiniteAmmo)) {
            a.mag++;
            if (!this.infiniteAmmo && a.reserve !== Infinity) a.reserve--;
            this.events.push({ type: 'shell' });
          }
          if (a.mag >= d.mag || (a.reserve <= 0 && !this.infiniteAmmo)) {
            this.state = 'ready';
            this.pumpT = 0.35;
            this.events.push({ type: 'reloadEnd', pump: true });
          } else this.stateT += d.reloadTime;
        }
      } else if (this.stateT <= 0) {
        const need = d.mag - a.mag;
        const take = this.infiniteAmmo || a.reserve === Infinity ? need : Math.min(need, a.reserve);
        a.mag += take;
        if (!this.infiniteAmmo && a.reserve !== Infinity) a.reserve -= take;
        this.state = 'ready';
        this.events.push({ type: 'reloadEnd' });
      }
    }
    if (this.pumpT > 0) this.pumpT -= dt;

    // reload request
    if ((inp.reload || this.reloadQueued) && this.state === 'ready' && a.mag < d.mag && (a.reserve > 0 || this.infiniteAmmo)) {
      this.reloadQueued = false;
      this.state = 'reloading';
      this.stateT = d.shellReload ? d.reloadTime * 1.2 : d.reloadTime;
      this.events.push({ type: 'reloadStart', weapon: this.current, duration: d.reloadTime / reloadMul, shell: !!d.shellReload });
    }

    // firing
    if (inp.firePressed) this.fireBuffer = 0.12;
    // A press always counts, even if the button was released before this frame (fast clicks).
    const wants = d.auto ? inp.fire || inp.firePressed : this.fireBuffer > 0;
    const shellInterrupt = this.state === 'reloading' && d.shellReload && a.mag > 0;
    if (wants && ctx.canFire !== false && (this.state === 'ready' || shellInterrupt) && this.cooldown <= 0 && this.pumpT <= 0) {
      if (a.mag <= 0) {
        if (inp.firePressed) this.events.push({ type: 'dry' });
        this.fireBuffer = 0;
        if (a.reserve > 0 || this.infiniteAmmo) this.reloadQueued = true;
      } else {
        if (shellInterrupt) this.state = 'ready';
        a.mag--;
        if (this.infiniteAmmo && a.mag === 0) { /* refill on reload */ }
        const spread = this.spread(ctx);
        this.cooldown = Math.max(0, this.cooldown) + d.fireInterval;
        this.fireBuffer = 0;
        this.bloom = Math.min(d.spread.max, this.bloom + d.spread.perShot);
        const r = d.recoil;
        const adsK = 1 - this.ads * 0.35;
        this.recoilPitch += r.pitch * (0.85 + Math.random() * 0.3) * adsK;
        this.recoilYaw += (Math.random() - 0.5) * 2 * r.yaw * adsK;
        this.kick = Math.min(1.5, this.kick + r.kick * 0.6);
        this.shotsFired++;
        const seed = (Math.random() * 0xffffffff) >>> 0;
        this.events.push({ type: 'fire', weapon: this.current, seed, spread, pellets: d.pellets });
        if (d.id === 'crush') this.pumpT = 0;
        if (a.mag === 0 && (a.reserve > 0 || this.infiniteAmmo)) this.reloadQueued = true;
      }
    }
    return this.events;
  }

  /** 0..1 progress of the current reload or the rail recharge. */
  get railCharge() {
    if (this.current !== 'rail') return 1;
    return 1 - Math.max(0, this.cooldown) / this.def.fireInterval;
  }
}

/**
 * Host-side validation of a remote player's weapon use. Not an anti-cheat fortress,
 * just enough to reject impossible fire rates and ammo counts in a friendly duel.
 */
export class ShotValidator {
  constructor() { this.reset(STARTING); }

  reset(loadout) {
    this.state = {};
    for (const id of Object.values(loadout)) if (id) this._init(id);
  }

  _init(id) {
    const d = getWeapon(id);
    this.state[id] = { tokens: 2, last: 0, mag: d.mag, reserve: d.reserve };
  }

  give(id, replaced) {
    if (replaced && this.state[replaced]) delete this.state[replaced];
    if (!this.state[id]) this._init(id);
    else this.state[id].reserve = getWeapon(id).reserve;
  }

  /** now in seconds (host clock). Returns '' if ok, or a reason string. */
  check(id, now, owned) {
    if (!owned) return 'not-owned';
    const s = this.state[id] || (this._init(id), this.state[id]);
    const d = getWeapon(id);
    // token bucket refilled at the weapon's legal fire rate (with 15% jitter tolerance)
    const rate = 1 / (d.fireInterval * 0.85);
    s.tokens = Math.min(2, s.tokens + (now - s.last) * rate);
    s.last = now;
    if (s.tokens < 1) return 'rate';
    if (s.mag <= -1) return 'ammo';
    s.tokens -= 1;
    s.mag -= 1;
    return '';
  }

  reload(id) {
    const s = this.state[id];
    if (!s) return;
    const d = getWeapon(id);
    const need = d.mag - Math.max(0, s.mag);
    const take = s.reserve === Infinity ? need : Math.min(need, s.reserve);
    s.mag = Math.max(0, s.mag) + take;
    if (s.reserve !== Infinity) s.reserve -= take;
  }

  shell(id) {
    const s = this.state[id];
    if (!s) return;
    if (s.reserve > 0) { s.mag = Math.max(0, s.mag) + 1; if (s.reserve !== Infinity) s.reserve--; }
  }
}

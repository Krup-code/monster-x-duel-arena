// Match rules. HostAuthority runs only on the host (or offline vs a bot / in training) and
// is the single source of truth for health, armor, energy, damage, kills, respawns,
// pickups, projectiles, destructibles, the match timer and victory. It never touches
// rendering: it emits compact events that the local game applies AND that are sent to the
// guest over the reliable channel, so both machines run the exact same event handlers.
import * as THREE from 'three';
import { MATCH, PLAYER, ENERGY, NET } from './config.js';
import { getWeapon, spreadDirections, damageFalloff, ShotValidator, STARTING, MELEE, SLOT_OF, CROUCH_SPREAD_MUL } from './weapons.js';
import { rayPlayer, distToPlayer } from './physics.js';
import { PICKUP_KINDS, pickupRespawn } from './pickups.js';

const _v = new THREE.Vector3();
const _p = new THREE.Vector3();
const _d = new THREE.Vector3();
const _o = new THREE.Vector3();
/** [x, y, z] of finite numbers (network input). */
const vec3ok = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const r3 = (v) => [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100, Math.round(v.z * 100) / 100];

export function newPlayerState(id, name) {
  return {
    id, name, alive: false, health: PLAYER.maxHealth, armor: 0, energy: 0, rushUntil: 0, protectUntil: 0, life: 0,
    kills: 0, deaths: 0, damage: 0, shots: 0, hits: 0, headshots: 0, longestKill: 0, rushes: 0, streak: 0,
    lastKiller: -1, respawnAt: 0, inventory: { ...STARTING }, hpFrac: 0, trickBudget: ENERGY.trickBudgetPer5s, ping: 0,
  };
}

export function statsOf(s) {
  return {
    name: s.name, kills: s.kills, deaths: s.deaths, damage: Math.round(s.damage), shots: s.shots, hits: s.hits,
    headshots: s.headshots, longestKill: Math.round(s.longestKill), rushes: s.rushes,
    accuracy: s.shots ? Math.round((s.hits / s.shots) * 100) : 0,
  };
}

export class HostAuthority {
  /**
   * opts: { arena, mode: 'duel'|'bot'|'training', now: () => seconds, emit: (evt) => void,
   *         avatars: [avatar0, avatar1?], names: [..] }
   * avatar: { kind, getPos(), getHeight(), getVel(), transformAt(t, outPos) -> height, weaponAction(id) }
   */
  constructor(opts) {
    this.arena = opts.arena;
    this.world = opts.arena.world;
    this.mode = opts.mode;
    this.now = opts.now;
    this.emitFn = opts.emit;
    this.avatars = opts.avatars;
    this.ps = opts.names.map((n, i) => newPlayerState(i, n));
    this.validators = this.ps.map(() => new ShotValidator());
    this.phase = 'idle';
    this.rockets = [];
    this.rocketId = 1;
    this.pickups = this.arena.pickups.map((p) => ({ id: p.id, avail: true, respawnAt: 0 }));
    this.barrelState = this.arena.barrels.map((b) => ({ id: b.id, hp: 30, alive: true, respawnAt: 0, lastHit: -1 }));
    this.firstBlood = false;
    this.syncTimer = 0;
    this.statsTimer = 0;
    this.paused = false;
    this.pausedAt = 0;
    this.winner = -1;
    this.seed = (Math.random() * 1e9) | 0;
    this.trainingTargets = this.arena.targets || [];
  }

  emit(e) { this.emitFn(e); }
  isLive() { return this.phase === 'playing' || this.phase === 'suddendeath' || this.phase === 'training'; }

  // ------------------------------------------------------------ lifecycle
  start({ rematch = false } = {}) {
    const now = this.now();
    this.arena.resetProps();
    for (const p of this.pickups) { p.avail = true; p.respawnAt = 0; }
    for (const b of this.barrelState) { b.hp = 30; b.alive = true; }
    this.rockets.length = 0;
    this.firstBlood = false;
    this.winner = -1;
    this.ps.forEach((s, i) => {
      const fresh = newPlayerState(i, s.name);
      Object.assign(s, fresh);
      this.validators[i].reset(STARTING);
    });
    if (this.mode === 'training') {
      this.phase = 'training';
      this.introAt = now; this.countdownAt = now; this.fightAt = now; this.endAt = Infinity;
    } else {
      this.phase = 'intro';
      const intro = rematch ? 2.4 : MATCH.introDuration;
      this.introAt = now;
      this.countdownAt = now + intro;
      this.fightAt = this.countdownAt + MATCH.countdown;
      this.endAt = this.fightAt + MATCH.timeLimit;
    }
    const spawns = this.ps.map((s, i) => {
      const sp = this.arena.initialSpawns[i] || this.arena.spawns[i];
      return { pos: sp.pos.clone(), yaw: sp.yaw };
    });
    this.emit({
      t: 'start', mode: this.mode, map: this.arena.id, seed: this.seed, introAt: this.introAt, countdownAt: this.countdownAt,
      fightAt: this.fightAt, endAt: this.endAt, rematch, names: this.ps.map((s) => s.name), phase: this.phase,
    });
    this.ps.forEach((s, i) => { if (i < this.avatars.length && this.avatars[i]) this._spawn(i, spawns[i], 0); });
    this._sync(true);
  }

  pause(on) {
    if (on === this.paused) return;
    const now = this.now();
    if (on) { this.paused = true; this.pausedAt = now; return; }
    this.paused = false;
    const dt = now - this.pausedAt;
    // Shift every timestamp so the clock effectively stopped while disconnected.
    for (const k of ['introAt', 'countdownAt', 'fightAt', 'endAt']) if (Number.isFinite(this[k])) this[k] += dt;
    for (const s of this.ps) { s.respawnAt += dt; if (s.rushUntil) s.rushUntil += dt; if (s.protectUntil) s.protectUntil += dt; }
    for (const p of this.pickups) if (!p.avail) p.respawnAt += dt;
    for (const b of this.barrelState) if (!b.alive) b.respawnAt += dt;
    for (const r of this.rockets) r.born += dt;
    this.emit({ t: 'phase', phase: this.phase, fightAt: this.fightAt, endAt: this.endAt, countdownAt: this.countdownAt });
    this._sync(true);
  }

  // ------------------------------------------------------------ per tick
  update(dt) {
    if (this.paused || this.phase === 'idle') return;
    const now = this.now();
    // Phase transitions
    if (this.phase === 'intro' && now >= this.countdownAt) {
      this.phase = 'countdown';
      this.emit({ t: 'phase', phase: 'countdown', fightAt: this.fightAt, endAt: this.endAt, countdownAt: this.countdownAt });
    }
    if (this.phase === 'countdown' && now >= this.fightAt) {
      this.phase = 'playing';
      this.emit({ t: 'phase', phase: 'playing', fightAt: this.fightAt, endAt: this.endAt });
    }
    if (this.phase === 'playing' && now >= this.endAt) {
      const [a, b] = this.ps;
      if (a.kills !== b.kills) this.end(a.kills > b.kills ? 0 : 1, 'time');
      else {
        this.phase = 'suddendeath';
        this.emit({ t: 'phase', phase: 'suddendeath', fightAt: this.fightAt, endAt: this.endAt });
      }
    }
    if (this.phase === 'ended') return;

    const live = this.isLive();
    for (const s of this.ps) {
      const i = s.id;
      if (!this.avatars[i]) continue;
      // respawns
      if (!s.alive && s.respawnAt > 0 && now >= s.respawnAt && (live || this.phase === 'countdown')) this._spawn(i, this._chooseSpawn(i), 1);
      if (!s.alive) continue;
      // fell out of the world
      const pos = this.avatars[i].getPos();
      if (pos.y < (this.arena.killY ?? -20)) this._kill(i, -1, { w: 'world', hs: false, dist: 0 });
      // mega health decay
      if (s.health > PLAYER.maxHealth) {
        s.hpFrac += PLAYER.megaDecay * dt;
        if (s.hpFrac >= 1) { const k = Math.floor(s.hpFrac); s.hpFrac -= k; s.health = Math.max(PLAYER.maxHealth, s.health - k); }
      }
      // rush expiry
      if (s.rushUntil && now >= s.rushUntil) { s.rushUntil = 0; this.emit({ t: 'rushEnd', p: i }); }
      // trick budget refill
      s.trickBudget = Math.min(ENERGY.trickBudgetPer5s, s.trickBudget + (ENERGY.trickBudgetPer5s / 5) * dt);
      if (live) this._checkPickups(i, pos);
    }
    // pickup respawns
    for (const p of this.pickups) {
      if (!p.avail && now >= p.respawnAt) {
        p.avail = true;
        this.emit({ t: 'pickup', id: p.id, avail: true });
      }
    }
    // barrels
    for (const b of this.barrelState) {
      if (!b.alive && now >= b.respawnAt) {
        const bp = this.arena.barrels[b.id].pos;
        const blocked = this.ps.some((s) => s.alive && this.avatars[s.id] && this.avatars[s.id].getPos().distanceTo(bp) < 2.2);
        if (!blocked) { b.alive = true; b.hp = 30; this.emit({ t: 'barrel', id: b.id, alive: true }); }
        else b.respawnAt = now + 3;
      }
    }
    this._updateRockets(dt, now);
    // training dummies respawn
    for (const tg of this.trainingTargets) {
      if (!tg.alive && now >= tg.respawnAt) { tg.alive = true; tg.health = tg.maxHealth; this.emit({ t: 'target', id: tg.id, alive: true, hp: tg.health }); }
    }
    this.syncTimer -= dt;
    if (this.syncTimer <= 0) { this.syncTimer = 0.5; this._sync(false); }
  }

  _sync(full) {
    const now = this.now();
    this.statsTimer--;
    const withStats = full || this.statsTimer <= 0;
    if (withStats) this.statsTimer = 2;
    this.emit({
      t: 'sync', phase: this.phase, fightAt: this.fightAt, endAt: this.endAt, countdownAt: this.countdownAt, now,
      ps: this.ps.map((s) => [Math.ceil(s.health), Math.ceil(s.armor), Math.floor(s.energy), s.alive ? 1 : 0, s.kills, s.deaths,
        s.protectUntil > now ? 1 : 0, s.rushUntil, s.life]),
      st: withStats ? this.ps.map((s) => [s.shots, s.hits, Math.round(s.damage), s.headshots, s.rushes, Math.round(s.longestKill)]) : undefined,
      pk: full ? this.pickups.map((p) => (p.avail ? 1 : 0)) : undefined,
      inv: full ? this.ps.map((s) => s.inventory) : undefined,
      props: full ? { glass: this.arena.glass.filter((g) => g.broken).map((g) => g.id), barrels: this.barrelState.filter((b) => !b.alive).map((b) => b.id), lamps: this.arena.lamps.filter((l) => l.broken).map((l) => l.id) } : undefined,
    });
  }

  /** Full state for a (re)connecting guest. */
  resync() {
    if (this.phase === 'ended' && this.lastEnd) {
      // Finished match: a (re)joining client only needs the result.
      this._sync(true);
      this.emit(this.lastEnd);
      return;
    }
    this.emit({
      t: 'start', mode: this.mode, map: this.arena.id, seed: this.seed, introAt: this.introAt, countdownAt: this.countdownAt,
      fightAt: this.fightAt, endAt: this.endAt, rematch: true, names: this.ps.map((s) => s.name), phase: this.phase, resume: true,
    });
    this._sync(true);
    for (const s of this.ps) {
      if (s.alive && this.avatars[s.id]) {
        const p = this.avatars[s.id].getPos();
        this.emit({ t: 'spawn', p: s.id, pos: r3(p), yaw: 0, life: s.life, protect: 0, inv: s.inventory, resume: true });
      }
    }
  }

  // ------------------------------------------------------------ spawning
  _chooseSpawn(i) {
    const enemy = this.ps.find((s) => s.id !== i && s.alive && this.avatars[s.id]);
    const spawns = this.arena.spawns;
    if (!enemy) return spawns[(Math.random() * spawns.length) | 0];
    const ep = this.avatars[enemy.id].getPos();
    const eyeE = _v.set(ep.x, ep.y + 1.6, ep.z);
    const scored = spawns.map((sp) => {
      const d = sp.pos.distanceTo(ep);
      const head = _p.set(sp.pos.x, sp.pos.y + 1.6, sp.pos.z);
      const visible = this.world.lineOfSight(eyeE, head);
      return { sp, score: d - (visible ? 40 : 0) - (d < 12 ? 30 : 0) + Math.random() * 6 };
    }).sort((a, b) => b.score - a.score);
    const pick = scored[Math.floor(Math.random() * Math.min(3, scored.length))];
    return pick.sp;
  }

  _spawn(i, sp, protect = 1) {
    const s = this.ps[i];
    const now = this.now();
    s.alive = true;
    s.health = PLAYER.maxHealth;
    s.armor = 0;
    s.hpFrac = 0;
    s.rushUntil = 0;
    s.inventory = { ...STARTING };
    s.protectUntil = protect ? now + MATCH.spawnProtection : 0;
    s.respawnAt = 0;
    s.life = (s.life + 1) & 255;
    this.validators[i].reset(STARTING);
    const yaw = sp.yaw ?? 0;
    this.emit({ t: 'spawn', p: i, pos: r3(sp.pos), yaw, life: s.life, protect: protect ? MATCH.spawnProtection : 0, inv: s.inventory, hp: s.health });
  }

  // ------------------------------------------------------------ combat
  _otherAlive(i) {
    return this.ps.filter((s) => s.id !== i && s.alive && this.avatars[s.id]);
  }

  _endProtection(i) {
    const s = this.ps[i];
    if (s.protectUntil > this.now()) {
      s.protectUntil = 0;
      this.emit({ t: 'protect', p: i, on: false });
    }
  }

  handleFire(i, f, remote = false) {
    const s = this.ps[i];
    if (!s.alive || !this.isLive() || this.paused) return false;
    const def = getWeapon(f.w);
    if (!def || !vec3ok(f.o) || !vec3ok(f.d)) return false;
    const now = this.now();
    const owned = Object.values(s.inventory).includes(f.w);
    if (remote) {
      // origin must be near the shooter's reported eye (written so NaN fails closed)
      const ap = this.avatars[i].getPos();
      _o.set(f.o[0], f.o[1], f.o[2]);
      if (!(_o.distanceTo(_v.set(ap.x, ap.y + 1.2, ap.z)) <= 3.5)) { console.warn('[host] rejected shot origin'); return false; }
      const why = this.validators[i].check(f.w, now, owned, f.ct);
      if (why) { console.warn('[host] rejected shot', why, f.w); return false; }
      // The tightest spread a client can produce is crouched + fully aimed.
      const floor = def.spread.ads * CROUCH_SPREAD_MUL;
      if (!(f.sp >= floor * 0.95 - 1e-3)) f.sp = floor;
    } else if (!owned) return false;
    s.shots++;
    this._endProtection(i);
    _o.set(f.o[0], f.o[1], f.o[2]);
    _d.set(f.d[0], f.d[1], f.d[2]).normalize();
    if (def.type === 'projectile') {
      this._spawnRocket(i, _o, _d, f.sid, def);
      return true;
    }
    const dirs = spreadDirections(_d, f.seed >>> 0, f.sp, def.pellets);
    const vt = Math.min(now, Math.max(now - NET.maxRewind / 1000, f.vt ?? now));
    const targets = this._otherAlive(i).map((t) => {
      const pos = new THREE.Vector3();
      const h = this.avatars[t.id].transformAt(vt, pos);
      return { s: t, pos, h, prot: t.protectUntil > now };
    });
    const ends = [];
    let total = 0, head = false, pelletsHit = 0, victim = null, tgHit = null, tgDmg = 0, tgHead = false;
    for (const dir of dirs) {
      const w = this.world.raycast(_o, dir, def.range, { collect: true });
      const worldT = w?.collider ? w.t : def.range;
      let bestT = worldT, who = null, isHead = false, tgt = null;
      for (const t of targets) {
        const r = rayPlayer(_o, dir, t.pos, t.h, bestT);
        if (r && r.t < bestT) { bestT = r.t; who = t; isHead = r.head; tgt = null; }
      }
      for (const tg of this.trainingTargets) {
        if (!tg.alive) continue;
        const r = rayPlayer(_o, dir, tg.pos, tg.height, bestT);
        if (r && r.t < bestT) { bestT = r.t; who = null; tgt = tg; isHead = r.head; }
      }
      if (w?.passed) for (const g of w.passed) if (g.t < bestT) this._breakGlass(g.collider.glassId);
      const pt = _p.copy(dir).multiplyScalar(bestT).add(_o);
      if (who || tgt) {
        let dmg = def.damage * (isHead ? def.headMul : 1) * damageFalloff(def, bestT);
        // A headshot with a headDamage weapon (ENERGY RAIL) is lethal whatever the buffers.
        if (isHead && def.headDamage) dmg = who ? Math.max(def.headDamage, who.s.health + who.s.armor) : def.headDamage;
        if (who) { victim = who; total += dmg; head ||= isHead; pelletsHit++; }
        else { tgHit = tgt; tgDmg += dmg; tgHead ||= isHead; pelletsHit++; }
        ends.push([...r3(pt), isHead ? 2 : 1]);
      } else if (w?.collider) {
        const c = w.collider;
        ends.push([...r3(pt), 0, Math.round(w.normal.x * 100) / 100, Math.round(w.normal.y * 100) / 100, Math.round(w.normal.z * 100) / 100, c.surface === 'metal' || c.surface === 'grate' ? 1 : 0]);
        if (c.barrelId !== undefined) this._damageBarrel(c.barrelId, def.damage * (def.pellets > 1 ? 1 : 1.2), i);
        if (c.lampId !== undefined) this._breakLamp(c.lampId);
      } else {
        ends.push([...r3(pt), 4]);
      }
    }
    if (pelletsHit > 0) s.hits++;
    if (victim && total > 0) {
      if (head) s.headshots++;
      this._damage(victim.s.id, total, i, { w: f.w, hs: head, from: _o, kind: 'bullet', dist: _o.distanceTo(victim.pos) });
      if (def.knockback && victim.s.alive && !victim.prot) {
        const k = def.knockback * (pelletsHit / def.pellets);
        this.emit({ t: 'imp', p: victim.s.id, v: r3(_v.copy(_d).setY(Math.max(0.15, _d.y)).normalize().multiplyScalar(k)) });
      }
    }
    if (tgHit) this._damageTarget(tgHit, tgDmg, tgHead, i);
    this.emit({ t: 'shot', p: i, w: f.w, o: f.o, e: ends, sid: f.sid });
    return true;
  }

  handleMelee(i, m, remote = false) {
    const s = this.ps[i];
    if (!s.alive || !this.isLive() || this.paused) return;
    if (!vec3ok(m.o) || !vec3ok(m.d) || !(Math.hypot(...m.d) > 1e-6)) return;
    const now = this.now();
    _o.set(m.o[0], m.o[1], m.o[2]);
    if (remote) {
      if (now - (s.lastMelee || 0) < MELEE.cooldown * 0.8) return;
      // Same origin rule as shots: the swing starts at the attacker's own eye.
      const ap = this.avatars[i].getPos();
      if (!(_o.distanceTo(_v.set(ap.x, ap.y + 1.2, ap.z)) <= 3.5)) return;
    }
    s.lastMelee = now;
    this._endProtection(i);
    _d.set(m.d[0], m.d[1], m.d[2]).normalize();
    // Walls, glass and floors stop a swing.
    const wh = this.world.raycast(_o, _d, MELEE.range);
    const reach = wh?.collider ? wh.t : MELEE.range;
    const vt = Math.min(now, Math.max(now - NET.maxRewind / 1000, m.vt ?? now));
    let hit = false;
    for (const t of this._otherAlive(i)) {
      const pos = new THREE.Vector3();
      const h = this.avatars[t.id].transformAt(vt, pos);
      const r = rayPlayer(_o, _d, pos, h, reach, 0.35);
      if (r) {
        hit = true;
        const prot = t.protectUntil > now;
        this._damage(t.id, MELEE.damage, i, { w: 'melee', hs: false, from: _o, kind: 'melee', dist: r.t });
        if (t.alive && !prot) this.emit({ t: 'imp', p: t.id, v: r3(_v.copy(_d).setY(0.25).normalize().multiplyScalar(5)) });
      }
    }
    for (const tg of this.trainingTargets) {
      if (!tg.alive) continue;
      if (rayPlayer(_o, _d, tg.pos, tg.height, reach, 0.35)) { this._damageTarget(tg, MELEE.damage, false, i); hit = true; }
    }
    this.emit({ t: 'melee', p: i, hit });
  }

  /** Only the guest's reloads come through here (the host's own are not validated). */
  handleReload(i, r) {
    if (!getWeapon(r.w)) return;
    if (r.shell) this.validators[i].shell(r.w, r.ct, this.now());
    else this.validators[i].reload(r.w, r.ct, this.now());
  }

  handleTrick(i, kind) {
    const s = this.ps[i];
    if (!s.alive || !this.isLive() || this.paused) return;
    if (typeof kind !== 'string' || !Object.hasOwn(ENERGY.trick, kind)) return;
    const gain = Math.min(ENERGY.trick[kind], s.trickBudget);
    if (!(gain > 0)) return;
    s.trickBudget -= gain;
    this._addEnergy(i, gain);
  }

  handleRush(i) {
    const s = this.ps[i];
    const now = this.now();
    if (!s.alive || !this.isLive() || this.paused || !(s.energy >= 100) || s.rushUntil > now) return false;
    s.energy = 0;
    s.rushUntil = now + ENERGY.rushDuration;
    s.rushes++;
    this.emit({ t: 'rush', p: i, until: s.rushUntil });
    return true;
  }

  /** Interact is only for swapping weapons; walk-over pickups are collected in _checkPickups. */
  handleInteract(i, pickupId) {
    const s = this.ps[i];
    if (!s.alive || !this.isLive() || this.paused || !Number.isInteger(pickupId)) return;
    const p = this.arena.pickups[pickupId];
    if (!p || p.kind !== 'weapon') return;
    const pos = this.avatars[i].getPos();
    if (!(_v.set(p.pos.x - pos.x, 0, p.pos.z - pos.z).length() <= 2.8) || !(Math.abs(p.pos.y - pos.y) <= 2)) return;
    if (!this.world.lineOfSight(_p.set(pos.x, pos.y + 1.5, pos.z), _o.set(p.pos.x, p.pos.y + 0.5, p.pos.z))) return;
    this._tryPickup(i, p, true);
  }

  _addEnergy(i, amt) {
    if (!Number.isFinite(amt) || amt <= 0) return;
    const s = this.ps[i];
    const before = s.energy;
    s.energy = Math.min(PLAYER.maxEnergy, s.energy + amt);
    if (Math.floor(s.energy) !== Math.floor(before)) this.emit({ t: 'en', p: i, en: Math.floor(s.energy), full: s.energy >= 100 && before < 100 });
  }

  _damage(v, amount, a, info) {
    const s = this.ps[v];
    if (!s.alive || amount <= 0 || !this.isLive()) return;
    const now = this.now();
    if (s.protectUntil > now) return;
    let dmg = amount;
    const absorbed = Math.min(s.armor, dmg);
    s.armor -= absorbed;
    s.health -= dmg - absorbed;
    if (a >= 0 && a !== v) {
      this.ps[a].damage += amount;
      this._addEnergy(a, amount * ENERGY.perDamage);
    }
    const from = info.from ? r3(info.from) : null;
    this.emit({ t: 'dmg', v, a, amt: Math.round(amount), hs: !!info.hs, hp: Math.max(0, Math.ceil(s.health)), ar: Math.ceil(s.armor), from, w: info.w, kind: info.kind });
    if (s.health <= 0) this._kill(v, a, info);
  }

  _kill(v, a, info) {
    const s = this.ps[v];
    if (!s.alive) return;
    const now = this.now();
    s.alive = false;
    s.health = 0;
    s.deaths++;
    s.streak = 0;
    s.rushUntil = 0;
    s.respawnAt = now + MATCH.respawnTime;
    let first = false, revenge = false, streak = 0;
    const credited = a >= 0 && a !== v;
    if (credited) {
      const A = this.ps[a];
      A.kills++;
      A.streak++;
      streak = A.streak;
      if (!this.firstBlood) { this.firstBlood = true; first = true; }
      if (A.lastKiller === v) { revenge = true; A.lastKiller = -1; }
      A.longestKill = Math.max(A.longestKill, info.dist || 0);
      this._addEnergy(a, ENERGY.perKill);
    }
    s.lastKiller = credited ? a : s.lastKiller;
    this.emit({
      t: 'kill', v, a: credited ? a : -1, w: info.w, hs: !!info.hs, dist: Math.round(info.dist || 0), first, revenge, streak,
      k: this.ps.map((p) => p.kills), d: this.ps.map((p) => p.deaths), respawnAt: s.respawnAt, mode: this.mode,
    });
    if (this.mode === 'training') return;
    if (credited && this.ps[a].kills >= MATCH.killLimit) this.end(a, 'kills');
    else if (this.phase === 'suddendeath') this.end(credited ? a : this.ps.find((p) => p.id !== v).id, 'suddendeath');
  }

  end(winner, reason) {
    if (this.phase === 'ended') return;
    this.phase = 'ended';
    this.winner = winner;
    this.rockets.length = 0;
    this.lastEnd = { t: 'end', winner, reason, stats: this.ps.map(statsOf), at: this.now() };
    this.emit(this.lastEnd);
  }

  // ------------------------------------------------------------ pickups
  _checkPickups(i, pos) {
    for (const p of this.arena.pickups) {
      const st = this.pickups[p.id];
      if (!st.avail) continue;
      const dx = p.pos.x - pos.x, dz = p.pos.z - pos.z, dy = pos.y - p.pos.y;
      if (dx * dx + dz * dz > 1.15 * 1.15 || dy < -0.6 || dy > 1.7) continue;
      this._tryPickup(i, p, false);
    }
  }

  _tryPickup(i, p, interact) {
    const st = this.pickups[p.id];
    if (!st.avail) return false;
    const s = this.ps[i];
    const now = this.now();
    let w = null, action = null;
    switch (p.kind) {
      case 'health': case 'healthLarge':
        if (s.health >= PLAYER.maxHealth) return false;
        s.health = Math.min(PLAYER.maxHealth, s.health + PICKUP_KINDS[p.kind].amount);
        break;
      case 'armor':
        if (s.armor >= PLAYER.maxArmor) return false;
        s.armor = Math.min(PLAYER.maxArmor, s.armor + PICKUP_KINDS.armor.amount);
        break;
      case 'energy':
        if (s.energy >= PLAYER.maxEnergy) return false;
        this._addEnergy(i, PICKUP_KINDS.energy.amount);
        break;
      case 'mega':
        s.health = Math.min(PLAYER.megaMax, s.health + PICKUP_KINDS.mega.amount);
        break;
      case 'weapon': {
        w = p.weapon;
        action = this.avatars[i].weaponAction ? this.avatars[i].weaponAction(w) : 'new';
        if (action === 'full') return false;
        if (action === 'swap' && !interact && !this.avatars[i].autoSwap) return false;
        const slot = SLOT_OF(w);
        const replaced = s.inventory[slot] !== w ? s.inventory[slot] : null;
        s.inventory = { ...s.inventory, [slot]: w };
        this.validators[i].give(w, replaced);
        break;
      }
      default: return false;
    }
    st.avail = false;
    st.respawnAt = now + (p.respawnOverride ?? pickupRespawn(p));
    this.emit({ t: 'pick', id: p.id, p: i, kind: p.kind, w, action, hp: Math.ceil(s.health), ar: Math.ceil(s.armor), en: Math.floor(s.energy), inv: s.inventory });
    return true;
  }

  // ------------------------------------------------------------ projectiles
  _spawnRocket(i, o, d, sid, def) {
    const r = {
      id: this.rocketId++, owner: i, pos: o.clone().addScaledVector(d, 0.5), dir: d.clone(), born: this.now(), sid, def,
    };
    this.rockets.push(r);
    this.emit({ t: 'rocket', id: r.id, p: i, o: r3(r.pos), d: [d.x, d.y, d.z], sid, at: r.born });
  }

  _updateRockets(dt, now) {
    for (let k = this.rockets.length - 1; k >= 0; k--) {
      const r = this.rockets[k];
      const P = r.def.projectile;
      const step = P.speed * dt;
      let bestT = step, hitPlayer = null, hitTarget = null;
      const w = this.world.raycast(r.pos, r.dir, step + P.radius, { collect: true });
      if (w?.passed) for (const g of w.passed) this._breakGlass(g.collider.glassId);
      const worldT = w?.collider ? Math.max(0, w.t - P.radius) : Infinity;
      if (worldT < bestT) bestT = worldT;
      for (const s of this.ps) {
        if (!s.alive || !this.avatars[s.id] || (s.id === r.owner && now - r.born < 0.25)) continue;
        const pos = this.avatars[s.id].getPos();
        const rp = rayPlayer(r.pos, r.dir, pos, this.avatars[s.id].getHeight(), step, P.radius);
        if (rp && rp.t <= bestT) { bestT = rp.t; hitPlayer = s; hitTarget = null; }
      }
      for (const tg of this.trainingTargets) {
        if (!tg.alive) continue;
        const rp = rayPlayer(r.pos, r.dir, tg.pos, tg.height, step, P.radius);
        if (rp && rp.t <= bestT) { bestT = rp.t; hitPlayer = null; hitTarget = tg; }
      }
      const hitWorld = !hitPlayer && !hitTarget && worldT <= step;
      if (hitPlayer || hitTarget || hitWorld || now - r.born > P.lifetime) {
        const at = r.pos.clone().addScaledVector(r.dir, Math.min(bestT, step));
        this.rockets.splice(k, 1);
        if (w?.collider?.barrelId !== undefined && hitWorld) this._damageBarrel(w.collider.barrelId, 100, r.owner);
        this._explode(at, r.owner, P, hitPlayer ? hitPlayer.id : -1, 'chaos', { id: r.id, sid: r.sid, target: hitTarget });
        continue;
      }
      r.pos.addScaledVector(r.dir, step);
    }
  }

  _explode(at, owner, P, direct, w, extra = {}) {
    this.emit({ t: 'boom', pos: r3(at), p: owner, id: extra.id || 0, sid: extra.sid, w });
    const now = this.now();
    let hitEnemy = false;
    for (const s of this.ps) {
      if (!s.alive || !this.avatars[s.id]) continue;
      const pos = this.avatars[s.id].getPos();
      const h = this.avatars[s.id].getHeight();
      let dmg = 0, kb = 0;
      const center = _p.set(pos.x, pos.y + h * 0.5, pos.z);
      if (s.id === direct) { dmg = w === 'chaos' ? getWeapon('chaos').damage : P.splashMax; kb = P.knockback * 0.8; }
      else {
        const d = distToPlayer(at, pos, h);
        if (d > P.splashRadius) continue;
        if (!this.world.lineOfSight(at, center) && !this.world.lineOfSight(at, _v.set(pos.x, pos.y + h - 0.2, pos.z))) continue;
        const k = 1 - d / P.splashRadius;
        dmg = P.splashMin + (P.splashMax - P.splashMin) * k;
        kb = P.knockback * (0.35 + 0.65 * k);
      }
      if (s.id === owner) dmg *= P.selfDamageMul;
      const dir = _d.subVectors(center, at);
      if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
      dir.normalize();
      dir.y += s.id === owner ? 0.65 : 0.35;
      dir.normalize();
      // Guests predict their own rocket-jump knockback locally; everyone else gets it here.
      const guestSelf = s.id === owner && w === 'chaos' && this.avatars[s.id].kind === 'remote';
      // Spawn protection also blocks enemy knockback (it used to shove freshly spawned players around).
      if (s.id !== owner && s.protectUntil > now) kb = 0;
      else if (s.id !== owner && dmg > 0) hitEnemy = true;
      if (dmg > 0) this._damage(s.id, dmg, owner, { w, hs: false, from: at, kind: 'splash', dist: owner >= 0 && owner !== s.id ? this.avatars[owner]?.getPos().distanceTo(pos) || 0 : 0 });
      if (s.alive && kb > 0 && !guestSelf) this.emit({ t: 'imp', p: s.id, v: r3(_v.copy(dir).multiplyScalar(kb)) });
      if (s.id === owner && kb > 0) this.handleTrick(owner, 'rocketjump');
    }
    if (hitEnemy && w === 'chaos' && owner >= 0 && this.ps[owner]) this.ps[owner].hits++;
    for (const tg of this.trainingTargets) {
      if (!tg.alive) continue;
      const d = distToPlayer(at, tg.pos, tg.height);
      if (extra.target === tg) this._damageTarget(tg, getWeapon('chaos').damage, false, owner);
      else if (d < P.splashRadius) this._damageTarget(tg, P.splashMin + (P.splashMax - P.splashMin) * (1 - d / P.splashRadius), false, owner);
    }
    for (const b of this.barrelState) {
      if (!b.alive) continue;
      const bp = this.arena.barrels[b.id].pos;
      if (bp.distanceTo(at) < P.splashRadius * 0.85 && bp.distanceTo(at) > 0.05) this._damageBarrel(b.id, 60, owner);
    }
    for (const g of this.arena.glass) if (!g.broken && g.center.distanceTo(at) < P.splashRadius * 0.7) this._breakGlass(g.id);
    void now;
  }

  // ------------------------------------------------------------ destructibles
  _breakGlass(id) {
    if (id === undefined) return;
    if (this.arena.breakGlass(id)) this.emit({ t: 'glass', id });
  }

  _breakLamp(id) {
    if (this.arena.lamps[id] && !this.arena.lamps[id].broken) {
      this.arena.breakLamp(id);
      this.emit({ t: 'lamp', id });
    }
  }

  _damageBarrel(id, dmg, attacker) {
    const b = this.barrelState[id];
    if (!b || !b.alive) return;
    b.hp -= dmg;
    b.lastHit = attacker;
    if (b.hp > 0) return;
    b.alive = false;
    b.respawnAt = this.now() + 30;
    this.arena.setBarrel(id, false);
    this.emit({ t: 'barrel', id, alive: false });
    const P = { splashRadius: 4.4, splashMax: 70, splashMin: 15, knockback: 10, selfDamageMul: 0.6 };
    this._explode(this.arena.barrels[id].pos.clone(), attacker, P, -1, 'barrel');
  }

  _damageTarget(tg, dmg, head, attacker) {
    dmg = Math.round(dmg);
    this.ps[attacker].damage += dmg;
    if (head) this.ps[attacker].headshots++;
    if (tg.maxHealth !== Infinity) {
      tg.health -= dmg;
      if (tg.health <= 0 && tg.alive) { tg.alive = false; tg.respawnAt = this.now() + 1.6; }
    }
    this.emit({ t: 'tdmg', id: tg.id, amt: dmg, hs: head, a: attacker, alive: tg.alive, hp: Math.max(0, tg.health) });
  }
}

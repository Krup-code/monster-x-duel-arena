// MatchClient: everything that happens during a match on THIS machine.
//  - local player: input -> movement prediction -> weapon firing (instant local feedback)
//  - opponent: interpolated network snapshots (online) or a local bot (practice)
//  - host/offline: runs the HostAuthority and feeds it local, remote and bot actions
//  - every authoritative event (from the local authority or from the host over the
//    network) is applied through handleEvent(), so host and guest share one code path.
import * as THREE from 'three';
import { MATCH, NET, PLAYER, MOVE, WEAPON_IDS, WEAPON_BY_ID } from './config.js';
import { PlayerSim, TransformHistory, emptyInput } from './player.js';
import { WeaponController, getWeapon, spreadDirections, STARTING, SLOT_OF } from './weapons.js';
import { HostAuthority } from './match.js';
import { rayPlayer } from './physics.js';
import { SnapshotBuffer, encodeState, decodeState, FLAG, LossTracker } from './network/sync.js';
import { BotController } from './bot.js';
import { settings } from './settings.js';
import { PICKUP_KINDS } from './pickups.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _v3 = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _col = new THREE.Color();
const UP = new THREE.Vector3(0, 1, 0);
const DEG = Math.PI / 180;

const AUTH_EVENTS = new Set(['start', 'phase', 'spawn', 'shot', 'dmg', 'kill', 'pick', 'pickup', 'rocket', 'boom', 'imp', 'glass', 'barrel', 'lamp', 'rush', 'rushEnd', 'en', 'protect', 'melee', 'sync', 'end', 'target', 'tdmg']);
export const isAuthorityEvent = (e) => e && AUTH_EVENTS.has(e.t);

const STEP_SOUND = { concrete: 'step_concrete', metal: 'step_metal', grate: 'step_grate', gravel: 'step_gravel', glass: 'step_metal' };
const PICKUP_SOUND = { health: 'pickup_health', healthLarge: 'pickup_health', armor: 'pickup_armor', energy: 'pickup_energy', mega: 'pickup_mega' };

function forwardFrom(yaw, pitch, out) {
  const cp = Math.cos(pitch);
  return out.set(-Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp);
}

function fmtTime(sec) {
  sec = Math.max(0, Math.ceil(sec));
  return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ avatars (authority view of players)
class LocalAvatar {
  constructor(mc) { this.mc = mc; this.kind = 'local'; }
  getPos() { return this.mc.local.sim.pos; }
  getHeight() { return this.mc.local.sim.height; }
  getVel() { return this.mc.local.sim.vel; }
  transformAt(t, out) {
    const h = this.mc.local.history.sample(t, out);
    if (h == null) { out.copy(this.mc.local.sim.pos); return this.mc.local.sim.height; }
    return h;
  }
  weaponAction(id) { return this.mc.local.weapons.pickupAction(id); }
  get autoSwap() { return !!settings.data.controls.autoSwap; }
}

class RemoteAvatar {
  constructor(mc) { this.mc = mc; this.kind = 'remote'; this._pos = new THREE.Vector3(); this.autoSwap = false; }
  _latest() {
    const r = this.mc.remote;
    const s = r.buffer.latest();
    const life = this.mc.authority?.ps[this.mc.opp]?.life;
    if (s && (life === undefined || s.life === life)) return s;
    return null;
  }
  getPos() {
    const s = this._latest();
    return s ? s.pos : this.mc.remote.spawnPos;
  }
  getHeight() { return this._latest()?.height ?? PLAYER.height; }
  getVel() { return this._latest()?.vel ?? this._pos.set(0, 0, 0); }
  transformAt(t, out) {
    const s = this.mc.remote.buffer.sample(t * 1000);
    const life = this.mc.authority?.ps[this.mc.opp]?.life;
    if (!s.valid || (life !== undefined && s.life !== life)) { out.copy(this.getPos()); return this.getHeight(); }
    out.copy(s.pos);
    return s.height;
  }
  weaponAction(id) {
    const a = this.mc.authority;
    const inv = a.ps[this.mc.opp].inventory;
    const slot = SLOT_OF(id);
    if (inv[slot] === id) {
      const st = a.validators[this.mc.opp].state[id];
      const d = getWeapon(id);
      return st && st.reserve >= d.reserve && st.mag >= d.mag ? 'full' : 'ammo';
    }
    return inv[slot] ? 'swap' : 'new';
  }
}

class BotAvatar {
  constructor(mc) { this.mc = mc; this.kind = 'bot'; this.autoSwap = true; }
  getPos() { return this.mc.bot.sim.pos; }
  getHeight() { return this.mc.bot.sim.height; }
  getVel() { return this.mc.bot.sim.vel; }
  transformAt(t, out) {
    const h = this.mc.bot.history.sample(t, out);
    if (h == null) { out.copy(this.mc.bot.sim.pos); return this.mc.bot.sim.height; }
    return h;
  }
  weaponAction(id) { return this.mc.bot.weapons.pickupAction(id); }
}

// ------------------------------------------------------------------ rocket visuals
let rocketGeo = null;
function rocketMesh(color = 0xff7a1a) {
  if (!rocketGeo) {
    const body = new THREE.CylinderGeometry(0.055, 0.065, 0.42, 10);
    body.rotateX(Math.PI / 2);
    const nose = new THREE.ConeGeometry(0.055, 0.14, 10);
    nose.rotateX(-Math.PI / 2);
    nose.translate(0, 0, -0.28);
    rocketGeo = { body, nose };
  }
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1d1e, metalness: 0.8, roughness: 0.35 });
  g.add(new THREE.Mesh(rocketGeo.body, mat));
  g.add(new THREE.Mesh(rocketGeo.nose, new THREE.MeshBasicMaterial({ color: new THREE.Color(0x7dff1a).multiplyScalar(3) })));
  const glow = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 8), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(5), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
  glow.position.z = 0.26;
  g.add(glow);
  return g;
}

// ------------------------------------------------------------------ MatchClient
export class MatchClient {
  /**
   * opts: { mode: 'duel'|'bot'|'training', role: 'host'|'guest'|'offline', myIndex, names: [a,b], difficulty }
   */
  constructor(game, opts) {
    this.g = game;
    this.mode = opts.mode;
    this.role = opts.role;
    this.me = opts.myIndex;
    this.opp = this.mode === 'training' ? -1 : 1 - this.me;
    this.names = opts.names.slice();
    this.difficulty = opts.difficulty || 'normal';
    this.arena = game.arena;
    this.world = this.arena.world;
    this.simClock = 0; // offline authority clock (scaled by slow motion)

    const mkPs = (i) => ({
      hp: PLAYER.maxHealth, ar: 0, en: 0, alive: false, kills: 0, deaths: 0, protect: false, rushUntil: 0, life: 0, inv: { ...STARTING },
      shots: 0, hits: 0, damage: 0, headshots: 0, rushes: 0, longest: 0, name: this.names[i] || `PLAYER ${i + 1}`,
    });
    this.view = {
      phase: 'idle', introAt: 0, countdownAt: 0, fightAt: 0, endAt: Infinity, winner: -1, rematch: false,
      ps: [mkPs(0), mkPs(1)], matchPointAnnounced: [false, false], endedAt: 0, endData: null,
    };

    // local player
    this.local = {
      sim: new PlayerSim(this.world), weapons: new WeaponController(), history: new TransformHistory(1.2), input: emptyInput(),
      alive: false, life: 0, deathPos: new THREE.Vector3(), killerName: null, respawnAt: 0, lastFireAt: -10, protectUntil: 0,
    };
    this.local.weapons.infiniteAmmo = this.mode === 'training';

    // opponent
    this.remote = null;
    this.bot = null;
    if (this.mode === 'duel') {
      this.remote = { buffer: new SnapshotBuffer(48), spawnPos: new THREE.Vector3(), stepDist: 0, lastPos: new THREE.Vector3(), lastRenderPos: new THREE.Vector3(), loss: new LossTracker(), weapon: 'razor', flags: 0, render: null, lastSnapAt: 0, lastValidPos: null };
    } else if (this.mode === 'bot') {
      const sim = new PlayerSim(this.world);
      const weapons = new WeaponController();
      this.bot = {
        sim, weapons, history: new TransformHistory(1.2), alive: false,
        controller: new BotController({ world: this.world, arena: this.arena, nav: game.getNav(), sim, weapons, difficulty: this.difficulty }),
        stepDist: 0,
      };
    }
    this.oppModel = this.opp >= 0 ? game.models[this.opp] : null;
    if (this.oppModel) {
      this.oppModel.setVisible(false);
      this.oppModel.setWeapon('razor', game.thirdPersonWeapon('razor'));
      this.oppWeapon = 'razor';
    }
    for (const m of game.models) m.setVisible(false);

    // authority (host / offline)
    this.authority = null;
    if (this.role !== 'guest') {
      const avatars = [];
      avatars[this.me] = new LocalAvatar(this);
      if (this.mode === 'duel') avatars[this.opp] = new RemoteAvatar(this);
      if (this.mode === 'bot') avatars[this.opp] = new BotAvatar(this);
      const names = this.mode === 'training' ? [this.names[0]] : this.names;
      this.authority = new HostAuthority({ arena: this.arena, mode: this.mode, now: () => this.now(), emit: (e) => this._emitAuthority(e), avatars, names });
    }

    // runtime
    this.rockets = new Map();
    this.predictedRockets = new Map();
    this.shotSeq = 0;
    this.sendTimer = 0;
    this.seq = 0;
    this.stateBuf = new ArrayBuffer(52);
    this.recoil = { p: 0, y: 0 };
    this.camFx = { bobPhase: 0, bob: 0, landDip: 0, landVel: 0, shake: 0, roll: 0, flinch: 0, fovKick: 0, landImpulse: 0 };
    this.countdownShown = -1;
    this.fightShownAt = -10;
    this.phaseAnnounced = {};
    this.intensity = 0;
    this.lastLocalHit = -10;
    this.reloadSoundStage = 0;
    this.training = this.mode === 'training' ? { shots: 0, hits: 0, headshots: 0, damage: 0, last: 0, hist: [] } : null;
    this.hud = this._makeHudState();
    this.paused = false; // offline pause (menu)
    this.netPaused = false; // online: opponent disconnected
    this.ended = false;
    this.rematchReq = { me: false, them: false };
    this.interactTarget = null;
    this.slowmoUntil = 0;
    this.fxTimeScale = 1;
    this.deadCam = { t: 0 };
    this.lastStepPos = new THREE.Vector3();
    this.spawnedOnce = false;
    this.whizCooldown = 0;
  }

  // ------------------------------------------------------------------ clocks
  /** Authority/match time in seconds (host clock). */
  now() {
    if (this.role === 'guest') return this.g.net.now() / 1000;
    if (this.role === 'host') return performance.now() / 1000;
    return this.simClock;
  }

  get online() { return this.role !== 'offline'; }
  get live() { const p = this.view.phase; return p === 'playing' || p === 'suddendeath' || p === 'training'; }

  // ------------------------------------------------------------------ start / stop
  startAuthority(rematch = false) {
    if (!this.authority) return;
    this.authority.start({ rematch });
  }

  dispose() {
    for (const r of this.rockets.values()) this._removeRocket(r);
    for (const r of this.predictedRockets.values()) this._removeRocket(r);
    this.rockets.clear();
    this.predictedRockets.clear();
    this.g.audio.stopHeartbeat();
    this.g.audio.setSuddenDeath(false);
    if (this.oppModel) this.oppModel.setVisible(false);
    this._clearSelfRagdoll();
    this.g.effects.trail('opp', _v.set(0, -100, 0), false);
  }

  // ------------------------------------------------------------------ authority plumbing
  _emitAuthority(e) {
    this.handleEvent(e);
    if (this.role === 'host' && this.g.net?.connected) this.g.net.send(e.t, e);
  }

  /** Messages from the guest (host side). */
  onGuestMessage(m) {
    const a = this.authority;
    if (!a) return;
    const i = this.opp;
    switch (m.t) {
      case 'fire': a.handleFire(i, m, true); break;
      case 'melee': a.handleMelee(i, m, true); break;
      case 'reload': a.handleReload(i, m); break;
      case 'interact': a.handleInteract(i, m.id); break;
      case 'rush': a.handleRush(i); break;
      case 'trick': a.handleTrick(i, m.k); break;
      case 'prefs': if (a.avatars[i]) a.avatars[i].autoSwap = !!m.autoSwap; break;
      default: break;
    }
  }

  /** Binary snapshot from the other peer. */
  onRemoteState(buf) {
    const r = this.remote;
    if (!r) return;
    const s = decodeState(buf);
    if (!r.loss.accept(s.seq)) return;
    // Host-side sanity: drop impossible teleports within the same life.
    if (this.role === 'host') {
      const prev = r.buffer.latest();
      if (prev && prev.life === s.life) {
        const dt = Math.max(0.016, (s.time - prev.time) / 1000);
        const d = prev.pos.distanceTo(s.pos);
        if (d > 6 && d / dt > 55 && (r.rejects = (r.rejects || 0) + 1) < 8) { console.warn('[host] rejected teleport', d.toFixed(1)); return; }
      }
      r.rejects = 0;
    }
    r.buffer.push(s);
    r.lastSnapAt = performance.now();
  }

  // ------------------------------------------------------------------ main update
  update(dt, realDt) {
    const g = this.g;
    if (this.role === 'offline' && !this.paused) this.simClock += dt;
    const now = this.now();

    // slow motion handling (offline: affects the sim; online: effects only)
    if (performance.now() / 1000 > this.slowmoUntil) this.fxTimeScale = 1;

    if (this.authority && !(this.role === 'offline' && this.paused)) this.authority.update(dt);

    this._updatePhaseTimeline(now);
    const inputActive = g.inputActive && !this.paused && !this.netPaused;
    this._updateLocal(dt, now, inputActive);
    if (this.bot && !this.paused) this._updateBot(dt, now);
    this._updateOpponentView(realDt, now);
    this._updateRockets(dt, now);
    this._updateCamera(realDt, now);
    this._sendSnapshot(realDt);
    this._updateMusic(realDt);
    this._buildHud(now);
  }

  _updatePhaseTimeline(now) {
    const v = this.view;
    const hud = this.g.ui.hud;
    if (v.phase === 'intro') {
      const span = Math.max(0.1, v.countdownAt - v.introAt);
      const k = (now - v.introAt) / span;
      const stage = v.rematch ? 'versus' : k < 0.55 ? 'title' : 'versus';
      if (this._introStage !== stage) {
        this._introStage = stage;
        hud.intro(stage, { mapName: this.arena.name, names: this.names, sub: this.mode === 'bot' ? `PRACTICE · ${this.difficulty.toUpperCase()}` : '1V1 DEATHMATCH · FIRST TO 15' });
      }
    } else if (this._introStage) {
      this._introStage = null;
      hud.intro(null);
    }
    if ((v.phase === 'intro' || v.phase === 'countdown') && now >= v.countdownAt && now < v.fightAt) {
      const n = Math.ceil(v.fightAt - now);
      if (n !== this.countdownShown && n >= 1 && n <= 3) {
        this.countdownShown = n;
        hud.countdown(String(n));
        this.g.audio.play('countdown_tick', { bus: 'ui' });
        this.g.audio.announce(['one', 'two', 'three'][n - 1]);
      }
    }
    if (now >= v.fightAt && this.countdownShown > 0 && v.phase !== 'intro') {
      this.countdownShown = 0;
      this.fightShownAt = now;
      hud.countdown('FIGHT');
      this.g.audio.play('countdown_go', { bus: 'ui' });
      this.g.audio.announce('fight');
    }
    if (this.fightShownAt > 0 && now - this.fightShownAt > 0.9) {
      this.fightShownAt = -10;
      hud.countdown('');
    }
  }

  // ------------------------------------------------------------------ local player
  _readInput(active) {
    const I = this.g.input;
    const inp = this.local.input;
    const c = settings.data.controls;
    if (!active) {
      Object.assign(inp, emptyInput());
      this._winp = { fire: false, firePressed: false, ads: false, reload: false, slot: null, next: false, prev: false, melee: false };
      return;
    }
    inp.mz = (I.down('forward') ? 1 : 0) - (I.down('back') ? 1 : 0);
    inp.mx = (I.down('right') ? 1 : 0) - (I.down('left') ? 1 : 0);
    inp.jump = I.down('jump');
    inp.jumpPressed = I.pressed('jump');
    inp.crouch = I.stateful('crouch', c.toggleCrouch);
    inp.crouchPressed = c.toggleCrouch ? inp.crouch && !this._prevCrouch : I.pressed('crouch');
    this._prevCrouch = inp.crouch;
    inp.sprint = I.down('sprint');
    const ads = I.stateful('ads', c.toggleAds);
    inp.ads = ads && this.local.weapons.state !== 'reloading';
    const slot = I.pressed('slot1') ? 1 : I.pressed('slot2') ? 2 : I.pressed('slot3') ? 3 : null;
    this._winp = {
      fire: I.down('fire'), firePressed: I.pressed('fire'), ads, reload: I.pressed('reload'), slot,
      next: I.pressed('nextWeapon'), prev: I.pressed('prevWeapon'), melee: I.pressed('melee'),
    };
  }

  _applyLook(active) {
    const { dx, dy } = this.g.input.consumeMouse();
    if (!active) return { dx: 0, dy: 0 };
    const c = settings.data.controls;
    const w = this.local.weapons;
    const def = w.def;
    const zoom = 1 + (def.adsFov - 1) * w.ads;
    const adsK = 1 + (c.adsSensitivity * zoom - 1) * w.ads;
    const k = c.sensitivity * 0.0011 * adsK;
    const sim = this.local.sim;
    sim.yaw -= dx * k;
    sim.pitch -= dy * k * (c.invertY ? -1 : 1);
    sim.pitch = Math.max(-88 * DEG, Math.min(88 * DEG, sim.pitch));
    return { dx, dy };
  }

  get viewYaw() { return this.local.sim.yaw + this.recoil.y * DEG; }
  get viewPitch() { return Math.max(-89 * DEG, Math.min(89 * DEG, this.local.sim.pitch + this.recoil.p * DEG)); }

  _updateLocal(dt, now, active) {
    const L = this.local;
    const sim = L.sim;
    const W = L.weapons;
    const g = this.g;
    const alive = L.alive;
    const live = this.live;
    this._readInput(active && alive);
    this.look = this._applyLook(active && alive && this.view.phase !== 'intro' && this.view.phase !== 'ended');
    const me = this.view.ps[this.me];
    const rush = me.rushUntil > now;
    sim.rush = rush;
    sim.frozen = !alive || !live || this.netPaused || (this.role === 'offline' && this.paused);

    // weapons first (firing sets the sprint-cancel flag)
    const def = W.def;
    const firingRecently = now - L.lastFireAt < 0.25 || this._winp.fire;
    L.input.firing = firingRecently;
    L.input.moveMul = def.moveMul * (firingRecently ? def.fireMoveMul : 1);
    if (alive) {
      const ctx = {
        speed: sim.horizontalSpeed(), onGround: sim.onGround, sprinting: sim.sprinting, sliding: sim.sliding, crouching: sim.crouching,
        reloadMul: rush ? 1.15 : 1, canFire: live && !this.netPaused,
      };
      const evs = W.update(dt, this._winp, ctx);
      for (const e of evs) this._onLocalWeaponEvent(e, now);
      // recoil accumulators -> camera offset
      this.recoil.p += W.recoilPitch;
      this.recoil.y += W.recoilYaw;
      W.recoilPitch = 0;
      W.recoilYaw = 0;
    }
    const rec = W.def.recoil.recover;
    const decay = Math.exp(-rec * dt * 0.55);
    this.recoil.p *= decay;
    this.recoil.y *= decay;

    // movement (substep for stability at low FPS)
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    const sdt = dt / steps;
    for (let i = 0; i < steps; i++) {
      sim.step(sdt, L.input);
      if (i === 0) { L.input.jumpPressed = false; L.input.crouchPressed = false; }
    }
    for (const e of sim.events) this._onLocalMoveEvent(e);
    sim.events.length = 0;
    L.history.push(now, sim.pos, sim.height, this.viewYaw, this.viewPitch);

    // interact (E) + energy rush (F)
    this._updateInteract(active && alive && live);
    if (active && alive && live && g.input.pressed('rush')) {
      if (me.en >= 100 && me.rushUntil <= now) {
        if (this.authority) this.authority.handleRush(this.me);
        else g.net.send('rush');
      } else if (me.rushUntil <= now) {
        this.g.ui.hud.toast(`ENERGY ${Math.floor(me.en)}/100`, 'info');
      }
    }
    if (this.training && active && g.input.held.has('KeyK') && g.input.pressedCodes.has('KeyK')) this.resetTrainingStats();
  }

  resetTrainingStats() {
    if (!this.training) return;
    Object.assign(this.training, { shots: 0, hits: 0, headshots: 0, damage: 0, last: 0, hist: [] });
    this.g.ui.hud.toast('TRAINING STATS RESET', 'info');
  }

  _onLocalMoveEvent(e) {
    const a = this.g.audio;
    const cam = this.camFx;
    switch (e.type) {
      case 'step': a.play(STEP_SOUND[e.surface] || 'step_concrete', { volume: e.loud ? 0.55 : 0.25, pitchVar: 0.08 }); break;
      case 'jump': a.play('jump', { volume: 0.6 }); break;
      case 'land': {
        const s = e.speed || 0;
        if (s > 3) {
          a.play(s > 12 ? 'land_hard' : 'land', { volume: Math.min(1, s / 12) });
          a.play(STEP_SOUND[e.surface] || 'step_concrete', { volume: 0.5 });
          cam.landImpulse = Math.min(1, s / 16);
          cam.landVel -= Math.min(0.22, s * 0.011) * 9 * settings.data.camera.landingDip;
        }
        break;
      }
      case 'slide': a.play('slide', { volume: 0.7 }); break;
      case 'mantle': a.play('mantle', { volume: 0.7 }); break;
      case 'wallkick': a.play('wallkick', { volume: 0.8 }); break;
      case 'jumppad':
        a.play('jumppad', { volume: 0.9 });
        this.arena.kickJumpPad(e.pad);
        this.g.effects.energyBurst(_v.copy(this.local.sim.pos).setY(this.local.sim.pos.y + 0.2), 0x7dff1a, 0.6);
        break;
      case 'trick':
        if (this.authority) this.authority.handleTrick(this.me, e.kind);
        else this.g.net.send('trick', { k: e.kind });
        break;
      default: break;
    }
  }

  _onLocalWeaponEvent(e, now) {
    const a = this.g.audio;
    const W = this.local.weapons;
    switch (e.type) {
      case 'fire': this._localFire(e, now); break;
      case 'dry': a.play('dry_fire', { volume: 0.7 }); break;
      case 'reloadStart':
        this.reloadSoundStage = 0;
        a.play(e.shell ? 'shell_insert' : 'reload_mag_out', { volume: 0.8 });
        break;
      case 'reloadEnd':
        a.play(e.pump ? 'crush_pump' : 'reload_bolt', { volume: 0.8 });
        if (!this.authority) this.g.net.send('reload', { w: W.current });
        break;
      case 'shell':
        a.play('shell_insert', { volume: 0.8 });
        if (!this.authority) this.g.net.send('reload', { w: W.current, shell: true });
        break;
      case 'switch':
        a.play('weapon_switch', { volume: 0.7 });
        this.g.viewmodel.setWeapon(e.weapon);
        break;
      case 'melee': this._localMelee(now); break;
      default: break;
    }
  }

  _eye(out) {
    return this.local.sim.eyePosition(out);
  }

  _remoteViewTime(now) {
    if (this.mode === 'duel') return (this.g.net.now() - this.interpDelay()) / 1000;
    return now;
  }

  interpDelay() {
    const net = this.g.net;
    const j = net ? net.clock.jitter : 0;
    return Math.max(NET.interpDelay * 0.7, Math.min(140, NET.interpDelay + j * 1.5));
  }

  /** Visual start point for local tracers: the viewmodel muzzle re-projected into the world camera. */
  _muzzleWorld(out) {
    const g = this.g;
    g.viewmodel.getMuzzleWorldPosition(_v3);
    const vmCam = g.vmCamera, cam = g.camera;
    const d = _v3.distanceTo(vmCam.position);
    _v3.project(vmCam);
    out.set(_v3.x, _v3.y, 0.5).unproject(cam).sub(cam.position).normalize().multiplyScalar(Math.max(0.3, d)).add(cam.position);
    return out;
  }

  _localFire(e, now) {
    const g = this.g;
    const L = this.local;
    const def = getWeapon(e.weapon);
    L.lastFireAt = now;
    const eye = this._eye(_eye).clone();
    const dir = forwardFrom(this.viewYaw, this.viewPitch, new THREE.Vector3());
    const sid = ++this.shotSeq;
    const vt = this._remoteViewTime(now);
    const msg = { w: e.weapon, o: [eye.x, eye.y, eye.z], d: [dir.x, dir.y, dir.z], seed: e.seed, sp: e.spread, vt, sid };
    // --- instant local feedback ---
    g.viewmodel.fire(e.weapon);
    g.audio.play(def.sound, { volume: 0.9, pitchVar: 0.03 });
    if (def.id === 'crush') g.audio.play('crush_pump', { delay: 0.32, volume: 0.8 });
    if (def.id === 'rail') g.audio.play('rail_charge', { delay: 0.05, volume: 0.7 });
    const muzzle = this._muzzleWorld(new THREE.Vector3());
    g.effects.localMuzzleLight(muzzle, def.id === 'rail' ? 0x9dff3a : def.id === 'chaos' ? 0xff7a1a : 0xffd890, def.pellets > 1 ? 1.5 : 1);
    this.camFx.shake = Math.min(1, this.camFx.shake + def.recoil.kick * 0.05);
    this.camFx.fovKick += def.recoil.kick * 0.25;
    if (def.type === 'hitscan') {
      const dirs = spreadDirections(dir, e.seed >>> 0, e.spread, def.pellets);
      const opp = this._oppRenderState();
      for (const d of dirs) {
        const w = this.world.raycast(eye, d, def.range, { collect: true });
        let t = w?.collider ? w.t : def.range;
        let hitOpp = null;
        if (opp && opp.alive) {
          const r = rayPlayer(eye, d, opp.pos, opp.height, t);
          if (r) { t = r.t; hitOpp = r; }
        }
        let hitTarget = null;
        for (const tg of this.arena.targets || []) {
          if (!tg.alive) continue;
          const r = rayPlayer(eye, d, tg.pos, tg.height, t);
          if (r) { t = r.t; hitTarget = tg; hitOpp = null; }
        }
        const end = _v.copy(d).multiplyScalar(t).add(eye);
        if (def.id === 'rail') g.effects.railBeam(muzzle, end, 0x9dff3a);
        else if (Math.random() < (def.tracer ?? 0.5) || def.pellets > 1) g.effects.tracer(muzzle, end, def.pellets > 1 ? 0xffe6a0 : 0xfff2b0, { width: def.pellets > 1 ? 0.012 : 0.018 });
        if (hitOpp) {
          g.effects.playerHit(end, d.clone().negate(), this.opp === 0 ? 0x7dff1a : 0xff8a1f, hitOpp.head);
        } else if (hitTarget) {
          g.effects.impact(end, _v2.copy(d).negate(), 'metal', { noDecal: true });
        } else if (w?.collider) {
          g.effects.impact(end, w.normal, w.collider.surface);
          if (Math.random() < 0.35) g.audio.play(w.collider.surface === 'metal' || w.collider.surface === 'grate' ? 'impact_metal' : 'impact_concrete', { position: end, volume: 0.35 });
        }
      }
    } else if (def.type === 'projectile' && this.role === 'guest') {
      // Predicted rocket (the host spawns the authoritative one).
      const r = this._spawnRocketVisual({ id: 'p' + sid, p: this.me, o: [eye.x + dir.x * 0.5, eye.y + dir.y * 0.5, eye.z + dir.z * 0.5], d: [dir.x, dir.y, dir.z], at: now }, true);
      r.sid = sid;
      r.visualStart = muzzle.clone();
      this.predictedRockets.set(sid, r);
    }
    // shell casings
    if (def.id !== 'rail' && def.id !== 'chaos' && settings.data.graphics.effects !== 'low') {
      g.viewmodel.getEjectWorldPosition(_v2);
      g.viewmodel.getEjectDirection(_v3);
      const ej = this._reprojectVm(_v2.clone());
      g.effects.casing(ej, _v3.multiplyScalar(2.2 + Math.random()).add(_v.copy(this.local.sim.vel).multiplyScalar(0.9)), def.id === 'crush' ? 'shell' : def.id === 'volt' ? 'green' : 'brass');
    }
    if (this.training) this.training.shots++;
    // --- authoritative path ---
    if (this.authority) this.authority.handleFire(this.me, msg, false);
    else g.net.send('fire', msg);
    this.intensity = Math.min(1, this.intensity + 0.04);
  }

  _reprojectVm(p) {
    const vmCam = this.g.vmCamera, cam = this.g.camera;
    const d = p.distanceTo(vmCam.position);
    p.project(vmCam);
    return p.set(p.x, p.y, 0.5).unproject(cam).sub(cam.position).normalize().multiplyScalar(Math.max(0.3, d)).add(cam.position);
  }

  _localMelee(now) {
    const eye = this._eye(new THREE.Vector3());
    const dir = forwardFrom(this.viewYaw, this.viewPitch, new THREE.Vector3());
    const msg = { o: [eye.x, eye.y, eye.z], d: [dir.x, dir.y, dir.z], vt: this._remoteViewTime(now) };
    this.g.audio.play('melee_swing', { volume: 0.8 });
    if (this.authority) this.authority.handleMelee(this.me, msg, false);
    else this.g.net.send('melee', msg);
  }

  _updateInteract(active) {
    this.interactTarget = null;
    if (!active) return;
    const pos = this.local.sim.pos;
    let best = null, bestD = 2.6;
    for (const p of this.arena.pickups) {
      if (p.kind !== 'weapon' || !this.view.ps.length) continue;
      if (this.authority ? !this.authority.pickups[p.id].avail : !this.arena.pickupVisuals.get(p.id)?.available) continue;
      const d = Math.hypot(p.pos.x - pos.x, p.pos.z - pos.z);
      if (d > bestD || Math.abs(p.pos.y - pos.y) > 2) continue;
      const act = this.local.weapons.pickupAction(p.weapon);
      if (act !== 'swap') continue;
      best = { kind: 'pickup', id: p.id, text: `SWAP TO ${getWeapon(p.weapon).name}` };
      bestD = d;
    }
    for (const it of this.arena.interactables || []) {
      const d = it.pos.distanceTo(_v.set(pos.x, pos.y + 1, pos.z));
      if (d < it.radius && d < bestD) { best = { kind: 'prop', it, text: it.label }; bestD = d; }
    }
    this.interactTarget = best;
    if (best && this.g.input.pressed('interact')) {
      if (best.kind === 'pickup') {
        if (this.authority) this.authority.handleInteract(this.me, best.id);
        else this.g.net.send('interact', { id: best.id });
      } else this._useProp(best.it);
    }
  }

  _useProp(it) {
    const a = this.g.audio, hud = this.g.ui.hud;
    if (it.kind === 'vending') {
      a.play('vending', { position: it.pos });
      a.play('pickup_energy', { delay: 0.45, volume: 0.6 });
      const lines = ['*CRACK* — tastes like victory.', 'MONSTER-X ZERO: 0 sugar, 100% excuses removed.', 'Out of order. Just kidding. *CRACK*', 'Limited edition flavor: RAIL BERRY.'];
      hud.toast(lines[(Math.random() * lines.length) | 0], 'info');
    } else if (it.kind === 'arcade') {
      a.play('countdown_tick', { bus: 'ui' });
      a.play('countdown_go', { bus: 'ui', delay: 0.3 });
      hud.toast(`X-RACER 86 · NEW HIGH SCORE ${String(900 + ((Math.random() * 99) | 0)).padStart(6, '0')} · ${this.names[this.me]}`, 'success');
    } else if (it.kind === 'helmet') {
      a.play('pickup_mega', { volume: 0.5 });
      hud.toast('THE GOLDEN LID — worn by the first ever Blackout champion. Purely decorative. Probably.', 'info');
    }
  }

  // ------------------------------------------------------------------ bot
  _updateBot(dt, now) {
    const B = this.bot;
    const sim = B.sim;
    const ps = this.view.ps[this.opp];
    const myPs = this.view.ps[this.me];
    const live = this.live;
    B.alive = ps.alive;
    sim.rush = ps.rushUntil > now;
    sim.frozen = !ps.alive || !live;
    const ctx = {
      now, alive: ps.alive && live, hp: ps.hp, ar: ps.ar, en: ps.en, rushActive: ps.rushUntil > now, spawnProtected: ps.protect,
      enemy: { alive: this.local.alive, pos: this.local.sim.pos, vel: this.local.sim.vel, height: this.local.sim.height, hp: myPs.hp },
      pickups: this._pickupList || (this._pickupList = this.arena.pickups.map((p) => ({ id: p.id, kind: p.kind, weapon: p.weapon || null, pos: p.pos, avail: true }))),
    };
    for (const p of ctx.pickups) p.avail = this.authority.pickups[p.id].avail;
    let out;
    try { out = B.controller.update(dt, ctx); } catch (e) { console.error('[bot]', e); out = null; }
    const move = out?.move || emptyInput();
    const winp = out?.weapon || { fire: false, firePressed: false, ads: false, reload: false, slot: null, next: false, prev: false, melee: false };
    if (ps.alive && live) {
      const def = B.weapons.def;
      move.moveMul = def.moveMul * (winp.fire ? def.fireMoveMul : 1);
      const evs = B.weapons.update(dt, winp, {
        speed: sim.horizontalSpeed(), onGround: sim.onGround, sprinting: sim.sprinting, sliding: sim.sliding, crouching: sim.crouching,
        reloadMul: ctx.rushActive ? 1.15 : 1, canFire: true,
      });
      B.weapons.recoilPitch = 0;
      B.weapons.recoilYaw = 0;
      for (const e of evs) this._onBotWeaponEvent(e, now);
      if (out?.rush && ps.en >= 100) this.authority.handleRush(this.opp);
    }
    const steps = Math.max(1, Math.ceil(dt / (1 / 120)));
    for (let i = 0; i < steps; i++) {
      sim.step(dt / steps, move);
      if (i === 0) { move.jumpPressed = false; move.crouchPressed = false; }
    }
    for (const e of sim.events) {
      if (e.type === 'step') this._remoteStep(sim.pos, e.surface, e.loud);
      else if (e.type === 'jumppad') { this.arena.kickJumpPad(e.pad); this.g.audio.play('jumppad', { position: sim.pos, volume: 0.8 }); }
      else if (e.type === 'land' && e.speed > 6) this.g.audio.play('land', { position: sim.pos, volume: 0.6 });
      else if (e.type === 'jump') this.g.audio.play('jump', { position: sim.pos, volume: 0.5 });
      else if (e.type === 'slide') this.g.audio.play('slide', { position: sim.pos, volume: 0.6 });
      else if (e.type === 'trick') this.authority.handleTrick(this.opp, e.kind);
    }
    sim.events.length = 0;
    B.history.push(now, sim.pos, sim.height, sim.yaw, sim.pitch);
  }

  _onBotWeaponEvent(e, now) {
    const B = this.bot;
    if (e.type === 'fire') {
      const eye = B.sim.eyePosition(new THREE.Vector3());
      const dir = B.sim.forward(new THREE.Vector3());
      this.authority.handleFire(this.opp, { w: e.weapon, o: [eye.x, eye.y, eye.z], d: [dir.x, dir.y, dir.z], seed: e.seed, sp: e.spread, vt: now, sid: 0 }, false);
      this.oppModel?.pulseFire(getWeapon(e.weapon).recoil.kick);
    } else if (e.type === 'melee') {
      const eye = B.sim.eyePosition(new THREE.Vector3());
      const dir = B.sim.forward(new THREE.Vector3());
      this.authority.handleMelee(this.opp, { o: [eye.x, eye.y, eye.z], d: [dir.x, dir.y, dir.z], vt: now }, false);
    } else if (e.type === 'switch') {
      this._setOppWeapon(e.weapon);
    } else if (e.type === 'reloadStart') {
      this.g.audio.play('reload_mag_out', { position: B.sim.pos, volume: 0.5 });
    }
  }

  // ------------------------------------------------------------------ opponent rendering
  /** Current rendered opponent transform (what this machine shows). */
  _oppRenderState() {
    if (this.opp < 0) return null;
    const ps = this.view.ps[this.opp];
    if (this.bot) {
      const s = this.bot.sim;
      return { pos: s.pos, height: s.height, alive: ps.alive, yaw: s.yaw, pitch: s.pitch, vel: s.vel };
    }
    return this.remote.render ? { ...this.remote.render, alive: ps.alive && this.remote.render.valid } : null;
  }

  _setOppWeapon(id) {
    if (!this.oppModel || this.oppWeapon === id || !getWeapon(id)) return;
    this.oppWeapon = id;
    this.oppModel.setWeapon(id, this.g.thirdPersonWeapon(id));
  }

  _updateOpponentView(realDt, now) {
    if (this.opp < 0 || !this.oppModel) return;
    const ps = this.view.ps[this.opp];
    const model = this.oppModel;
    const dt = realDt * this.fxTimeScale;
    let st;
    if (this.bot) {
      const s = this.bot.sim;
      st = {
        position: s.pos, yaw: s.yaw, pitch: s.pitch, velocity: s.vel, onGround: s.onGround, crouch: THREE.MathUtils.clamp((PLAYER.height - s.height) / (PLAYER.height - PLAYER.crouchHeight), 0, 1),
        sliding: s.sliding, sprinting: s.sprinting, ads: this.bot.weapons.ads > 0.5, reloading: this.bot.weapons.state === 'reloading',
        dead: !ps.alive, rush: ps.rushUntil > now, spawnProtected: ps.protect, timeScale: this.fxTimeScale,
      };
    } else {
      const r = this.remote;
      const t = this.g.net.now() - this.interpDelay();
      const s = r.buffer.sample(t);
      r.render = { pos: s.pos, height: s.height, yaw: s.yaw, pitch: s.pitch, vel: s.vel, valid: s.valid && s.life === ps.life };
      if (!s.valid) { model.setVisible(false); return; }
      const wid = WEAPON_BY_ID[s.weapon];
      if (wid && ps.alive) this._setOppWeapon(wid);
      st = {
        position: s.pos, yaw: s.yaw, pitch: s.pitch, velocity: s.vel, onGround: !!(s.flags & FLAG.ground),
        crouch: THREE.MathUtils.clamp((PLAYER.height - s.height) / (PLAYER.height - PLAYER.crouchHeight), 0, 1),
        sliding: !!(s.flags & FLAG.slide), sprinting: !!(s.flags & FLAG.sprint), ads: !!(s.flags & FLAG.ads), reloading: !!(s.flags & FLAG.reload),
        dead: !ps.alive, rush: ps.rushUntil > now, spawnProtected: ps.protect, timeScale: this.fxTimeScale,
      };
      // remote footsteps from interpolated motion (directional audio)
      if (ps.alive && st.onGround && !st.sliding && r.render.valid) {
        const d = Math.hypot(s.pos.x - r.lastRenderPos.x, s.pos.z - r.lastRenderPos.z);
        if (d < 2) {
          r.stepDist += d;
          const stride = st.sprinting ? 2.7 : st.crouch > 0.5 ? 1.5 : 2.15;
          if (r.stepDist > stride) {
            r.stepDist = 0;
            const sp = Math.hypot(s.vel.x, s.vel.z);
            if (sp > 1) {
              const gnd = this.world.groundHeight(s.pos.x, s.pos.y, s.pos.z, 0.3, 0.3, 1.0);
              this._remoteStep(s.pos, gnd?.collider?.surface || 'concrete', st.crouch < 0.5 && sp > 4);
            }
          }
        }
      }
      r.lastRenderPos.copy(s.pos);
    }
    if (ps.alive || model._rag) model.setVisible(true);
    model.update(dt, st);
    this.g.effects.trail('opp', st.position, ps.alive && ps.rushUntil > now, this.opp === 0 ? 0x7dff1a : 0xff8a1f);
  }

  _remoteStep(pos, surface, loud) {
    this.g.audio.play(STEP_SOUND[surface] || 'step_concrete', { position: pos, volume: loud ? 1.0 : 0.35, pitchVar: 0.08 });
  }

  // ------------------------------------------------------------------ rockets (visual)
  _spawnRocketVisual(e, predicted = false) {
    const mesh = rocketMesh(e.p === 0 ? 0x7dff1a : 0xff7a1a);
    const pos = new THREE.Vector3(...e.o);
    const dir = new THREE.Vector3(...e.d).normalize();
    const speed = getWeapon('chaos').projectile.speed;
    const lag = predicted ? 0 : Math.max(0, Math.min(0.3, this.now() - (e.at ?? this.now())));
    pos.addScaledVector(dir, speed * lag);
    mesh.position.copy(pos);
    mesh.lookAt(_v.copy(pos).add(dir));
    this.g.scene.add(mesh);
    const sound = this.g.audio.play('rocket_loop', { position: pos, loop: true, volume: 0.8 });
    const r = { id: e.id, mesh, pos, dir, speed, sound, owner: e.p, predicted, smoke: 0, exploded: false, born: this.now() };
    if (!predicted) this.rockets.set(e.id, r);
    return r;
  }

  _removeRocket(r) {
    if (!r) return;
    this.g.scene.remove(r.mesh);
    r.mesh.traverse((o) => { if (o.material) o.material.dispose?.(); });
    r.sound?.stop(0.05);
    r.exploded = true;
  }

  _updateRockets(dt, now) {
    const fx = this.g.effects;
    const step = (r) => {
      if (r.exploded) return;
      const move = r.speed * dt;
      if (r.predicted) {
        const hit = this.world.raycast(r.pos, r.dir, move + 0.2, { ignoreGlass: true });
        const opp = this._oppRenderState();
        let ht = hit?.collider ? hit.t : Infinity;
        if (opp?.alive) { const rp = rayPlayer(r.pos, r.dir, opp.pos, opp.height, move, 0.18); if (rp && rp.t < ht) ht = rp.t; }
        if (ht <= move + 0.2 || now - r.born > 6) {
          const at = r.pos.clone().addScaledVector(r.dir, Math.min(ht, move));
          this._localExplosionPrediction(at);
          r.explodedAt = at;
          this._removeRocket(r);
          return;
        }
      }
      r.pos.addScaledVector(r.dir, move);
      r.mesh.position.copy(r.pos);
      r.sound?.setPosition(r.pos);
      r.smoke -= dt;
      if (r.smoke <= 0) {
        r.smoke = 0.012;
        fx.smoke.emit(_v.copy(r.pos).addScaledVector(r.dir, -0.3), _v2.set((Math.random() - 0.5) * 0.4, 0.3, (Math.random() - 0.5) * 0.4), _col.setRGB(0.5, 0.5, 0.48), 1.0, 0.12, 0.7, 0.45);
        fx.glow.emit(_v.copy(r.pos).addScaledVector(r.dir, -0.25), _v2.set(0, 0, 0), _col.setRGB(2.6, 1.3, 0.4), 0.1, 0.25, 0.1, 1);
      }
    };
    for (const r of this.rockets.values()) step(r);
    for (const r of this.predictedRockets.values()) step(r);
    for (const [k, r] of this.predictedRockets) if (r.exploded && now - r.born > 8) this.predictedRockets.delete(k);
  }

  _localExplosionPrediction(at) {
    // Guest-side rocket jump prediction (host skips self-knockback for guest rockets).
    const P = getWeapon('chaos').projectile;
    const sim = this.local.sim;
    const center = _v.set(sim.pos.x, sim.pos.y + sim.height * 0.5, sim.pos.z);
    const d = center.distanceTo(at);
    if (this.local.alive && d < P.splashRadius && this.world.lineOfSight(at, center)) {
      const k = 1 - d / P.splashRadius;
      const dir = _v2.subVectors(center, at);
      if (dir.lengthSq() < 1e-4) dir.set(0, 1, 0);
      dir.normalize();
      dir.y += 0.65;
      dir.normalize();
      sim.applyImpulse(dir.multiplyScalar(P.knockback * (0.35 + 0.65 * k)));
    }
    this._explosionFx(at, 'chaos');
  }

  _explosionFx(at, w) {
    const g = this.g;
    g.effects.explosion(at, w === 'barrel' ? 4.2 : 4.6, w === 'barrel' ? 0x9dff3a : 0xff7a1a);
    g.audio.play(w === 'barrel' ? 'barrel_explode' : 'explosion', { position: at, volume: 1 });
    const d = at.distanceTo(g.camera.position);
    this.camFx.shake = Math.min(1.2, this.camFx.shake + Math.max(0, 1 - d / 16) * 1.1);
    this.intensity = Math.min(1, this.intensity + 0.2);
  }

  // ------------------------------------------------------------------ camera
  _updateCamera(dt, now) {
    const g = this.g;
    const cam = g.camera;
    const sim = this.local.sim;
    const fx = this.camFx;
    const cs = settings.data.camera;
    const v = this.view;
    if (v.phase === 'intro' && this.arena.flyover) {
      const span = Math.max(0.1, v.countdownAt - v.introAt);
      const k = THREE.MathUtils.clamp((now - v.introAt) / span, 0, 1);
      const e = k * k * (3 - 2 * k);
      if (v.rematch) {
        // quick swoop into the spawn
        this._eye(_eye);
        cam.position.lerpVectors(_v.copy(_eye).add(_v2.set(0, 3, 0)), _eye, e);
        cam.lookAt(_v.copy(_eye).add(forwardFrom(sim.yaw, 0, _v2)));
      } else {
        this.arena.flyover.getPointAt(e, cam.position);
        cam.lookAt(this.arena.flyoverLook);
      }
      g.setFov(this._baseFov());
      return;
    }
    if (!this.local.alive && v.phase !== 'idle') {
      // death cam: rise and look at our ragdoll
      if (this.selfRagdoll) this.selfRagdoll.update(dt * this.fxTimeScale, this._selfState);
      const dp = this.local.deathPos;
      this.deadCam.t = Math.min(1, this.deadCam.t + dt * 1.6);
      const t = this.deadCam.t;
      const back = forwardFrom(this.deadCam.yaw ?? sim.yaw, 0, _v2).multiplyScalar(-2.4 * t);
      _v.set(dp.x, dp.y + 1.6 + 1.6 * t, dp.z).add(back);
      // keep out of walls
      const hit = this.world.raycast(_v3.set(dp.x, dp.y + 1.5, dp.z), _dir.subVectors(_v, _v3).normalize(), _v.distanceTo(_v3), { ignoreGlass: true });
      if (hit?.point) _v.copy(hit.point).addScaledVector(_dir, -0.3);
      cam.position.copy(_v);
      if (this.selfRagdoll) {
        this.selfRagdoll.getHeadWorldPosition(_v2);
        if (Number.isFinite(_v2.x)) cam.lookAt(_v2.x, Math.max(_v2.y, dp.y + 0.2), _v2.z);
        else cam.lookAt(dp.x, dp.y + 0.6, dp.z);
      } else cam.lookAt(dp.x, dp.y + 0.6, dp.z);
      g.setFov(this._baseFov());
      return;
    }
    // first person
    const speed = sim.horizontalSpeed();
    if (sim.onGround && !sim.sliding && speed > 0.5) fx.bobPhase += dt * speed * 1.45;
    const bobAmt = cs.headBob * (sim.onGround && !sim.sliding ? Math.min(1, speed / 7) : 0) * (1 - this.local.weapons.ads * 0.8);
    fx.bob += (bobAmt - fx.bob) * Math.min(1, dt * 10);
    // landing spring
    fx.landVel += (-fx.landDip * 120 - fx.landVel * 16) * dt;
    fx.landDip += fx.landVel * dt;
    fx.landDip = Math.max(-0.3, Math.min(0.15, fx.landDip));
    fx.shake = Math.max(0, fx.shake - dt * 2.4);
    fx.fovKick *= Math.exp(-dt * 12);
    const roll = (sim.sliding ? -4 * DEG : 0) + (-this.local.input.mx * 0.6 * DEG * (sim.onGround ? 1 : 0.4));
    fx.roll += (roll - fx.roll) * Math.min(1, dt * 8);
    this._eye(_eye);
    _eye.y += sim.eyeSmooth + fx.landDip + Math.sin(fx.bobPhase * 2) * 0.028 * fx.bob;
    const side = Math.sin(fx.bobPhase) * 0.02 * fx.bob;
    cam.position.copy(_eye);
    const sh = fx.shake * fx.shake * cs.screenShake;
    const t = performance.now() / 1000;
    const shx = sh * 0.6 * DEG * (Math.sin(t * 61) + Math.sin(t * 37) * 0.5);
    const shy = sh * 0.6 * DEG * (Math.sin(t * 53) + Math.sin(t * 29) * 0.5);
    cam.rotation.order = 'YXZ';
    cam.rotation.set(this.viewPitch * (1) + shy + fx.flinch, this.viewYaw + shx, fx.roll);
    cam.translateX(side);
    fx.flinch *= Math.exp(-dt * 10);
    // FOV: base * ADS zoom, small sprint/rush widening
    const W = this.local.weapons;
    const zoom = 1 + (W.def.adsFov - 1) * W.ads;
    const widen = (sim.sprinting ? 1.03 : 1) * (sim.rush ? 1.02 : 1);
    this._fovWiden = (this._fovWiden ?? 1) + (widen - (this._fovWiden ?? 1)) * Math.min(1, dt * 6);
    g.setFov(this._baseFov() * zoom * this._fovWiden + fx.fovKick * cs.recoilShake);
    // viewmodel
    g.viewmodel.update(dt, {
      time: t, ads: W.ads, speed, onGround: sim.onGround, sprinting: sim.sprinting, sliding: sim.sliding,
      crouch: THREE.MathUtils.clamp((PLAYER.height - sim.height) / (PLAYER.height - PLAYER.crouchHeight), 0, 1), airborne: !sim.onGround,
      lookDX: this.look?.dx || 0, lookDY: this.look?.dy || 0, landing: fx.landImpulse,
      reloading: W.state === 'reloading', reloadT: W.state === 'reloading' ? this._reloadProgress() : 0,
      reloadKind: W.def.shellReload ? 'shell' : W.current === 'rail' ? 'cell' : 'mag',
      raising: W.state === 'raising' ? 1 - Math.max(0, W.stateT) / W.def.switchTime : 1,
      meleeT: W.state === 'melee' ? 1 - Math.max(0, W.stateT) / 0.5 : -1, kick: W.kick, railCharge: W.railCharge,
      rush: sim.rush, swayScale: cs.weaponSway, bobScale: cs.headBob, pump: W.current === 'crush' && W.cooldown > 0 ? 1 - W.cooldown / W.def.fireInterval : 0,
      dead: !this.local.alive,
    });
    fx.landImpulse = 0;
    // reload mid sound
    if (W.state === 'reloading' && !W.def.shellReload && this.reloadSoundStage === 0 && this._reloadProgress() > 0.55) {
      this.reloadSoundStage = 1;
      g.audio.play('reload_mag_in', { volume: 0.8 });
    }
  }

  _reloadProgress() {
    const W = this.local.weapons;
    const d = W.def;
    const total = d.shellReload ? d.reloadTime : d.reloadTime;
    return THREE.MathUtils.clamp(1 - Math.max(0, W.stateT) / total, 0, 1);
  }

  _baseFov() { return settings.data.graphics.fov; }

  // ------------------------------------------------------------------ networking (snapshots)
  _sendSnapshot(dt) {
    if (this.role === 'offline' || !this.g.net?.connected) return;
    this.sendTimer -= dt;
    if (this.sendTimer > 0) return;
    this.sendTimer += 1 / NET.sendRate;
    if (this.sendTimer < -0.1) this.sendTimer = 0;
    const L = this.local, sim = L.sim, W = L.weapons;
    const ps = this.view.ps[this.me];
    let flags = 0;
    if (sim.onGround) flags |= FLAG.ground;
    if (sim.crouching) flags |= FLAG.crouch;
    if (sim.sliding) flags |= FLAG.slide;
    if (sim.sprinting) flags |= FLAG.sprint;
    if (W.ads > 0.5) flags |= FLAG.ads;
    if (W.state === 'reloading') flags |= FLAG.reload;
    if (!L.alive) flags |= FLAG.dead;
    if (sim.rush) flags |= FLAG.rush;
    if (sim.mantle) flags |= FLAG.mantle;
    const s = this._snap || (this._snap = { pos: null, vel: null });
    s.life = L.life;
    s.pos = sim.pos;
    s.vel = sim.vel;
    s.yaw = this.viewYaw;
    s.pitch = this.viewPitch;
    s.height = sim.height;
    s.flags = flags;
    s.weapon = WEAPON_IDS[W.current] ?? 1;
    s.anim = 0;
    void ps;
    encodeState(s, this.seq++, this.g.net.now(), this.stateBuf);
    this.g.net.sendState(this.stateBuf.slice(0));
  }

  // ------------------------------------------------------------------ events
  handleEvent(e) {
    const g = this.g;
    const v = this.view;
    const hud = g.ui.hud;
    const now = this.now();
    switch (e.t) {
      case 'start': {
        if (e.resume) {
          // Re-sync after a reconnect: refresh clocks/names but never reset an in-progress or finished match.
          if (e.names) e.names.forEach((n, i) => { if (v.ps[i]) { v.ps[i].name = n; this.names[i] = n; } });
          if (!this.ended) {
            v.phase = e.phase;
            v.introAt = e.introAt; v.countdownAt = e.countdownAt; v.fightAt = e.fightAt; v.endAt = e.endAt;
            this.countdownShown = 0;
            g.onMatchStarted(this, e);
          }
          break;
        }
        v.phase = e.phase;
        v.introAt = e.introAt; v.countdownAt = e.countdownAt; v.fightAt = e.fightAt; v.endAt = e.endAt;
        v.rematch = !!e.rematch;
        v.winner = -1;
        v.matchPointAnnounced = [false, false];
        if (e.names) e.names.forEach((n, i) => { if (v.ps[i]) { v.ps[i].name = n; this.names[i] = n; } });
        for (const p of v.ps) Object.assign(p, { kills: 0, deaths: 0, shots: 0, hits: 0, damage: 0, headshots: 0, rushes: 0, longest: 0, rushUntil: 0, en: 0 });
        this.ended = false;
        this.rematchReq = { me: false, them: false };
        this.countdownShown = -1;
        this._introStage = null;
        if (this.role === 'guest') this.arena.resetProps();
        g.effects.clearDecals();
        for (const r of this.rockets.values()) this._removeRocket(r);
        this.rockets.clear();
        g.onMatchStarted(this, e);
        break;
      }
      case 'phase': {
        const prev = v.phase;
        v.phase = e.phase;
        if (e.fightAt !== undefined) v.fightAt = e.fightAt;
        if (e.endAt !== undefined) v.endAt = e.endAt;
        if (e.countdownAt !== undefined) v.countdownAt = e.countdownAt;
        if (e.phase === 'suddendeath' && prev !== 'suddendeath') {
          hud.announce('SUDDEN DEATH', 'danger', 2600);
          g.audio.announce('sudden_death');
          g.audio.setSuddenDeath(true);
          hud.centerMessage('NEXT ELIMINATION WINS', '', 'info', 2200);
        }
        g.updateMatchState();
        break;
      }
      case 'spawn': {
        const p = v.ps[e.p];
        p.alive = true;
        p.life = e.life;
        p.hp = e.hp ?? PLAYER.maxHealth;
        p.ar = 0;
        p.protect = e.protect > 0;
        p.rushUntil = 0;
        if (e.inv) p.inv = { ...e.inv };
        const pos = new THREE.Vector3(...e.pos);
        if (e.p === this.me) {
          const L = this.local;
          const first = !this.spawnedOnce;
          this.spawnedOnce = true;
          if (!e.resume || first) {
            L.sim.reset(pos, e.yaw ?? 0);
            L.weapons.reset(e.inv || STARTING);
            L.weapons.infiniteAmmo = this.mode === 'training';
            g.viewmodel.setWeapon(L.weapons.current, { instant: first });
          }
          this._clearSelfRagdoll();
          L.alive = true;
          L.life = e.life;
          L.history.clear();
          this.recoil.p = this.recoil.y = 0;
          this.deadCam.t = 0;
          g.viewmodel.setVisible(true);
          g.postfx.state.desat = 0;
          g.audio.setMuffled(false);
          if (!first && !e.resume) {
            g.audio.play('respawn', { volume: 0.8 });
            g.effects.spawnBeam(pos, this.me === 0 ? 0x7dff1a : 0xff8a1f);
          }
          g.updateMatchState();
        } else if (e.p === this.opp) {
          if (this.remote) {
            this.remote.spawnPos.copy(pos);
            if (!e.resume) this.remote.buffer.clear();
          }
          if (this.bot && !e.resume) {
            this.bot.sim.reset(pos, e.yaw ?? 0);
            this.bot.weapons.reset(e.inv || STARTING);
            this.bot.history.clear();
            try { this.bot.controller.reset(); } catch (err) { console.error(err); }
          }
          if (this.oppModel) {
            this.oppModel.respawn();
            this.oppModel.setVisible(true);
            this._setOppWeapon('razor');
          }
          if (this.spawnedOnce && !e.resume) {
            g.effects.spawnBeam(pos, this.opp === 0 ? 0x7dff1a : 0xff8a1f);
            g.audio.play('respawn', { position: pos, volume: 0.6 });
          }
        }
        break;
      }
      case 'shot': this._onRemoteShot(e); break;
      case 'dmg': this._onDamage(e); break;
      case 'kill': this._onKill(e); break;
      case 'pick': this._onPick(e); break;
      case 'pickup':
        this.arena.setPickupAvailable(e.id, true);
        g.audio.play('pickup_ammo', { position: this.arena.pickups[e.id].pos, volume: 0.25, pitch: 0.7 });
        break;
      case 'rocket':
        if (e.p === this.me && this.role === 'guest') {
          const pr = this.predictedRockets.get(e.sid);
          if (pr) pr.serverId = e.id;
          break;
        }
        this._spawnRocketVisual(e);
        if (e.p !== this.me) g.audio.play('chaos_fire', { position: new THREE.Vector3(...e.o), volume: 1 });
        break;
      case 'boom': {
        const at = new THREE.Vector3(...e.pos);
        const r = this.rockets.get(e.id);
        if (r) { this._removeRocket(r); this.rockets.delete(e.id); }
        let skip = false;
        if (e.p === this.me && this.role === 'guest' && e.sid) {
          const pr = this.predictedRockets.get(e.sid);
          if (pr) {
            if (pr.explodedAt && pr.explodedAt.distanceTo(at) < 2.0) skip = true;
            this._removeRocket(pr);
            this.predictedRockets.delete(e.sid);
          }
        }
        if (!skip) this._explosionFx(at, e.w);
        break;
      }
      case 'imp':
        if (e.p === this.me) this.local.sim.applyImpulse(new THREE.Vector3(...e.v));
        else if (this.bot && e.p === this.opp) this.bot.sim.applyImpulse(new THREE.Vector3(...e.v));
        break;
      case 'glass': {
        const gl = this.arena.glass[e.id];
        if (gl) {
          if (this.role === 'guest') this.arena.breakGlass(e.id);
          g.effects.glassShatter(gl.center, gl.size);
          g.audio.play(gl.vent ? 'impact_metal' : 'glass_break', { position: gl.center });
          if (gl.vent && !this._secretFound) { this._secretFound = true; hud.toast('SOMETHING RATTLED IN THE NORTH TUNNEL…', 'info'); }
        }
        break;
      }
      case 'barrel':
        this.arena.setBarrel(e.id, e.alive);
        if (e.alive) g.audio.play('respawn', { position: this.arena.barrels[e.id].pos, volume: 0.25, pitch: 1.4 });
        break;
      case 'lamp': {
        const l = this.arena.lamps[e.id];
        if (l) {
          if (this.role === 'guest') this.arena.breakLamp(e.id);
          g.effects.sparkBurst(l.pos, 18);
          g.audio.play('glass_break', { position: l.pos, volume: 0.6, pitch: 1.5 });
          g.audio.play('spark', { position: l.pos, volume: 0.7 });
        }
        break;
      }
      case 'rush': {
        v.ps[e.p].rushUntil = e.until;
        v.ps[e.p].en = 0;
        v.ps[e.p].rushes++;
        if (e.p === this.me) {
          g.audio.play('energy_rush_start', { volume: 1 });
          g.audio.startHeartbeat();
          hud.announce('ENERGY RUSH', 'rush', 1500);
          g.effects.energyBurst(_v.copy(this.local.sim.pos).setY(this.local.sim.pos.y + 1), 0x7dff1a, 1.3);
        } else {
          const pos = this.bot ? this.bot.sim.pos : this.remote?.render?.pos;
          if (pos) g.audio.play('energy_rush_start', { position: pos, volume: 0.8 });
        }
        break;
      }
      case 'rushEnd':
        v.ps[e.p].rushUntil = 0;
        if (e.p === this.me) g.audio.stopHeartbeat();
        break;
      case 'en':
        v.ps[e.p].en = e.en;
        if (e.full && e.p === this.me) {
          hud.flashRushReady();
          hud.announce('ENERGY RUSH READY', 'rush', 1800);
          g.audio.play('energy_full', { volume: 0.8 });
          g.audio.announce('energy_rush_ready');
        }
        break;
      case 'protect': v.ps[e.p].protect = !!e.on; break;
      case 'melee':
        if (e.p !== this.me) {
          const pos = this.bot ? this.bot.sim.pos : this.remote?.render?.pos;
          if (pos) g.audio.play(e.hit ? 'melee_hit' : 'melee_swing', { position: pos, volume: 0.8 });
        } else if (e.hit) g.audio.play('melee_hit', { volume: 0.9 });
        break;
      case 'sync': this._onSync(e); break;
      case 'end': this._onEnd(e); break;
      case 'target': {
        const tg = this.arena.targets?.[e.id];
        if (tg) { tg.alive = e.alive; tg.health = e.hp; }
        break;
      }
      case 'tdmg': {
        const tg = this.arena.targets?.[e.id];
        if (!tg) break;
        tg.flash = 1;
        if (this.role === 'guest') { tg.alive = e.alive; tg.health = e.hp; }
        if (e.a === this.me) {
          hud.hitmarker(e.alive ? (e.hs ? 'head' : 'hit') : 'kill');
          if (settings.data.hud.hitSound) g.audio.play(e.hs ? 'headshot_marker' : 'hitmarker', { bus: 'ui', volume: 0.7 });
          this._damageNumber(_v.set(tg.pos.x, tg.pos.y + tg.height * (e.hs ? 0.92 : 0.6), tg.pos.z), e.amt, e.hs);
          if (this.training) {
            const T = this.training;
            T.hits++; T.damage += e.amt; if (e.hs) T.headshots++; T.last = e.amt;
            T.hist.push([performance.now() / 1000, e.amt]);
          }
        }
        break;
      }
      default: break;
    }
  }

  _damageNumber(worldPos, amount, head) {
    if (!settings.data.camera.damageNumbers) return;
    const cam = this.g.camera;
    const p = _v3.copy(worldPos).project(cam);
    if (p.z > 1 || p.z < -1) return;
    const r = this.g.canvasRect();
    this.g.ui.hud.damageNumber((p.x * 0.5 + 0.5) * r.width, (-p.y * 0.5 + 0.5) * r.height, amount, head);
  }

  _onRemoteShot(e) {
    if (e.p === this.me) return; // predicted locally
    const g = this.g;
    const def = getWeapon(e.w);
    if (!def) return;
    const model = this.oppModel;
    const muzzle = new THREE.Vector3();
    if (model && this.view.ps[e.p]?.alive) model.getMuzzleWorldPosition(muzzle);
    else muzzle.set(...e.o);
    if (!Number.isFinite(muzzle.x)) muzzle.set(...e.o);
    model?.pulseFire(def.recoil.kick);
    g.effects.muzzle(muzzle, def.id === 'rail' ? 0x9dff3a : 0xffd890, def.pellets > 1 || def.id === 'rail');
    g.audio.play(def.sound, { position: muzzle, volume: 1 });
    if (def.id === 'crush') g.audio.play('crush_pump', { position: muzzle, delay: 0.32, volume: 0.6 });
    if (def.id === 'rail') g.audio.play('rail_charge', { position: muzzle, delay: 0.05, volume: 0.5 });
    const myEye = this._eye(_eye);
    for (const end of e.e || []) {
      const p = new THREE.Vector3(end[0], end[1], end[2]);
      const kind = end[3];
      if (def.id === 'rail') g.effects.railBeam(muzzle, p, 0x9dff3a);
      else if (Math.random() < (def.tracer ?? 0.5) + 0.2 || def.pellets > 1) g.effects.tracer(muzzle, p, 0xfff2b0, { width: def.pellets > 1 ? 0.012 : 0.02 });
      if (kind === 0) g.effects.impact(p, new THREE.Vector3(end[4], end[5], end[6]), end[7] ? 'metal' : 'concrete');
      else if (kind === 1 || kind === 2) {
        if (this.opp >= 0 && e.p === this.opp) g.effects.playerHit(p, _v2.subVectors(muzzle, p).normalize(), this.me === 0 ? 0x7dff1a : 0xff8a1f, kind === 2);
      }
      // near-miss whiz
      if (this.whizCooldown <= performance.now() && kind !== 1 && kind !== 2) {
        const seg = _v2.subVectors(p, muzzle);
        const len = seg.length();
        if (len > 2) {
          seg.divideScalar(len);
          const tt = THREE.MathUtils.clamp(_v3.subVectors(myEye, muzzle).dot(seg), 0, len);
          const closest = _v3.copy(muzzle).addScaledVector(seg, tt);
          if (closest.distanceTo(myEye) < 1.6 && tt > 2) {
            g.audio.play('bullet_whiz', { position: closest, volume: 0.8 });
            this.whizCooldown = performance.now() + 90;
          }
        }
      }
    }
    this.intensity = Math.min(1, this.intensity + 0.05);
    if (this.bot && e.p === this.me) { /* n/a */ }
  }

  _onDamage(e) {
    const g = this.g;
    const v = this.view;
    const hud = g.ui.hud;
    const victim = v.ps[e.v];
    if (!victim) return;
    const prevAr = victim.ar;
    victim.hp = e.hp;
    victim.ar = e.ar;
    if (e.a >= 0 && e.a !== e.v && v.ps[e.a]) v.ps[e.a].damage += e.amt;
    if (e.v === this.me) {
      // we got hit
      g.audio.play(prevAr > e.ar && e.ar >= 0 && prevAr > 0 ? 'armor_hit' : 'hurt', { volume: Math.min(1, 0.5 + e.amt / 60) });
      g.postfx.state.damage = Math.min(1, g.postfx.state.damage + 0.25 + e.amt / 100);
      this.camFx.flinch += (e.amt / 100) * 1.5 * DEG * settings.data.camera.screenShake;
      if (e.from) {
        const from = _v.set(...e.from);
        const toSrc = from.sub(this.local.sim.pos);
        const ang = Math.atan2(toSrc.x, toSrc.z);
        // angle relative to view: 0 = in front, +PI/2 = from the right
        let rel = this.viewYaw + Math.PI - ang;
        rel = Math.atan2(Math.sin(rel), Math.cos(rel));
        hud.damageIndicator(rel);
      }
      this.intensity = Math.min(1, this.intensity + 0.25);
      if (this.bot && e.a === this.opp) { /* bot hit us */ }
    }
    if (e.a === this.me && e.v !== this.me) {
      if (e.hp > 0) {
        hud.hitmarker(e.hs ? 'head' : 'hit');
        if (settings.data.hud.hitSound) g.audio.play(e.hs ? 'headshot_marker' : 'hitmarker', { bus: 'ui', volume: 0.75 });
      }
      const opp = this._oppRenderState();
      if (opp) this._damageNumber(_v.set(opp.pos.x, opp.pos.y + opp.height * (e.hs ? 0.95 : 0.65), opp.pos.z), e.amt, e.hs);
      this.lastLocalHit = this.now();
      this.intensity = Math.min(1, this.intensity + 0.1);
    }
    if (e.v === this.opp && this.oppModel && e.from) {
      this.oppModel.pulseHit(_v.set(...e.from));
      if (this.bot) { try { this.bot.controller.notifyDamaged(new THREE.Vector3(...e.from)); } catch { /* ignore */ } }
    }
  }

  _onKill(e) {
    const g = this.g;
    const v = this.view;
    const hud = g.ui.hud;
    if (e.k) e.k.forEach((k, i) => { if (v.ps[i]) v.ps[i].kills = k; });
    if (e.d) e.d.forEach((d, i) => { if (v.ps[i]) v.ps[i].deaths = d; });
    const victim = v.ps[e.v];
    victim.alive = false;
    victim.hp = 0;
    victim.rushUntil = 0;
    const killerName = e.a >= 0 ? v.ps[e.a].name : null;
    const wname = e.w === 'world' ? 'THE VOID' : e.w === 'barrel' ? 'ENERGY BARREL' : e.w === 'melee' ? 'MELEE' : getWeapon(e.w)?.name || e.w;
    if (settings.data.hud.killfeed && this.mode !== 'training') {
      hud.killfeed({ killer: killerName || victim.name, victim: victim.name, weapon: killerName ? wname : (e.w === 'world' ? 'FELL' : 'SELF-DESTRUCT'), head: e.hs, killerSide: e.a >= 0 ? e.a : -1, victimSide: e.v });
    }
    if (e.a === this.me && e.v !== this.me) {
      hud.hitmarker('kill');
      g.audio.play('kill_confirm', { bus: 'ui', volume: 0.9 });
      hud.centerMessage(`ELIMINATED ${victim.name}`, e.hs ? 'HEADSHOT' : '', 'elim', 1800);
      if (e.hs) g.audio.announce('headshot');
      if (e.first) { hud.announce('FIRST BLOOD', 'big', 2000); g.audio.announce('first_blood'); }
      else if (e.revenge) { hud.announce('REVENGE', 'big', 2000); g.audio.announce('revenge'); }
      else if (e.streak >= 4 && e.streak % 2 === 0) { hud.announce('DOMINATING', 'big', 2000); g.audio.announce('dominating'); }
      else if (e.streak === 2) { hud.announce('DOUBLE DOWN', 'big', 2000); g.audio.announce('double_down'); }
      this._slowmo(0.3, 0.3);
      this.intensity = 1;
    } else if (e.a >= 0 && e.a !== this.me && e.first) {
      hud.announce('FIRST BLOOD', 'danger', 1800);
      g.audio.announce('first_blood');
    }
    // match point
    for (let i = 0; i < 2; i++) {
      if (v.ps[i].kills === MATCH.killLimit - 1 && !v.matchPointAnnounced[i] && this.mode !== 'training') {
        v.matchPointAnnounced[i] = true;
        hud.announce('MATCH POINT', i === this.me ? 'big' : 'danger', 2200);
        g.audio.announce('match_point');
        g.audio.play('match_point', { bus: 'ui', volume: 0.8 });
      }
    }
    if (e.v === this.me) {
      const L = this.local;
      L.alive = false;
      L.deathPos.copy(L.sim.pos);
      L.killerName = killerName;
      L.respawnAt = e.respawnAt;
      this.deadCam.t = 0;
      this.deadCam.yaw = L.sim.yaw;
      g.viewmodel.setVisible(false);
      this._spawnSelfRagdoll(e);
      g.audio.play('death', { volume: 0.9 });
      g.audio.stopHeartbeat();
      g.audio.setMuffled(true);
      if (killerName && e.a !== this.me) hud.centerMessage(`ELIMINATED BY ${killerName}`, e.hs ? 'HEADSHOT' : '', 'death', 1600);
      this._slowmo(0.3, 0.3);
      g.updateMatchState();
    }
    if (e.v === this.opp && this.oppModel) {
      const killerPos = e.a === this.me ? this.local.sim.pos : null;
      const opp = this._oppRenderState();
      const imp = new THREE.Vector3(0, 2.5, 0);
      if (opp && killerPos) imp.add(_v.subVectors(opp.pos, killerPos).setY(0).normalize().multiplyScalar(e.w === 'chaos' || e.w === 'barrel' ? 9 : e.w === 'crush' ? 7 : 3.5));
      if (opp) imp.add(_v.copy(opp.vel).multiplyScalar(0.6));
      this.oppModel.die(imp, this.world);
      g.effects.energyBurst(_v.copy(opp?.pos || this.remote?.spawnPos || imp).setY((opp?.pos.y ?? 0) + 1), this.opp === 0 ? 0x7dff1a : 0xff8a1f, 1.2);
    }
  }

  /** Show our own body ragdolling so the death cam has something to look at. */
  _spawnSelfRagdoll(e) {
    const m = this.g.models[this.me];
    if (!m) return;
    const sim = this.local.sim;
    m.respawn();
    m.setWeapon(null, null);
    m.setVisible(true);
    m.update(1 / 60, {
      position: sim.pos, yaw: sim.yaw, pitch: 0, velocity: sim.vel, onGround: sim.onGround, crouch: 0,
      sliding: false, sprinting: false, ads: false, reloading: false, dead: false, rush: false, spawnProtected: false,
    });
    const imp = new THREE.Vector3(0, 2.5, 0);
    const opp = this._oppRenderState();
    if (opp && e.a === this.opp) imp.add(_v.subVectors(sim.pos, opp.pos).setY(0).normalize().multiplyScalar(e.w === 'chaos' || e.w === 'barrel' ? 9 : e.w === 'crush' ? 7 : 3.5));
    imp.add(_v.copy(sim.vel).multiplyScalar(0.6));
    m.die(imp, this.world);
    this.selfRagdoll = m;
    this._selfState = this._selfState || { position: new THREE.Vector3(), yaw: 0, pitch: 0, velocity: new THREE.Vector3(), onGround: true, crouch: 0, dead: true };
  }

  _clearSelfRagdoll() {
    if (!this.selfRagdoll) return;
    this.selfRagdoll.setVisible(false);
    this.selfRagdoll.respawn();
    this.selfRagdoll = null;
  }

  _slowmo(scale, dur) {
    if (!settings.data.camera.killSlowmo) return;
    this.fxTimeScale = scale;
    this.slowmoUntil = performance.now() / 1000 + dur;
    this.g.audio.setSlowmo(0.35, dur);
    if (this.role === 'offline') this.g.setTimeScale(scale, dur);
  }

  _onPick(e) {
    const g = this.g;
    const v = this.view;
    const hud = g.ui.hud;
    const pdef = this.arena.pickups[e.id];
    this.arena.setPickupAvailable(e.id, false);
    const ps = v.ps[e.p];
    ps.hp = e.hp; ps.ar = e.ar; ps.en = e.en;
    if (e.inv) ps.inv = { ...e.inv };
    if (e.p === this.me) {
      if (e.kind === 'weapon') {
        const res = this.local.weapons.give(e.w, e.action !== 'ammo');
        g.audio.play(res === 'ammo' ? 'pickup_ammo' : 'pickup_weapon', { volume: 0.9 });
        hud.toast(res === 'ammo' ? `${getWeapon(e.w).name} AMMO` : `${getWeapon(e.w).name} ACQUIRED`, 'success');
        if (res !== 'ammo') g.viewmodel.setWeapon(this.local.weapons.current);
      } else {
        g.audio.play(PICKUP_SOUND[e.kind] || 'pickup_ammo', { volume: 0.9 });
        hud.toast(PICKUP_KINDS[e.kind]?.label || e.kind.toUpperCase(), 'success');
        if (e.kind === 'mega') g.effects.energyBurst(_v.copy(pdef.pos).setY(pdef.pos.y + 1), 0xa6ff4d, 1.5);
      }
    } else {
      if (this.bot && e.p === this.opp && e.kind === 'weapon') this.bot.weapons.give(e.w, e.action !== 'ammo');
      g.audio.play(e.kind === 'weapon' ? 'pickup_weapon' : PICKUP_SOUND[e.kind] || 'pickup_ammo', { position: pdef.pos, volume: 0.6 });
    }
  }

  _onSync(e) {
    const v = this.view;
    if (e.phase && e.phase !== v.phase && this.role === 'guest') { v.phase = e.phase; this.g.updateMatchState(); }
    if (e.fightAt !== undefined) v.fightAt = e.fightAt;
    if (e.endAt !== undefined) v.endAt = e.endAt;
    if (e.countdownAt !== undefined) v.countdownAt = e.countdownAt;
    e.ps?.forEach((a, i) => {
      const p = v.ps[i];
      if (!p) return;
      p.hp = a[0]; p.ar = a[1]; p.en = a[2];
      p.kills = a[4]; p.deaths = a[5]; p.protect = !!a[6]; p.rushUntil = a[7]; p.life = a[8];
      const alive = !!a[3];
      if (i === this.me && alive !== this.local.alive && this.role === 'guest') {
        // reconcile after a dropped/merged state (rare)
        if (!alive && this.local.alive) { this.local.alive = false; this.g.viewmodel.setVisible(false); }
      }
      if (i !== this.me) p.alive = alive;
    });
    e.st?.forEach((a, i) => {
      const p = v.ps[i];
      if (!p) return;
      p.shots = a[0]; p.hits = a[1]; p.damage = a[2]; p.headshots = a[3]; p.rushes = a[4]; p.longest = a[5];
    });
    if (e.pk && this.role === 'guest') e.pk.forEach((a, id) => this.arena.setPickupAvailable(id, !!a));
    if (e.inv) {
      e.inv.forEach((inv, i) => { if (v.ps[i]) v.ps[i].inv = { ...inv }; });
      const mine = e.inv[this.me];
      const W = this.local.weapons;
      if (mine && this.role === 'guest') {
        for (const slot of ['primary', 'secondary', 'special']) {
          if (mine[slot] && W.inventory[slot] !== mine[slot]) W.give(mine[slot], false);
        }
      }
    }
    if (e.props && this.role === 'guest') {
      for (const id of e.props.glass) this.arena.breakGlass(id);
      for (const id of e.props.barrels) this.arena.setBarrel(id, false);
      for (const id of e.props.lamps) this.arena.breakLamp(id);
    }
    this.g.updateMatchState();
  }

  _onEnd(e) {
    const g = this.g;
    const v = this.view;
    if (this.ended) return;
    this.ended = true;
    v.phase = 'ended';
    v.winner = e.winner;
    v.endedAt = performance.now() / 1000;
    const victory = e.winner === this.me;
    g.audio.stopHeartbeat();
    g.audio.setSuddenDeath(false);
    // dramatic slowdown
    this.fxTimeScale = 0.25;
    this.slowmoUntil = performance.now() / 1000 + MATCH.endSlowmo;
    g.audio.setSlowmo(0.3, MATCH.endSlowmo);
    if (this.role === 'offline') g.setTimeScale(0.25, MATCH.endSlowmo);
    g.ui.hud.announce(victory ? 'VICTORY' : 'DEFEAT', victory ? 'big' : 'danger', 2600);
    g.audio.play(victory ? 'victory_sting' : 'defeat_sting', { bus: 'ui' });
    g.audio.announce(victory ? 'victory' : 'defeat');
    v.endData = {
      result: victory ? 'victory' : 'defeat', mode: this.mode, myIndex: this.me, winnerIndex: e.winner, reason: e.reason,
      names: this.names.slice(), map: this.arena.name, stats: e.stats,
    };
    g.updateMatchState();
    setTimeout(() => g.showEndScreen(this), MATCH.endSlowmo * 1000 + 200);
  }

  // ------------------------------------------------------------------ music + HUD
  _updateMusic(dt) {
    this.intensity = Math.max(0, this.intensity - dt * 0.08);
    const target = this.live ? 0.35 + this.intensity * 0.65 : 0.2;
    this._musicI = (this._musicI ?? 0.3) + (target - (this._musicI ?? 0.3)) * Math.min(1, dt * 0.8);
    this.g.audio.setMusicIntensity(this._musicI);
  }

  _makeHudState() {
    return {
      mode: this.mode, myIndex: this.me, names: this.names, scores: [0, 0], killLimit: MATCH.killLimit, timeText: '', timeWarning: false,
      phase: 'intro', hp: 100, ar: 0, maxHp: PLAYER.maxHealth, maxAr: PLAYER.maxArmor, en: 0, rushActive: false, rushRemaining: 0, rushReady: false,
      weapon: { id: 'razor', name: 'RAZOR AR', slot: 'primary', mag: 30, magSize: 30, reserve: 120, reloading: false, reloadProgress: 0, railCharge: 1, rare: false },
      inventory: { primary: 'razor', secondary: 'pistol', special: null }, current: 'razor', weaponNames: {},
      spread: 0, ads: 0, scope: 0, spawnProtected: false, dead: false, respawnIn: 0, killerName: null, interact: null,
      net: null, training: null, lowHealth: false, fps: null,
    };
  }

  _buildHud(now) {
    const h = this.hud;
    const v = this.view;
    const me = v.ps[this.me];
    const W = this.local.weapons;
    const def = W.def;
    h.names = this.names;
    h.scores[0] = v.ps[0].kills;
    h.scores[1] = v.ps[1].kills;
    h.phase = v.phase;
    if (this.mode === 'training') { h.timeText = ''; h.timeWarning = false; }
    else if (v.phase === 'suddendeath') { h.timeText = 'SUDDEN DEATH'; h.timeWarning = true; }
    else if (v.phase === 'intro' || v.phase === 'countdown') { h.timeText = fmtTime(MATCH.timeLimit); h.timeWarning = false; }
    else if (v.phase === 'ended') { h.timeWarning = false; }
    else {
      const rem = v.endAt - now;
      h.timeText = fmtTime(rem);
      h.timeWarning = rem <= 30;
    }
    h.hp = Math.max(0, Math.ceil(me.hp));
    h.ar = Math.max(0, Math.ceil(me.ar));
    h.en = Math.floor(me.en);
    h.rushActive = me.rushUntil > now;
    h.rushRemaining = h.rushActive ? THREE.MathUtils.clamp((me.rushUntil - now) / 8, 0, 1) : 0;
    h.rushReady = me.en >= 100 && !h.rushActive;
    const a = W.ammo[W.current] || { mag: 0, reserve: 0 };
    const hw = h.weapon;
    hw.id = W.current; hw.name = def.name; hw.slot = def.slot; hw.mag = a.mag; hw.magSize = def.mag; hw.reserve = W.infiniteAmmo ? Infinity : a.reserve;
    hw.reloading = W.state === 'reloading'; hw.reloadProgress = hw.reloading ? this._reloadProgress() : 0; hw.railCharge = W.railCharge; hw.rare = !!def.rare;
    h.inventory = W.inventory;
    h.current = W.current;
    if (!this._wn) { this._wn = {}; for (const id of ['pistol', 'razor', 'volt', 'crush', 'venom', 'chaos', 'rail']) this._wn[id] = getWeapon(id).name; }
    h.weaponNames = this._wn;
    // crosshair spread in px: convert spread degrees to screen px
    const sim = this.local.sim;
    const spreadDeg = W.spread({ speed: sim.horizontalSpeed(), onGround: sim.onGround, sliding: sim.sliding, crouching: sim.crouching });
    const fovRad = this.g.camera.fov * DEG;
    const px = (Math.tan(spreadDeg * DEG) / Math.tan(fovRad / 2)) * (this.g.canvasRect().height / 2);
    h.spread = Math.min(60, Math.max(0, px - 2));
    h.ads = W.ads;
    h.scope = def.scope ? THREE.MathUtils.clamp((W.ads - 0.6) / 0.4, 0, 1) : 0;
    h.spawnProtected = me.protect;
    h.dead = !this.local.alive && v.phase !== 'intro' && v.phase !== 'idle' && v.phase !== 'ended';
    h.respawnIn = Math.max(0, this.local.respawnAt - now);
    h.killerName = this.local.killerName;
    h.interact = this.interactTarget ? this.interactTarget.text : null;
    if (this.online && this.g.net) {
      const st = this.g.net;
      const ping = st.rtt ? Math.round(st.rtt) : null;
      h.net = h.net || { ping: null, quality: 'good', loss: 0 };
      h.net.ping = ping;
      h.net.quality = ping == null ? 'good' : ping <= 60 ? 'good' : ping <= 120 ? 'ok' : 'bad';
      h.net.loss = this.remote ? this.remote.loss.loss : 0;
    } else h.net = null;
    if (this.training) {
      const T = this.training;
      const t = performance.now() / 1000;
      while (T.hist.length && t - T.hist[0][0] > 3) T.hist.shift();
      const dps = T.hist.reduce((s, x) => s + x[1], 0) / 3;
      h.training = h.training || {};
      Object.assign(h.training, { shots: T.shots, hits: T.hits, accuracy: T.shots ? Math.round((T.hits / T.shots) * 100) : 0, headshots: T.headshots, damage: T.damage, dps: Math.round(dps), last: T.last });
    } else h.training = null;
    h.lowHealth = this.local.alive && me.hp < 30;
    h.fps = settings.data.graphics.showFps ? Math.round(this.g.fps) : null;
    // post fx state
    const pf = this.g.postfx.state;
    pf.damage = Math.max(0, pf.damage - (1 / 60) * 1.8);
    pf.low = h.lowHealth ? 1 : 0;
    pf.rush = h.rushActive ? 0.8 : Math.max(0, pf.rush - 0.03);
    pf.desat = this.local.alive || v.phase === 'intro' ? Math.max(0, pf.desat - 0.05) : Math.min(0.85, pf.desat + 0.04);
    pf.scope = h.scope;
  }

  /** Rows for the Tab scoreboard. */
  scoreboardRows() {
    const v = this.view;
    const n = this.mode === 'training' ? 1 : 2;
    const rows = [];
    for (let i = 0; i < n; i++) {
      const p = v.ps[i];
      const isMe = i === this.me;
      const ping = this.online ? (isMe ? 0 : Math.round(this.g.net?.rtt || 0)) : null;
      const accuracy = p.shots ? Math.round((p.hits / p.shots) * 100) : 0;
      rows.push({
        name: p.name, side: i, isMe, kills: p.kills, deaths: p.deaths, accuracy, damage: Math.round(p.damage), headshots: p.headshots,
        ping, score: p.kills * 100 + p.headshots * 25 + Math.floor(p.damage * 0.5),
      });
    }
    return rows;
  }

  /** Debug-panel lines (F3). */
  debugLines() {
    const sim = this.local.sim;
    const lines = [
      `FPS ${Math.round(this.g.fps)}  ·  MODE ${this.mode.toUpperCase()} (${this.role})  ·  PHASE ${this.view.phase}`,
      `POS ${sim.pos.x.toFixed(2)} ${sim.pos.y.toFixed(2)} ${sim.pos.z.toFixed(2)}  VEL ${sim.vel.x.toFixed(1)} ${sim.vel.y.toFixed(1)} ${sim.vel.z.toFixed(1)}  |H| ${sim.horizontalSpeed().toFixed(2)} m/s`,
      `GROUND ${sim.onGround ? sim.surface : 'air'}  SLIDE ${sim.sliding ? 'Y' : 'n'}  CROUCH ${sim.crouching ? 'Y' : 'n'}  WEAPON ${this.local.weapons.current} (${this.local.weapons.state})`,
    ];
    const net = this.g.net;
    if (net && this.online) {
      const s = net.stats();
      lines.push(
        `ROOM ${s.code}  ·  ${s.role?.toUpperCase()}  ·  ${s.backend}`,
        `PING ${s.rtt ? s.rtt.toFixed(0) : '—'} ms  ·  JITTER ${net.clock.jitter.toFixed(1)}  ·  OFFSET ${net.clock.offset.toFixed(1)} ms  ·  INTERP ${this.interpDelay().toFixed(0)} ms`,
        `PKTS OUT ${s.sent.toFixed(0)}/s  IN ${s.recv.toFixed(0)}/s  ·  LOSS ${((this.remote?.loss.loss || 0) * 100).toFixed(1)}%`,
        `PEER ${s.pc}  ·  ICE ${s.ice}  ·  STATE ${net.state}`,
      );
    }
    const info = this.g.renderer.info;
    lines.push(`DRAW CALLS ${info.render.calls}  ·  TRIS ${(info.render.triangles / 1000).toFixed(0)}k  ·  GEOS ${info.memory.geometries}  ·  TEX ${info.memory.textures}`);
    return lines;
  }
}

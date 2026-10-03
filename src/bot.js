// Practice bot. Drives a PlayerSim + WeaponController with the same inputs a human
// produces, so it obeys identical movement and weapon rules. Behaviour: perceive (view
// cone + line of sight + hearing + pain), pick a goal by utility (fight / hunt / retreat /
// collect / roam), follow NavGraph paths (walk, mantle, drop, jump pads), strafe and dodge
// while fighting, choose weapons by range and aim with human-like reaction, turn speed and
// error per difficulty.
import * as THREE from 'three';
import { getWeapon } from './weapons.js';

export const BOT_DIFFICULTY = {
  easy: { reaction: 0.55, aimError: 7, turnSpeed: 240, track: 4.5, lead: 0.25, discipline: 7, strafe: 0.2, headshot: 0.0, rush: false, retreatHp: 22, items: 0.45, jumpy: 0.04, fov: 95, tapRate: 0.55 },
  normal: { reaction: 0.32, aimError: 3.6, turnSpeed: 420, track: 8, lead: 0.6, discipline: 4.2, strafe: 0.6, headshot: 0.1, rush: true, retreatHp: 32, items: 0.7, jumpy: 0.12, fov: 110, tapRate: 0.8 },
  hard: { reaction: 0.2, aimError: 1.9, turnSpeed: 650, track: 13, lead: 0.85, discipline: 2.8, strafe: 0.85, headshot: 0.3, rush: true, retreatHp: 38, items: 0.9, jumpy: 0.25, fov: 120, tapRate: 0.92 },
  insane: { reaction: 0.12, aimError: 0.85, turnSpeed: 1000, track: 20, lead: 1, discipline: 1.8, strafe: 1, headshot: 0.55, rush: true, retreatHp: 44, items: 1, jumpy: 0.4, fov: 130, tapRate: 1 },
};

const PREF_RANGE = { pistol: 11, razor: 15, volt: 8, crush: 4.5, venom: 26, chaos: 13, rail: 28 };
const WEAPON_VALUE = { rail: 5, venom: 4, chaos: 4.2, crush: 3.2, volt: 3, razor: 1, pistol: 0 };
const SLOTS = ['primary', 'secondary', 'special'];

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _eye = new THREE.Vector3();
const _tgt = new THREE.Vector3();
const DEG = Math.PI / 180;

function wrap(a) { return Math.atan2(Math.sin(a), Math.cos(a)); }

function weaponScore(id, dist) {
  switch (id) {
    case 'pistol': return 1;
    case 'razor': return dist < 35 ? 3 : 2;
    case 'volt': return dist < 12 ? 4.5 : dist < 20 ? 2.6 : 1;
    case 'crush': return dist < 7 ? 6 : dist < 11 ? 2.4 : 0.2;
    case 'venom': return dist > 18 ? 5 : dist > 10 ? 3 : 1.4;
    case 'chaos': return dist > 4.5 && dist < 22 ? 4.3 : 0.4;
    case 'rail': return dist > 12 ? 6 : 2.2;
    default: return 0;
  }
}

export class BotController {
  constructor({ world, arena, nav, sim, weapons, difficulty = 'normal' }) {
    this.world = world;
    this.arena = arena;
    this.nav = nav;
    this.sim = sim;
    this.weapons = weapons;
    this.diff = BOT_DIFFICULTY[difficulty] || BOT_DIFFICULTY.normal;
    this.move = { mx: 0, mz: 0, jump: false, jumpPressed: false, crouch: false, crouchPressed: false, sprint: false, ads: false, firing: false, moveMul: 1 };
    this.winp = { fire: false, firePressed: false, ads: false, reload: false, slot: null, next: false, prev: false, melee: false };
    this.out = { move: this.move, weapon: this.winp, rush: false };
    this.reset();
  }

  reset() {
    this.canSee = false;
    this.seenSince = -1;
    this.reactionAt = Infinity;
    this.lastSeen = null;
    this.lastSeenT = -100;
    this.heard = null;
    this.heardT = -100;
    this.hurtFrom = null;
    this.hurtT = -100;
    this.mode = 'roam';
    this.goal = null;
    this.goalKey = '';
    this.path = null;
    this.pathIdx = 0;
    this.repathT = 0;
    this.stuckT = 0;
    this.stuckPos = this.sim.pos.clone();
    this.unstickT = 0;
    this.strafeDir = Math.random() < 0.5 ? -1 : 1;
    this.strafeT = 0;
    this.aimErrYaw = 0;
    this.aimErrPitch = 0;
    this.aimJitT = 0;
    this.tapT = 0;
    this.switchT = 0;
    this.wantHead = false;
    this.dodgeT = 0;
    this.slideT = 0;
    this.thinkT = 0;
    this.now = 0;
    this.roamTarget = null;
  }

  notifyDamaged(fromPos) {
    this.hurtFrom = fromPos ? fromPos.clone() : null;
    this.hurtT = this.now;
  }

  notifyHeard(pos) {
    this.heard = pos ? pos.clone() : null;
    this.heardT = this.now;
  }

  // ------------------------------------------------------------------ main
  update(dt, ctx) {
    this.now = ctx.now;
    const m = this.move, w = this.winp;
    m.mx = 0; m.mz = 0; m.jump = false; m.jumpPressed = false; m.crouch = false; m.crouchPressed = false; m.sprint = false; m.ads = false; m.firing = false;
    w.fire = false; w.firePressed = false; w.ads = false; w.reload = false; w.slot = null; w.next = false; w.prev = false; w.melee = false;
    this.out.rush = false;
    if (!ctx.alive) { this.path = null; return this.out; }

    const sim = this.sim;
    const D = this.diff;
    const now = ctx.now;
    sim.eyePosition(_eye);
    const enemy = ctx.enemy;
    const dist = enemy.alive ? sim.pos.distanceTo(enemy.pos) : Infinity;

    // ---------------- perception
    const wasSeeing = this.canSee;
    this.canSee = false;
    if (enemy.alive && dist < 90) {
      const chest = _tgt.set(enemy.pos.x, enemy.pos.y + enemy.height * 0.6, enemy.pos.z);
      const toE = _v.subVectors(chest, _eye);
      const ang = Math.abs(wrap(Math.atan2(-toE.x, -toE.z) - sim.yaw));
      const inCone = ang < (D.fov * DEG) / 2 || now - this.hurtT < 1.2 || dist < 3;
      if (inCone && (this.world.lineOfSight(_eye, chest) || this.world.lineOfSight(_eye, _v2.set(enemy.pos.x, enemy.pos.y + enemy.height - 0.15, enemy.pos.z)))) {
        this.canSee = true;
        if (!wasSeeing) {
          this.seenSince = now;
          this.reactionAt = now + D.reaction * (0.75 + Math.random() * 0.5);
          // first-sight aim error, shrinks while tracking
          this.aimErrYaw = (Math.random() - 0.5) * 2 * D.aimError * 2.6 * DEG;
          this.aimErrPitch = (Math.random() - 0.5) * 2 * D.aimError * 1.6 * DEG;
          this.wantHead = Math.random() < D.headshot;
        }
        this.lastSeen = (this.lastSeen || new THREE.Vector3()).copy(enemy.pos);
        this.lastSeenT = now;
      }
    }
    if (!this.canSee) this.reactionAt = Infinity;

    // ---------------- think (goal selection) at ~5 Hz
    this.thinkT -= dt;
    if (this.thinkT <= 0) {
      this.thinkT = 0.2;
      this._think(ctx, dist);
    }

    // ---------------- weapon choice
    this.switchT -= dt;
    if (this.switchT <= 0 && this.weapons.state !== 'reloading') {
      const best = this._bestWeapon(this.canSee || now - this.lastSeenT < 3 ? dist : 18);
      if (best && best !== this.weapons.current) {
        w.slot = SLOTS.indexOf(this.weapons.inventory.primary === best ? 'primary' : this.weapons.inventory.secondary === best ? 'secondary' : 'special') + 1;
        this.switchT = 1.2;
      }
    }

    // ---------------- movement
    const fighting = this.mode === 'fight';
    let moveDir = null;
    let faceDir = null;
    if (fighting) {
      const def = this.weapons.def;
      let pref = PREF_RANGE[def.id] ?? 14;
      if (enemy.hp < 40) pref *= 0.5; // pursue a weak opponent
      if (ctx.hp + ctx.ar * 0.5 < D.retreatHp) pref *= 1.6;
      const toE = _v.subVectors(enemy.pos, sim.pos).setY(0);
      const d = toE.length() || 1;
      toE.divideScalar(d);
      const md = new THREE.Vector3();
      if (d > pref + 4) {
        const wp = this._followPath(enemy.pos, dt, 0.9);
        if (wp) md.copy(wp); else md.copy(toE);
      } else if (d < pref - 3) md.copy(toE).negate().multiplyScalar(0.8);
      // strafe
      this.strafeT -= dt;
      if (this.strafeT <= 0) {
        this.strafeT = 0.25 + Math.random() * (1.1 - D.strafe * 0.6);
        if (Math.random() < 0.35 + D.strafe * 0.5) this.strafeDir *= -1;
      }
      const side = _v2.set(-toE.z, 0, toE.x).multiplyScalar(this.strafeDir * D.strafe);
      md.add(side);
      // avoid strafing off ledges / into walls
      if (md.lengthSq() > 1e-4) {
        md.normalize();
        if (!this._safeStep(md)) { this.strafeDir *= -1; md.addScaledVector(side, -2).normalize(); }
      }
      moveDir = md;
      // movement tricks under fire
      this.dodgeT -= dt;
      if (this.dodgeT <= 0) {
        this.dodgeT = 0.5 + Math.random() * 1.5;
        if (Math.random() < D.jumpy) m.jumpPressed = true;
        else if (Math.random() < D.jumpy * 0.6 && sim.horizontalSpeed() > 5.5) { m.crouchPressed = true; this.slideT = 0.5; }
      }
    } else {
      const target = this._goalPos(ctx);
      if (target) moveDir = this._followPath(target, dt, this.mode === 'retreat' ? 0.7 : 1);
      if (this.mode === 'hunt' && this.lastSeen) faceDir = _v2.subVectors(this.lastSeen, sim.pos).setY(0).normalize().clone();
      else if (now - this.hurtT < 1.5 && this.hurtFrom) faceDir = new THREE.Vector3().subVectors(this.hurtFrom, sim.pos).setY(0).normalize();
      else if (now - this.heardT < 2 && this.heard) faceDir = new THREE.Vector3().subVectors(this.heard, sim.pos).setY(0).normalize();
    }
    if (this.slideT > 0) { this.slideT -= dt; m.crouch = true; }

    // ---------------- aim
    this._aim(dt, ctx, dist, moveDir, faceDir);

    // ---------------- convert world move dir to local input
    if (moveDir && moveDir.lengthSq() > 1e-4) {
      const fx = -Math.sin(sim.yaw), fz = -Math.cos(sim.yaw);
      const rx = Math.cos(sim.yaw), rz = -Math.sin(sim.yaw);
      m.mz = moveDir.x * fx + moveDir.z * fz;
      m.mx = moveDir.x * rx + moveDir.z * rz;
      const l = Math.hypot(m.mx, m.mz);
      if (l > 1) { m.mx /= l; m.mz /= l; }
      m.sprint = !fighting && m.mz > 0.7 && !this.weapons.ads;
    }
    // mantle / jump links
    if (this._wantJumpHold) { m.jump = true; if (this._jumpTap) m.jumpPressed = true; }

    // ---------------- stuck detection
    const intent = Math.hypot(m.mx, m.mz) > 0.3;
    this.stuckT += dt;
    if (this.stuckT > 0.9) {
      const moved = sim.pos.distanceTo(this.stuckPos);
      if (intent && moved < 0.45) {
        this.unstickT++;
        m.jumpPressed = true;
        this.path = null;
        if (this.unstickT > 2) { this.roamTarget = null; this.goal = null; this.unstickT = 0; this.strafeDir *= -1; }
      } else this.unstickT = 0;
      this.stuckT = 0;
      this.stuckPos.copy(sim.pos);
    }

    // ---------------- fire / ads / reload / melee
    this._combat(dt, ctx, dist);
    if (D.rush && ctx.en >= 100 && !ctx.rushActive && (fighting || this.mode === 'hunt')) this.out.rush = true;
    return this.out;
  }

  // ------------------------------------------------------------------ goals
  _think(ctx, dist) {
    const D = this.diff;
    const now = ctx.now;
    const hp = ctx.hp + ctx.ar * 0.5;
    const enemy = ctx.enemy;
    const lowHp = hp < D.retreatHp && enemy.alive && enemy.hp + 10 > hp;
    if (this.canSee && now >= this.reactionAt && !(lowHp && dist > 8)) { this.mode = 'fight'; return; }
    if (this.canSee && now < this.reactionAt) { this.mode = 'fight'; return; }
    // retreat to health
    if (lowHp) {
      const h = this._bestPickup(ctx, (p) => (p.kind === 'health' || p.kind === 'healthLarge' || p.kind === 'mega') ? (p.kind === 'mega' ? 3 : p.kind === 'healthLarge' ? 2.5 : 2) : 0);
      if (h) { this._setGoal('retreat', h.pos, 'p' + h.id); return; }
    }
    // item run when nothing is going on (or opportunistic nearby items)
    const value = (p) => {
      if (p.kind === 'health' || p.kind === 'healthLarge') return ctx.hp < 85 ? (p.kind === 'healthLarge' ? 2.2 : 1.4) * (1 - ctx.hp / 120) * 2 : 0;
      if (p.kind === 'armor') return ctx.ar < 50 ? 1.6 * (1 - ctx.ar / 60) : 0;
      if (p.kind === 'mega') return 3;
      if (p.kind === 'energy') return ctx.en < 100 && this.diff.rush ? 0.8 : 0;
      if (p.kind === 'weapon') {
        const own = Object.values(this.weapons.inventory).includes(p.weapon);
        if (own) {
          const a = this.weapons.ammo[p.weapon];
          return a && a.reserve < getWeapon(p.weapon).reserve * 0.5 ? 0.6 : 0;
        }
        const slot = getWeapon(p.weapon).slot;
        const cur = this.weapons.inventory[slot];
        const gain = (WEAPON_VALUE[p.weapon] || 0) - (cur ? WEAPON_VALUE[cur] || 0 : 0);
        return gain > 0 && !cur ? gain : 0; // walk-over pickups only fill empty slots / upgrades via autoswap
      }
      return 0;
    };
    const recent = now - this.lastSeenT < 4 && this.lastSeen;
    const item = Math.random() < D.items ? this._bestPickup(ctx, value) : null;
    if (recent && (!item || item.score < 0.12)) {
      this._setGoal('hunt', this.lastSeen, 'hunt');
      return;
    }
    if (item) { this._setGoal('collect', item.pos, 'p' + item.id); return; }
    if (now - this.heardT < 3 && this.heard) { this._setGoal('hunt', this.heard, 'heard'); return; }
    if (now - this.hurtT < 2 && this.hurtFrom) { this._setGoal('hunt', this.hurtFrom, 'hurt'); return; }
    // roam: toward the enemy's general area or a random node
    if (!this.roamTarget || this.sim.pos.distanceTo(this.roamTarget) < 2.5) {
      if (enemy.alive && Math.random() < 0.55) this.roamTarget = enemy.pos.clone().add(new THREE.Vector3((Math.random() - 0.5) * 10, 0, (Math.random() - 0.5) * 10));
      else this.roamTarget = this.nav?.randomNode()?.pos.clone() || this.sim.pos.clone();
    }
    this._setGoal('roam', this.roamTarget, 'roam');
  }

  _bestPickup(ctx, valueFn) {
    let best = null;
    for (const p of ctx.pickups) {
      if (!p.avail) continue;
      const v = valueFn(p);
      if (v <= 0) continue;
      const d = this.sim.pos.distanceTo(p.pos) + Math.abs(p.pos.y - this.sim.pos.y) * 2;
      const score = v / (d + 8);
      if (!best || score > best.score) best = { id: p.id, pos: p.pos, score };
    }
    return best;
  }

  _setGoal(mode, pos, key) {
    this.mode = mode;
    if (!this.goal || key !== this.goalKey || this.goal.distanceTo(pos) > 3) {
      this.goal = (this.goal || new THREE.Vector3()).copy(pos);
      this.goalKey = key;
      this.path = null;
    }
  }

  _goalPos() { return this.goal; }

  _bestWeapon(dist) {
    let best = null, bs = -1;
    for (const slot of SLOTS) {
      const id = this.weapons.inventory[slot];
      if (!id) continue;
      const a = this.weapons.ammo[id];
      if (!a || (a.mag <= 0 && a.reserve <= 0)) continue;
      let s = weaponScore(id, dist);
      if (id === this.weapons.current) s += 0.4; // hysteresis
      if (s > bs) { bs = s; best = id; }
    }
    return best;
  }

  // ------------------------------------------------------------------ navigation
  _followPath(target, dt, speedK) {
    const sim = this.sim;
    this._wantJumpHold = false;
    this._jumpTap = false;
    this.repathT -= dt;
    const direct = this._directOk(target);
    if (direct) {
      this.path = null;
      return _v2.subVectors(target, sim.pos).setY(0).normalize().multiplyScalar(speedK).clone();
    }
    if (!this.path || this.repathT <= 0 || this.pathIdx >= this.path.length) {
      this.repathT = 0.9 + Math.random() * 0.4;
      this.path = this.nav ? this.nav.findPath(sim.pos, target) : null;
      this.pathIdx = 0;
      if (!this.path) return _v2.subVectors(target, sim.pos).setY(0).normalize().multiplyScalar(speedK).clone();
    }
    let wp = this.path[this.pathIdx];
    // advance waypoints
    for (let guard = 0; guard < 4 && wp; guard++) {
      const dh = Math.hypot(wp.pos.x - sim.pos.x, wp.pos.z - sim.pos.z);
      const dy = wp.pos.y - sim.pos.y;
      const reach = wp.type === 'pad' ? 0.45 : 0.85;
      if (dh < reach && Math.abs(dy) < 1.6) { this.pathIdx++; wp = this.path[this.pathIdx]; }
      else if (wp.type === 'drop' && dh < 1.2 && dy < -0.5) { this.pathIdx++; wp = this.path[this.pathIdx]; }
      else break;
    }
    if (!wp) return null;
    const dir = _v2.subVectors(wp.pos, sim.pos).setY(0);
    const dh = dir.length();
    if (dh < 1e-3) return null;
    dir.divideScalar(dh);
    if (wp.type === 'jump' && dh < 2.2 && wp.pos.y - sim.pos.y > 0.4) {
      this._wantJumpHold = true;
      this._jumpTap = sim.onGround;
    }
    if (!sim.onGround && sim.airTime > 0.1 && wp.type !== 'pad') {
      // air control toward the waypoint
      return dir.multiplyScalar(speedK).clone();
    }
    return dir.multiplyScalar(speedK).clone();
  }

  _directOk(target) {
    const sim = this.sim;
    const dy = target.y - sim.pos.y;
    const dh = Math.hypot(target.x - sim.pos.x, target.z - sim.pos.z);
    if (dh > 14 || Math.abs(dy) > 0.6) return false;
    // clear at knee and chest height and continuous ground
    const a = _v.set(sim.pos.x, sim.pos.y + 0.5, sim.pos.z);
    const b = new THREE.Vector3(target.x, target.y + 0.5, target.z);
    if (!this.world.lineOfSight(a, b)) return false;
    a.y += 0.9; b.y += 0.9;
    if (!this.world.lineOfSight(a, b)) return false;
    const steps = Math.ceil(dh / 0.8);
    let prevY = sim.pos.y;
    for (let i = 1; i <= steps; i++) {
      const k = i / steps;
      const x = sim.pos.x + (target.x - sim.pos.x) * k, z = sim.pos.z + (target.z - sim.pos.z) * k;
      const g = this.world.groundHeight(x, prevY, z, 0.25, 0.5, 1.2);
      if (!g || Math.abs(g.y - prevY) > 0.5) return false;
      prevY = g.y;
    }
    return true;
  }

  _safeStep(dir) {
    const p = this.sim.pos;
    const x = p.x + dir.x * 1.2, z = p.z + dir.z * 1.2;
    if (!this.world.isFree(x, p.y + 0.3, z, 0.34, 1.4)) return false;
    const g = this.world.groundHeight(x, p.y, z, 0.2, 0.5, 2.5);
    return !!g && p.y - g.y < 2;
  }

  // ------------------------------------------------------------------ aim + combat
  _aim(dt, ctx, dist, moveDir, faceDir) {
    const sim = this.sim;
    const D = this.diff;
    const enemy = ctx.enemy;
    let yawT = sim.yaw, pitchT = 0;
    if (this.canSee && enemy.alive) {
      const def = this.weapons.def;
      const tp = _tgt;
      if (def.type === 'projectile') {
        // splash: aim at the feet, lead the target
        const tFly = dist / (def.projectile?.speed || 34);
        tp.set(enemy.pos.x + enemy.vel.x * tFly * D.lead, enemy.pos.y + 0.15, enemy.pos.z + enemy.vel.z * tFly * D.lead);
      } else {
        const h = this.wantHead ? enemy.height - 0.2 : enemy.height * 0.62;
        tp.set(enemy.pos.x + enemy.vel.x * 0.04 * D.lead, enemy.pos.y + h, enemy.pos.z + enemy.vel.z * 0.04 * D.lead);
      }
      const d = _v.subVectors(tp, _eye);
      yawT = Math.atan2(-d.x, -d.z);
      pitchT = Math.atan2(d.y, Math.hypot(d.x, d.z));
      // error decays while tracking, with a residual wobble
      const decay = Math.exp(-D.track * 0.35 * dt);
      this.aimErrYaw *= decay;
      this.aimErrPitch *= decay;
      this.aimJitT -= dt;
      if (this.aimJitT <= 0) {
        this.aimJitT = 0.15 + Math.random() * 0.25;
        const moving = Math.hypot(enemy.vel.x, enemy.vel.z) / 7;
        this.aimErrYaw += (Math.random() - 0.5) * D.aimError * (0.35 + moving * 0.5) * DEG;
        this.aimErrPitch += (Math.random() - 0.5) * D.aimError * 0.25 * DEG;
      }
      yawT += this.aimErrYaw;
      pitchT += this.aimErrPitch;
    } else if (faceDir) {
      yawT = Math.atan2(-faceDir.x, -faceDir.z);
      pitchT = 0;
    } else if (moveDir && moveDir.lengthSq() > 0.01) {
      yawT = Math.atan2(-moveDir.x, -moveDir.z);
      pitchT = 0;
    }
    const maxStep = D.turnSpeed * DEG * dt;
    const k = Math.min(1, dt * (this.canSee ? D.track : 6));
    const ey = wrap(yawT - sim.yaw);
    sim.yaw = wrap(sim.yaw + THREE.MathUtils.clamp(ey * Math.max(k, 0.12), -maxStep, maxStep));
    const ep = pitchT - sim.pitch;
    sim.pitch = THREE.MathUtils.clamp(sim.pitch + THREE.MathUtils.clamp(ep * Math.max(k, 0.12), -maxStep, maxStep), -1.5, 1.5);
    this.aimErrorNow = Math.hypot(wrap(yawT - this.aimErrYaw - sim.yaw), pitchT - this.aimErrPitch - sim.pitch) / DEG;
  }

  _combat(dt, ctx, dist) {
    const W = this.weapons;
    const w = this.winp;
    const D = this.diff;
    const def = W.def;
    const a = W.ammo[W.current];
    const now = ctx.now;
    if (!a) return;
    if (a.mag <= 0 && a.reserve > 0) w.reload = true;
    if (!this.canSee) {
      if (a.mag < def.mag * 0.4 && a.reserve > 0) w.reload = true;
      return;
    }
    if (now < this.reactionAt) return;
    if (dist < 2.1 && Math.random() < 0.05) { w.melee = true; return; }
    const longGun = def.id === 'venom' || def.id === 'rail';
    w.ads = longGun && dist > 14;
    this.move.ads = w.ads;
    // tolerance grows at close range (target covers more screen)
    const tol = D.discipline + (def.pellets > 1 ? 3 : 0) + Math.max(0, 6 - dist) * 1.2;
    const onTarget = this.aimErrorNow !== undefined && this.aimErrorNow < tol;
    if (!onTarget) return;
    if (def.type === 'projectile' && dist < 3.2) return; // don't blow ourselves up
    if (def.auto) {
      w.fire = true;
    } else {
      this.tapT -= dt;
      if (this.tapT <= 0) {
        w.firePressed = true;
        w.fire = true;
        this.tapT = def.fireInterval * (1 / D.tapRate) + Math.random() * 0.05;
      }
    }
    this.move.firing = true;
  }
}

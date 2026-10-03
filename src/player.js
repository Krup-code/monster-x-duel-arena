// Player movement simulation: quake-style ground/air acceleration, sprinting, sliding,
// slide-jumps, air strafing, mantling, wall kicks, jump pads and knockback.
// Used for the local player (client-side prediction) and for bots.
import * as THREE from 'three';
import { MOVE, PLAYER } from './config.js';

const JUMP_V = Math.sqrt(2 * MOVE.gravity * MOVE.jumpHeight);
const _wish = new THREE.Vector3();
const _fwd = new THREE.Vector3();
const _right = new THREE.Vector3();
const _delta = new THREE.Vector3();
const _probe = new THREE.Vector3();

export function emptyInput() {
  return {
    mx: 0, mz: 0, jump: false, jumpPressed: false, crouch: false, crouchPressed: false,
    sprint: false, ads: false, firing: false, moveMul: 1,
  };
}

export class PlayerSim {
  constructor(world) {
    this.world = world;
    this.pos = new THREE.Vector3();
    this.vel = new THREE.Vector3();
    this.yaw = 0;
    this.pitch = 0;
    this.height = PLAYER.height;
    this.radius = PLAYER.radius;
    this.events = [];
    this.reset(new THREE.Vector3(), 0);
  }

  reset(pos, yaw = 0) {
    this.pos.copy(pos);
    this.vel.set(0, 0, 0);
    this.yaw = yaw;
    this.pitch = 0;
    this.height = PLAYER.height;
    this.onGround = false;
    this.ground = null;
    this.surface = 'concrete';
    this.crouching = false;
    this.sliding = false;
    this.slideTime = 0;
    this.slideCooldown = 0;
    this.slideQueued = false;
    this.sprinting = false;
    this.coyote = 0;
    this.jumpBuffer = 0;
    this.airTime = 0;
    this.airTrickDone = false;
    this.wallKickUsed = false;
    this.lastWall = null;
    this.lastWallTime = -1;
    this.mantle = null;
    this.stepDist = 0;
    this.padCooldown = 0;
    this.eyeSmooth = 0;
    this.rush = false;
    this.frozen = false;
    this.time = 0;
    this.jumpedAt = -1;
    this.lastPadAt = -1;
    this.events.length = 0;
  }

  get eyeHeight() {
    return this.height - PLAYER.eyeOffset;
  }

  eyePosition(out) {
    return out.set(this.pos.x, this.pos.y + this.eyeHeight, this.pos.z);
  }

  horizontalSpeed() {
    return Math.hypot(this.vel.x, this.vel.z);
  }

  forward(out) {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp);
  }

  applyImpulse(v) {
    this.vel.add(v);
    if (v.y > 0.5) {
      this.onGround = false;
      this.coyote = 0;
      this.impulseAt = this.time;
    }
    if (this.mantle) this.mantle = null;
  }

  emit(type, data) {
    this.events.push(data ? { type, ...data } : { type });
  }

  step(dt, inp) {
    this.time += dt;
    const w = this.world;
    this.padCooldown -= dt;
    this.slideCooldown -= dt;
    this.coyote -= dt;
    this.jumpBuffer -= dt;
    if (inp.jumpPressed) this.jumpBuffer = MOVE.jumpBuffer;

    if (this.mantle) {
      this._updateMantle(dt);
      return;
    }

    const frozen = this.frozen;
    _fwd.set(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const mx = frozen ? 0 : inp.mx;
    const mz = frozen ? 0 : inp.mz;
    _wish.set(0, 0, 0).addScaledVector(_fwd, mz).addScaledVector(_right, mx);
    const wishLen = Math.min(1, _wish.length());
    if (wishLen > 1e-4) _wish.normalize();

    let hspeed = this.horizontalSpeed();

    // --- crouch / slide intent ---
    if (!frozen && inp.crouchPressed) {
      if (this.onGround && hspeed > 5.0 && this.slideCooldown <= 0 && !this.sliding) this._startSlide();
      else if (!this.onGround) this.slideQueued = true;
    }
    if (!inp.crouch) this.slideQueued = false;
    if (this.slideQueued && this.onGround) {
      this.slideQueued = false;
      if (hspeed > 5.0 && this.slideCooldown <= 0) this._startSlide();
    }

    if (this.sliding) {
      this.slideTime += dt;
      const released = !inp.crouch && this.slideTime > 0.18;
      if (hspeed < MOVE.slideMin || this.slideTime > MOVE.slideDuration || released || (!this.onGround && this.airTime > 0.25)) {
        this._endSlide();
      }
    }

    // --- collider height ---
    const wantCrouch = !frozen && (inp.crouch || this.sliding);
    let targetH = this.sliding ? PLAYER.slideHeight : wantCrouch ? PLAYER.crouchHeight : PLAYER.height;
    if (targetH > this.height + 1e-3 && !w.isFree(this.pos.x, this.pos.y, this.pos.z, this.radius - 0.02, targetH)) {
      targetH = this.height; // no headroom to stand up
    }
    const hRate = targetH < this.height ? 9 : 6;
    const prevH = this.height;
    this.height += Math.sign(targetH - this.height) * Math.min(Math.abs(targetH - this.height), hRate * dt);
    if (!this.onGround && this.height < prevH) {
      // Tucking in the air raises the feet instead of lowering the head (helps mantles).
      const d = prevH - this.height;
      if (w.isFree(this.pos.x, this.pos.y + d, this.pos.z, this.radius, this.height)) this.pos.y += d * 0.5;
    }
    this.crouching = this.height < PLAYER.height - 0.25;

    // --- target speed ---
    this.sprinting = !frozen && inp.sprint && mz > 0.3 && !inp.ads && !this.crouching && !inp.firing;
    let target = MOVE.run;
    if (this.crouching && !this.sliding) target = MOVE.crouch;
    else if (inp.ads) target = MOVE.walk;
    else if (this.sprinting) target = MOVE.sprint;
    target *= (inp.moveMul || 1) * (this.rush ? MOVE.rushSpeedMul : 1);

    // --- jumping, mantles, wall kicks ---
    let jumped = false;
    if (!frozen && this.jumpBuffer > 0) {
      if (this.onGround || this.coyote > 0) {
        const wasSliding = this.sliding;
        if (this.sliding) this._endSlide();
        this.vel.y = JUMP_V * (this.rush ? MOVE.rushJumpMul : 1);
        if (wasSliding) {
          // Slide jump keeps momentum and adds a little pop.
          const k = Math.min(1.06, MOVE.airMaxSpeed / Math.max(hspeed, 1e-3));
          this.vel.x *= k; this.vel.z *= k;
          this.emit('trick', { kind: 'slidejump' });
        }
        this.onGround = false;
        this.coyote = 0;
        this.jumpBuffer = 0;
        this.jumpedAt = this.time;
        jumped = true;
        this.emit('jump', { slide: wasSliding });
      } else if (this.airTime > 0.08) {
        const dir = wishLen > 0.1 ? _wish : _fwd;
        if (this._tryMantle(dir)) { this.jumpBuffer = 0; return; }
        if (!this.wallKickUsed && this._tryWallKick()) { this.jumpBuffer = 0; jumped = true; }
      }
    }
    // Holding jump while pushing into a ledge mantles automatically.
    if (!frozen && !this.onGround && inp.jump && mz > 0.2 && this.vel.y < 3.5 && this.airTime > 0.05) {
      if (this._tryMantle(wishLen > 0.1 ? _wish : _fwd)) return;
    }

    // --- acceleration ---
    hspeed = this.horizontalSpeed();
    const impulseFresh = this.impulseAt !== undefined && this.time - this.impulseAt < 0.06;
    if (this.onGround && !jumped && !impulseFresh) {
      if (this.sliding) {
        let sp = hspeed - (MOVE.slideFriction * 2 + hspeed * 0.25) * dt;
        // Downhill slides keep speed.
        if (this.ground && this.ground.type === 'ramp') {
          const n = this.ground.planeN;
          // Normal leans downhill, so n·v > 0 means sliding down the slope.
          const downhill = (n.x * this.vel.x + n.z * this.vel.z) / Math.max(hspeed, 1e-3);
          sp += downhill * MOVE.gravity * 0.55 * dt;
        }
        sp = Math.max(0, sp);
        if (hspeed > 1e-4) {
          // Light steering while sliding
          let vx = this.vel.x / hspeed, vz = this.vel.z / hspeed;
          if (wishLen > 0.1) {
            vx += _wish.x * 1.8 * dt; vz += _wish.z * 1.8 * dt;
            const l = Math.hypot(vx, vz); vx /= l; vz /= l;
          }
          this.vel.x = vx * sp; this.vel.z = vz * sp;
        }
      } else {
        this._friction(dt, MOVE.groundFriction);
        this._accelerate(_wish, target * wishLen, MOVE.groundAccel, dt);
      }
    } else if (!this.onGround) {
      this._airAccelerate(_wish, target * wishLen, dt);
    }

    // --- gravity & integrate ---
    this.vel.y -= MOVE.gravity * dt;
    if (this.vel.y < -MOVE.maxFallSpeed) this.vel.y = -MOVE.maxFallSpeed;
    _delta.copy(this.vel).multiplyScalar(dt);
    const wasGround = this.onGround;
    const fallSpeed = -this.vel.y;
    const res = w.moveCharacter(this.pos, _delta, this.radius, this.height, {
      stepHeight: MOVE.stepHeight,
      canStep: wasGround || this.airTime < 0.2 || this.sliding,
    });
    if (res.hitCeiling && this.vel.y > 0) this.vel.y = 0;
    if (res.stepped > 0) this.eyeSmooth -= res.stepped;

    if (res.onGround && this.vel.y <= 0.5) {
      this.onGround = true;
      this.ground = res.ground;
      this.vel.y = 0;
    } else if (wasGround && !jumped && this.vel.y <= 0.5 && !impulseFresh) {
      // Ground snap: stick to stairs and ramps going down.
      const g = w.groundHeight(this.pos.x, this.pos.y, this.pos.z, this.radius * 0.8, 0.02, MOVE.stepHeight + 0.15);
      if (g && this.pos.y - g.y <= MOVE.stepHeight + 0.12) {
        this.eyeSmooth += this.pos.y - g.y;
        this.pos.y = g.y;
        this.onGround = true;
        this.ground = g.collider;
        this.vel.y = 0;
      } else this.onGround = false;
    } else {
      this.onGround = res.onGround && this.vel.y <= 0.5;
    }

    if (res.hitWall) {
      const n = res.wallNormal;
      const dot = this.vel.x * n.x + this.vel.z * n.z;
      if (dot < 0) { this.vel.x -= n.x * dot; this.vel.z -= n.z * dot; }
      this.lastWall = n.clone();
      this.lastWallTime = this.time;
    }

    if (this.onGround) {
      if (!wasGround) {
        this.emit('land', { speed: fallSpeed, surface: this.ground?.surface || 'concrete' });
        this.wallKickUsed = false;
        this.airTrickDone = false;
        if (this.slideQueued && inp.crouch && this.horizontalSpeed() > 5) { this.slideQueued = false; this._startSlide(); }
      }
      this.coyote = MOVE.coyoteTime;
      this.airTime = 0;
      this.surface = this.ground?.surface || 'concrete';
    } else {
      this.airTime += dt;
      if (this.airTime > 1.3 && !this.airTrickDone) {
        this.airTrickDone = true;
        this.emit('trick', { kind: 'airtime' });
      }
    }

    // --- jump pads ---
    if (this.padCooldown <= 0) {
      for (const pad of w.jumpPads) {
        const p = this.pos;
        if (p.x > pad.min.x && p.x < pad.max.x && p.z > pad.min.z && p.z < pad.max.z && p.y >= pad.min.y - 0.05 && p.y < pad.max.y) {
          if (this.sliding) this._endSlide();
          this.vel.copy(pad.velocity);
          this.onGround = false;
          this.coyote = 0;
          this.padCooldown = 0.5;
          this.impulseAt = this.time;
          this.lastPadAt = this.time;
          this.emit('jumppad', { pad });
          this.emit('trick', { kind: 'jumppad' });
          break;
        }
      }
    }

    // --- footsteps ---
    if (this.onGround && !this.sliding) {
      const sp = this.horizontalSpeed();
      this.stepDist += sp * dt;
      const stride = this.sprinting ? 2.7 : this.crouching ? 1.5 : 2.15;
      if (this.stepDist > stride) {
        this.stepDist = 0;
        if (sp > 1.0) this.emit('step', { surface: this.surface, loud: !this.crouching && sp > 4, speed: sp });
      }
    }

    // Visual eye smoothing after step-ups.
    this.eyeSmooth *= Math.exp(-16 * dt);
    if (Math.abs(this.eyeSmooth) < 1e-3) this.eyeSmooth = 0;
  }

  _friction(dt, friction) {
    const sp = Math.hypot(this.vel.x, this.vel.z);
    if (sp < 0.02) { this.vel.x = 0; this.vel.z = 0; return; }
    const control = Math.max(sp, 3);
    const ns = Math.max(0, sp - control * friction * dt) / sp;
    this.vel.x *= ns;
    this.vel.z *= ns;
  }

  _accelerate(wish, wishSpeed, accel, dt) {
    if (wishSpeed <= 0) return;
    const cur = this.vel.x * wish.x + this.vel.z * wish.z;
    const add = wishSpeed - cur;
    if (add <= 0) return;
    const acc = Math.min(accel * wishSpeed * dt, add);
    this.vel.x += acc * wish.x;
    this.vel.z += acc * wish.z;
  }

  _airAccelerate(wish, wishSpeed, dt) {
    if (wishSpeed <= 0) return;
    const before = this.horizontalSpeed();
    const ws = Math.min(wishSpeed, MOVE.airWishCap);
    const cur = this.vel.x * wish.x + this.vel.z * wish.z;
    const add = ws - cur;
    if (add <= 0) return;
    const acc = Math.min(MOVE.airAccel * wishSpeed * dt * 4.5, add);
    this.vel.x += acc * wish.x;
    this.vel.z += acc * wish.z;
    const after = this.horizontalSpeed();
    const cap = Math.max(before, MOVE.airMaxSpeed);
    if (after > cap) {
      const k = cap / after;
      this.vel.x *= k; this.vel.z *= k;
    }
  }

  _startSlide() {
    const sp = this.horizontalSpeed();
    let dx, dz;
    if (sp > 0.1) { dx = this.vel.x / sp; dz = this.vel.z / sp; }
    else { dx = -Math.sin(this.yaw); dz = -Math.cos(this.yaw); }
    const ns = Math.max(sp, MOVE.slideBoost);
    this.vel.x = dx * ns;
    this.vel.z = dz * ns;
    this.sliding = true;
    this.slideTime = 0;
    this.emit('slide');
  }

  _endSlide() {
    this.sliding = false;
    this.slideCooldown = MOVE.slideCooldown;
    this.emit('slideEnd');
  }

  _tryMantle(dir) {
    const w = this.world;
    const p = this.pos;
    _probe.set(p.x + dir.x * (this.radius + 0.4), 0, p.z + dir.z * (this.radius + 0.4));
    // Need an obstacle in front at waist height, otherwise there is no ledge to climb.
    if (w.isFree(_probe.x, p.y + 0.15, _probe.z, 0.15, 0.4)) return false;
    const g = w.groundHeight(_probe.x, p.y + MOVE.mantleMax, _probe.z, 0.18, 0.0, MOVE.mantleMax - 0.2);
    if (!g) return false;
    const rise = g.y - p.y;
    if (rise < 0.08 || rise > MOVE.mantleMax) return false;
    const h = PLAYER.crouchHeight;
    if (!w.isFree(p.x, g.y + 0.02, p.z, this.radius * 0.85, h)) return false;
    const tx = p.x + dir.x * (this.radius + 0.55), tz = p.z + dir.z * (this.radius + 0.55);
    if (!w.isFree(tx, g.y + 0.02, tz, this.radius, h)) return false;
    this.mantle = {
      t: 0,
      dur: 0.2 + rise * 0.09,
      from: p.clone(),
      to: new THREE.Vector3(tx, g.y + 0.02, tz),
      dir: dir.clone(),
      speed: Math.max(this.horizontalSpeed(), 3.5),
    };
    if (this.sliding) this._endSlide();
    this.vel.set(0, 0, 0);
    this.height = Math.min(this.height, PLAYER.height);
    this.emit('mantle');
    this.emit('trick', { kind: 'mantle' });
    return true;
  }

  _updateMantle(dt) {
    const m = this.mantle;
    m.t += dt / m.dur;
    const t = Math.min(1, m.t);
    const up = Math.min(1, t / 0.6);
    const fw = Math.max(0, (t - 0.45) / 0.55);
    const eUp = 1 - (1 - up) * (1 - up);
    const eFw = fw * fw * (3 - 2 * fw);
    this.pos.set(
      m.from.x + (m.to.x - m.from.x) * eFw,
      m.from.y + (m.to.y - m.from.y) * eUp,
      m.from.z + (m.to.z - m.from.z) * eFw,
    );
    // Keep a crouch-sized collider during the vault so low ceilings are fine.
    this.height = Math.max(PLAYER.crouchHeight, this.height - dt * 4);
    if (t >= 1) {
      this.mantle = null;
      const sp = Math.min(m.speed, 6.5);
      this.vel.set(m.dir.x * sp, 0, m.dir.z * sp);
      this.onGround = true;
      this.coyote = MOVE.coyoteTime;
      this.airTime = 0;
      this.wallKickUsed = false;
      this.emit('land', { speed: 2, surface: this.ground?.surface || 'concrete' });
    }
  }

  _tryWallKick() {
    const w = this.world;
    let n = null;
    if (this.lastWall && this.time - this.lastWallTime < 0.2) n = this.lastWall;
    else {
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        const dx = Math.cos(a), dz = Math.sin(a);
        if (!w.isFree(this.pos.x + dx * 0.3, this.pos.y + 0.3, this.pos.z + dz * 0.3, this.radius, this.height - 0.6)) {
          n = new THREE.Vector3(-dx, 0, -dz);
          break;
        }
      }
    }
    if (!n) return false;
    const into = this.vel.x * n.x + this.vel.z * n.z;
    if (into < 0) { this.vel.x -= n.x * into; this.vel.z -= n.z * into; }
    this.vel.x += n.x * MOVE.wallKickSpeed;
    this.vel.z += n.z * MOVE.wallKickSpeed;
    this.vel.y = Math.max(this.vel.y, MOVE.wallKickUp);
    this.wallKickUsed = true;
    this.emit('wallkick');
    this.emit('trick', { kind: 'wallkick' });
    return true;
  }
}

/** Ring buffer of past transforms for lag compensation and smooth remote views. */
export class TransformHistory {
  constructor(seconds = 1.0) {
    this.max = Math.ceil(seconds * 160);
    this.buf = [];
  }

  push(t, pos, height, yaw = 0, pitch = 0) {
    const b = this.buf;
    let e;
    if (b.length >= this.max) e = b.shift();
    else e = { t: 0, x: 0, y: 0, z: 0, h: 0, yaw: 0, pitch: 0 };
    e.t = t; e.x = pos.x; e.y = pos.y; e.z = pos.z; e.h = height; e.yaw = yaw; e.pitch = pitch;
    b.push(e);
  }

  clear() { this.buf.length = 0; }

  sample(t, outPos) {
    const b = this.buf;
    if (!b.length) return null;
    if (t >= b[b.length - 1].t) {
      const e = b[b.length - 1];
      outPos.set(e.x, e.y, e.z);
      return e.h;
    }
    if (t <= b[0].t) {
      outPos.set(b[0].x, b[0].y, b[0].z);
      return b[0].h;
    }
    let lo = 0, hi = b.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (b[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = b[lo], c = b[hi];
    const k = (t - a.t) / Math.max(1e-6, c.t - a.t);
    outPos.set(a.x + (c.x - a.x) * k, a.y + (c.y - a.y) * k, a.z + (c.z - a.z) * k);
    return a.h + (c.h - a.h) * k;
  }
}

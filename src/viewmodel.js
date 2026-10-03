// First-person viewmodel: weapon + gloved arms, rendered in its own scene after the world
// with the depth buffer cleared (no clipping into walls) and its own FOV.
// Animation is spring-based and frame-rate independent: ADS alignment (the 'sight' node
// lands on screen center), sway, bob, sprint/slide poses, recoil, reload, switch, melee.
import * as THREE from 'three';
import { buildWeaponModel, getWeapon } from './weapons/index.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _up = new THREE.Vector3(0, 1, 0);

// Per-weapon tuning: ads = eye distance to the sight at full ADS; hip = hip offset tweaks;
// left = left-hand position factor along the weapon (fraction of the front length).
const TUNE = {
  pistol: { ads: 0.3, hip: [0.14, -0.13, -0.3], left: 'pistol', recoil: 1.1 },
  razor: { ads: 0.2, hip: [0.15, -0.155, -0.29], left: 0.48, recoil: 0.8 },
  volt: { ads: 0.2, hip: [0.15, -0.15, -0.27], left: 0.55, recoil: 0.6 },
  crush: { ads: 0.24, hip: [0.155, -0.16, -0.29], left: 0.5, recoil: 1.6 },
  venom: { ads: 0.12, hip: [0.155, -0.165, -0.3], left: 0.42, recoil: 1.2 },
  chaos: { ads: 0.22, hip: [0.17, -0.13, -0.28], left: 0.45, recoil: 1.5 },
  rail: { ads: 0.12, hip: [0.16, -0.165, -0.3], left: 0.45, recoil: 1.4 },
};

function damp(cur, target, lambda, dt) {
  return cur + (target - cur) * (1 - Math.exp(-lambda * dt));
}

class Spring {
  constructor(k = 180, c = 18) { this.x = 0; this.v = 0; this.k = k; this.c = c; }
  step(dt) {
    // semi-implicit Euler, substepped for stiffness
    const n = Math.max(1, Math.ceil(dt / (1 / 240)));
    const h = dt / n;
    for (let i = 0; i < n; i++) {
      this.v += (-this.k * this.x - this.c * this.v) * h;
      this.x += this.v * h;
    }
    return this.x;
  }
}

function flashTexture() {
  const s = 128;
  const c = document.createElement('canvas');
  c.width = c.height = s;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  gr.addColorStop(0, 'rgba(255,255,240,1)');
  gr.addColorStop(0.18, 'rgba(255,230,150,0.95)');
  gr.addColorStop(0.45, 'rgba(255,150,40,0.35)');
  gr.addColorStop(1, 'rgba(255,120,20,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, s, s);
  g.globalCompositeOperation = 'lighter';
  g.strokeStyle = 'rgba(255,240,200,0.9)';
  for (let i = 0; i < 7; i++) {
    const a = (i / 7) * Math.PI * 2 + Math.random() * 0.4;
    const l = s * (0.3 + Math.random() * 0.2);
    g.lineWidth = 2 + Math.random() * 3;
    g.beginPath();
    g.moveTo(s / 2, s / 2);
    g.lineTo(s / 2 + Math.cos(a) * l, s / 2 + Math.sin(a) * l);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function buildArmMaterials(accent) {
  return {
    sleeve: new THREE.MeshStandardMaterial({ color: 0x15181a, roughness: 0.85, metalness: 0.05 }),
    glove: new THREE.MeshStandardMaterial({ color: 0x1d2022, roughness: 0.7, metalness: 0.1 }),
    pad: new THREE.MeshStandardMaterial({ color: 0x2c3134, roughness: 0.45, metalness: 0.5 }),
    accent: new THREE.MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 0.28, roughness: 0.4 }),
  };
}

function buildArm(mats, side) {
  // Origin = palm center; the forearm extends along +Y (aligned later toward the elbow).
  const g = new THREE.Group();
  const hand = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.09, 0.05), mats.glove);
  hand.position.set(0, 0.0, 0);
  g.add(hand);
  const knuckle = new THREE.Mesh(new THREE.BoxGeometry(0.078, 0.03, 0.055), mats.pad);
  knuckle.position.set(0, -0.04, -0.004);
  g.add(knuckle);
  const thumb = new THREE.Mesh(new THREE.CapsuleGeometry(0.012, 0.035, 3, 6), mats.glove);
  thumb.position.set(side * 0.03, -0.01, -0.02);
  thumb.rotation.z = side * 0.6;
  g.add(thumb);
  const forearm = new THREE.Group();
  const fa = new THREE.Mesh(new THREE.CapsuleGeometry(0.038, 0.26, 4, 10), mats.sleeve);
  fa.position.y = 0.19;
  forearm.add(fa);
  const cuff = new THREE.Mesh(new THREE.CylinderGeometry(0.044, 0.042, 0.05, 12), mats.pad);
  cuff.position.y = 0.065;
  forearm.add(cuff);
  const stripe = new THREE.Mesh(new THREE.CylinderGeometry(0.0392, 0.0392, 0.007, 12), mats.accent);
  stripe.position.y = 0.11;
  forearm.add(stripe);
  const guard = new THREE.Mesh(new THREE.BoxGeometry(0.05, 0.16, 0.025), mats.pad);
  guard.position.set(0, 0.22, 0.034);
  forearm.add(guard);
  g.add(forearm);
  g.userData.forearm = forearm;
  for (const m of [hand, knuckle, thumb, fa, cuff, stripe, guard]) { m.frustumCulled = false; m.castShadow = false; }
  return g;
}

export class ViewModel {
  constructor({ scene, camera, accent = 0x7dff1a }) {
    this.scene = scene;
    this.camera = camera;
    if (camera.parent !== scene) scene.add(camera);

    // lights (view-stable, children of the camera)
    this.hemi = new THREE.HemisphereLight(0xdfe8ff, 0x1a1c1c, 1.25);
    this.dir = new THREE.DirectionalLight(0xffffff, 1.7);
    this.dir.position.set(0.6, 1.2, 0.4);
    this.dirTarget = new THREE.Object3D();
    this.dirTarget.position.set(0, -0.2, -1);
    this.dir.target = this.dirTarget;
    this.rim = new THREE.DirectionalLight(0x7dff1a, 0.22);
    this.rim.position.set(-0.8, 0.2, -0.6);
    this.rim.target = this.dirTarget;
    this.muzzleLight = new THREE.PointLight(0xffc870, 0, 1.6, 2);
    camera.add(this.hemi, this.dir, this.dirTarget, this.rim, this.muzzleLight);

    // hierarchy: rig (pose offset) -> kick (recoil) -> holder (weapon + arms)
    this.rig = new THREE.Group();
    this.kick = new THREE.Group();
    this.holder = new THREE.Group();
    this.rig.add(this.kick);
    this.kick.add(this.holder);
    camera.add(this.rig);

    this.mats = buildArmMaterials(new THREE.Color(accent));
    this.armR = buildArm(this.mats, 1);
    this.armL = buildArm(this.mats, -1);
    this.holder.add(this.armR, this.armL);

    // muzzle flash: 3 crossed additive planes
    const ftex = flashTexture();
    this.flashMat = new THREE.MeshBasicMaterial({ map: ftex, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false, color: new THREE.Color(2.2, 2, 1.6), side: THREE.DoubleSide });
    this.flash = new THREE.Group();
    const pg = new THREE.PlaneGeometry(1, 1);
    const face = new THREE.Mesh(pg, this.flashMat);
    const s1 = new THREE.Mesh(pg, this.flashMat);
    s1.rotation.y = Math.PI / 2;
    s1.scale.set(1.8, 0.7, 1);
    s1.position.z = -0.3;
    const s2 = s1.clone();
    s2.rotation.set(Math.PI / 2, 0, Math.PI / 2);
    this.flash.add(face, s1, s2);
    this.flash.traverse((o) => { o.renderOrder = 20; o.frustumCulled = false; });
    this.flash.visible = false;
    this.flashT = 0;

    this.models = new Map();
    this.current = null;
    this.id = null;
    this.visible = true;
    this.raiseT = 1;
    this.time = 0;

    // dynamic state
    this.ads = 0;
    this.swayX = 0; this.swayY = 0; this.swayRX = 0; this.swayRY = 0;
    this.bobPhase = 0;
    this.sprint = 0; this.slide = 0; this.crouch = 0; this.air = 0;
    this.land = new Spring(150, 14);
    this.kz = new Spring(260, 20); // back
    this.kp = new Spring(220, 18); // pitch
    this.kr = new Spring(160, 14); // roll
    this.ky = new Spring(200, 18); // yaw
    this.slideKick = 0;
    this.energyFlash = 0;
    this.rocketHiddenUntil = 0;
    this.dead = 0;
  }

  setAccent(color) {
    const c = new THREE.Color(color);
    this.mats.accent.color.copy(c);
    this.mats.accent.emissive.copy(c);
    this.rim.color.copy(c);
  }

  _get(id) {
    let m = this.models.get(id);
    if (m) return m;
    const model = buildWeaponModel(id, { detail: 'high' });
    model.traverse((o) => {
      if (o.isMesh) { o.frustumCulled = false; o.castShadow = false; o.receiveShadow = false; }
    });
    model.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(model);
    const sight = model.getObjectByName('sight');
    const muzzle = model.getObjectByName('muzzle');
    const sightPos = new THREE.Vector3();
    if (sight) sight.getWorldPosition(sightPos); else sightPos.set(0, 0.08, 0.05);
    const mag = model.getObjectByName('magazine');
    const energy = model.getObjectByName('energy');
    const energyMats = [];
    energy?.traverse((o) => {
      if (o.isMesh && o.material && 'emissiveIntensity' in o.material && !energyMats.includes(o.material)) {
        energyMats.push(o.material);
        o.material.userData.baseEI = o.material.emissiveIntensity;
      }
    });
    const T = TUNE[id] || TUNE.razor;
    // Left hand: under the handguard partway toward the muzzle (or supporting the grip for the pistol).
    let left;
    if (T.left === 'pistol') left = new THREE.Vector3(-0.012, -0.055, 0.02);
    else {
      const zFront = box.min.z;
      left = new THREE.Vector3(0, Math.max(box.min.y + 0.02, -0.02), zFront * T.left);
    }
    m = {
      id, model, box, sightPos, muzzle, sight, mag, magBase: mag ? mag.position.clone() : null, magVis: mag ? mag.visible : true,
      pump: model.getObjectByName('pump'), slideNode: model.getObjectByName('slide'), rocket: model.getObjectByName('rocket'), coil: model.getObjectByName('coil'),
      pumpBase: null, slideBase: null, energyMats, left, def: getWeapon(id), tune: T,
    };
    if (m.pump) m.pumpBase = m.pump.position.clone();
    if (m.slideNode) m.slideBase = m.slideNode.position.clone();
    // hip offset keeps the stock in front of the near plane
    const hipZ = Math.min(T.hip[2], -(box.max.z + 0.06));
    m.hip = new THREE.Vector3(T.hip[0], T.hip[1] - Math.max(0, sightPos.y - 0.06) * 0.6, hipZ);
    m.adsPos = new THREE.Vector3(-sightPos.x, -sightPos.y, -T.ads - sightPos.z);
    this.models.set(id, m);
    return m;
  }

  setWeapon(id, { instant = false } = {}) {
    if (!getWeapon(id)) return;
    const m = this._get(id);
    if (this.current && this.current !== m) this.holder.remove(this.current.model);
    this.current = m;
    this.id = id;
    if (m.model.parent !== this.holder) this.holder.add(m.model);
    m.model.visible = true;
    if (m.mag) { m.mag.position.copy(m.magBase); m.mag.visible = m.magVis; }
    if (m.rocket) m.rocket.visible = true;
    // re-parent muzzle flash
    if (m.muzzle) m.muzzle.add(this.flash);
    else m.model.add(this.flash);
    this.flash.visible = false;
    this._placeArms(m);
    this.raiseT = instant ? 1 : 0;
  }

  _placeArms(m) {
    // Right hand at the grip (origin), forearm toward the lower right behind.
    this._orientArm(this.armR, new THREE.Vector3(0.006, -0.035, 0.03), new THREE.Vector3(0.11, -0.3, 0.32));
    const L = m.left;
    const elbow = m.id === 'pistol' ? new THREE.Vector3(-0.12, -0.3, 0.3) : new THREE.Vector3(-0.17, -0.3, Math.max(0.1, L.z + 0.36));
    this._orientArm(this.armL, L, elbow);
  }

  _orientArm(arm, hand, elbow) {
    arm.position.copy(hand);
    _v.subVectors(elbow, hand).normalize();
    _q.setFromUnitVectors(_up, _v);
    arm.quaternion.copy(_q);
    const len = hand.distanceTo(elbow);
    arm.userData.forearm.scale.y = Math.max(0.6, len / 0.38);
  }

  setVisible(v) {
    this.visible = !!v;
    this.rig.visible = this.visible;
  }

  setLightTint(color) {
    // Blend the arena's local light into the viewmodel hemisphere so guns pick up green neon / red alarms.
    const c = this.hemi.color;
    // Subtle: a hint of the local neon, never a full color cast on the arms.
    c.setRGB(0.62 + color.r * 0.35, 0.64 + color.g * 0.3, 0.66 + color.b * 0.35);
    this.hemi.intensity = 0.9 + Math.min(0.5, (color.r + color.g + color.b) * 0.25);
  }

  get scopeHidden() {
    return !!(this.current?.def.scope && this.ads > 0.88);
  }

  fire(id) {
    const m = this.current;
    if (!m) return;
    const def = getWeapon(id) || m.def;
    const k = (def.recoil?.kick ?? 1) * (m.tune.recoil ?? 1);
    const adsK = 1 - this.ads * 0.55;
    this.kz.v += 1.6 * k * adsK;
    this.kp.v += 6.5 * k * adsK;
    this.kr.v += (Math.random() - 0.5) * 3.5 * k;
    this.ky.v += (Math.random() - 0.5) * 2.5 * k;
    // flash
    const big = def.pellets > 1 || id === 'chaos' || id === 'rail';
    const s = (id === 'pistol' ? 0.14 : id === 'volt' ? 0.16 : big ? 0.3 : 0.2) * (0.85 + Math.random() * 0.3);
    this.flash.scale.setScalar(s);
    this.flash.rotation.z = Math.random() * Math.PI * 2;
    this.flash.visible = !this.scopeHidden;
    this.flashMat.color.setRGB(id === 'rail' ? 1.2 : 2.2, id === 'rail' ? 2.6 : 2.0, id === 'rail' ? 1.0 : 1.5);
    this.flashT = id === 'rail' ? 0.07 : 0.045;
    this.muzzleLight.color.set(id === 'rail' ? 0x9dff3a : 0xffc870);
    this.muzzleLight.intensity = big ? 6 : 3.5;
    if (m.slideNode) this.slideKick = 1;
    this.energyFlash = 1;
    if (id === 'chaos' && m.rocket) { m.rocket.visible = false; this.rocketHiddenUntil = this.time + 0.62; }
  }

  getMuzzleWorldPosition(out) {
    const m = this.current;
    if (!m || !m.muzzle) return this.camera.getWorldPosition(out).add(_v.set(0, -0.1, -0.5).applyQuaternion(this.camera.quaternion));
    m.muzzle.updateWorldMatrix(true, false);
    return m.muzzle.getWorldPosition(out);
  }

  getEjectWorldPosition(out) {
    const m = this.current;
    if (!m) return this.camera.getWorldPosition(out);
    m.model.updateWorldMatrix(true, false);
    out.set(0.035, 0.05, m.box.min.z * 0.22);
    return m.model.localToWorld(out);
  }

  getEjectDirection(out) {
    out.set(1, 0.9, 0.35).normalize().applyQuaternion(this.camera.quaternion);
    return out;
  }

  update(dt, s) {
    const m = this.current;
    if (!m || dt <= 0) return;
    this.time += dt;
    const t = this.time;

    // ADS (eased)
    const adsTarget = s.ads || 0;
    this.ads = adsTarget;
    const a = adsTarget * adsTarget * (3 - 2 * adsTarget);

    // states
    this.sprint = damp(this.sprint, s.sprinting && !s.reloading && s.meleeT < 0 ? 1 : 0, 9, dt);
    this.slide = damp(this.slide, s.sliding ? 1 : 0, 10, dt);
    this.crouch = damp(this.crouch, s.crouch || 0, 8, dt);
    this.air = damp(this.air, s.airborne ? 1 : 0, 6, dt);
    this.dead = damp(this.dead, s.dead ? 1 : 0, 6, dt);
    if (s.landing > 0) this.land.v -= s.landing * 1.4;
    const land = this.land.step(dt);

    // sway (lags behind the mouse)
    const sw = (s.swayScale ?? 1) * (1 - a * 0.85);
    const tx = THREE.MathUtils.clamp(-(s.lookDX || 0) * 0.00035, -0.035, 0.035) * sw;
    const ty = THREE.MathUtils.clamp((s.lookDY || 0) * 0.00035, -0.035, 0.035) * sw;
    this.swayX = damp(this.swayX, tx, 9, dt);
    this.swayY = damp(this.swayY, ty, 9, dt);
    this.swayRY = damp(this.swayRY, tx * 2.2, 8, dt);
    this.swayRX = damp(this.swayRX, ty * 2.2, 8, dt);

    // bob (figure-8), none in the air
    const speed = s.speed || 0;
    if (!s.airborne && speed > 0.3) this.bobPhase += dt * Math.min(speed, 11) * 1.25;
    const bobAmt = Math.min(1, speed / 7) * (s.airborne ? 0 : 1) * (1 - a * 0.85) * (0.4 + (s.bobScale ?? 0.5) * 1.2) * (1 + this.sprint * 0.8);
    const bx = Math.sin(this.bobPhase) * 0.011 * bobAmt;
    const by = -Math.abs(Math.cos(this.bobPhase)) * 0.009 * bobAmt;
    const breathe = Math.sin(t * 1.6) * 0.0018 * (1 - a * 0.7);

    // springs (recoil)
    const kz = this.kz.step(dt), kp = this.kp.step(dt), kr = this.kr.step(dt), ky = this.ky.step(dt);

    // position: hip -> ADS
    const P = this.rig.position;
    P.lerpVectors(m.hip, m.adsPos, a);
    P.x += this.swayX + bx + this.sprint * 0.03 - this.slide * 0.02;
    P.y += this.swayY + by + breathe + land * 0.05 - this.sprint * 0.035 - this.slide * 0.04 - this.crouch * 0.008 * (1 - a) + this.air * 0.006 - this.dead * 0.5;
    P.z += this.sprint * 0.03;
    const R = this.rig.rotation;
    R.set(
      this.swayRX - this.sprint * 0.32 - this.slide * 0.08 + land * 0.15 - this.dead * 0.6,
      this.swayRY + (1 - a) * 0.035 + this.sprint * 0.55,
      -this.slide * 0.32 * (1 - a) + this.sprint * 0.18 + bx * 1.5,
    );

    // recoil group
    this.kick.position.set(0, kp * 0.004, kz * 0.04);
    this.kick.rotation.set(kp * 0.045, ky * 0.02, kr * 0.03);

    // raise / switch
    this.raiseT = s.raising < 1 ? s.raising : damp(this.raiseT, 1, 14, dt);
    const r = Math.min(1, this.raiseT);
    const re = 1 - (1 - r) * (1 - r);
    const H = this.holder;
    H.position.set(0, -(1 - re) * 0.32, (1 - re) * 0.05);
    H.rotation.set((1 - re) * -0.9, 0, (1 - re) * 0.35);

    // reload choreography
    if (s.reloading) this._reloadPose(m, s.reloadT, s.reloadKind);
    else if (m.mag) { m.mag.position.copy(m.magBase); m.mag.visible = m.magVis; }

    // melee
    if (s.meleeT >= 0) {
      const mt = s.meleeT;
      const k = mt < 0.35 ? mt / 0.35 : 1 - (mt - 0.35) / 0.65;
      const e = Math.sin(Math.min(1, k) * Math.PI * 0.5);
      H.position.x -= e * 0.12;
      H.position.z -= e * 0.2;
      H.position.y += e * 0.03;
      H.rotation.y += e * 0.9;
      H.rotation.z -= e * 0.6;
    }

    // shotgun pump, pistol slide
    if (m.pump && m.pumpBase) {
      const pk = s.pump > 0 && s.pump < 1 ? Math.sin(Math.min(1, s.pump * 1.6) * Math.PI) : 0;
      m.pump.position.copy(m.pumpBase);
      m.pump.position.z += pk * 0.075;
      if (pk > 0) H.rotation.x += pk * 0.06;
    }
    if (m.slideNode && m.slideBase) {
      this.slideKick = Math.max(0, this.slideKick - dt * 14);
      m.slideNode.position.copy(m.slideBase);
      m.slideNode.position.z += this.slideKick * 0.028;
    }

    // rocket visibility
    if (m.rocket) {
      const reloadingFirstHalf = s.reloading && s.reloadT < 0.5;
      m.rocket.visible = !reloadingFirstHalf && t >= this.rocketHiddenUntil;
    }

    // rail coils + energy lines
    this.energyFlash = Math.max(0, this.energyFlash - dt * 6);
    const rushPulse = s.rush ? 0.6 + 0.4 * Math.sin(t * 9) : 0;
    const charge = m.id === 'rail' ? s.railCharge ?? 1 : 1;
    const readyPulse = m.id === 'rail' && charge >= 0.999 ? 0.25 * Math.sin(t * 6) : 0;
    for (const mat of m.energyMats) {
      const base = mat.userData.baseEI ?? 2;
      mat.emissiveIntensity = base * 0.6 * (0.35 + 0.65 * charge + this.energyFlash * 1.5 + rushPulse + readyPulse);
    }
    if (m.coil) m.coil.rotation.z += dt * (2 + charge * 10);

    // muzzle flash timing
    if (this.flashT > 0) {
      this.flashT -= dt;
      if (this.flashT <= 0) this.flash.visible = false;
    }
    this.muzzleLight.intensity = Math.max(0, this.muzzleLight.intensity - dt * 90);
    if (this.muzzleLight.intensity > 0 && m.muzzle) {
      m.muzzle.updateWorldMatrix(true, false);
      m.muzzle.getWorldPosition(_v);
      this.camera.worldToLocal(_v);
      this.muzzleLight.position.copy(_v);
    }

    // hide under a scope
    m.model.visible = !this.scopeHidden;
    this.armL.visible = this.armR.visible = !this.scopeHidden;
  }

  _reloadPose(m, rt, kind) {
    const H = this.holder;
    const tIn = Math.min(1, rt / 0.18);
    const tOut = Math.max(0, (rt - 0.82) / 0.18);
    const tilt = Math.sin(Math.min(1, tIn) * Math.PI * 0.5) * (1 - tOut * tOut);
    if (kind === 'shell') {
      const k = Math.sin(rt * Math.PI);
      H.rotation.z += 0.32;
      H.rotation.x += 0.12;
      H.position.y -= 0.02 + k * 0.025;
      H.position.x -= 0.02;
      return;
    }
    H.rotation.z += tilt * 0.55;
    H.rotation.x += tilt * 0.22;
    H.position.y -= tilt * 0.04;
    H.position.x -= tilt * 0.03;
    if (m.mag && m.magBase) {
      // out: 0.2-0.42, gone, in: 0.5-0.72, seat bump 0.72-0.8
      let off = 0;
      if (rt < 0.2) off = 0;
      else if (rt < 0.42) off = ((rt - 0.2) / 0.22) ** 2 * 0.3;
      else if (rt < 0.5) off = 0.3;
      else if (rt < 0.72) off = 0.3 * (1 - (rt - 0.5) / 0.22);
      else off = 0;
      m.mag.position.copy(m.magBase);
      m.mag.position.y -= off;
      m.mag.position.z += off * 0.25;
      m.mag.visible = m.magVis && off < 0.28;
    }
    if (rt > 0.76 && rt < 0.9) {
      const b = Math.sin(((rt - 0.76) / 0.14) * Math.PI);
      H.position.z += b * 0.02;
      H.rotation.x -= b * 0.05;
    }
  }
}

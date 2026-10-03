// MONSTER-X: DUEL ARENA - procedural third-person player character.
//
// Built entirely from Three.js primitives: a moto/extreme-sports rider in tactical armor
// (full-face helmet with chin bar + peak + goggle visor, roost deflector, shoulder cups,
// elbow/knee guards, padded gloves, moto boots, glowing energy canister backpack).
// Matte darks with emissive accent strips plus an accent-tinted fresnel rim so the
// silhouette reads at distance in a dark arena.
//
// Conventions: root origin = between the feet, +Y up, faces -Z at yaw 0 (root.rotation.y = yaw).
//
// Rig: every body part is a flat child of `rig` whose matrix is written each frame, either by
// the procedural animator (FK torso + analytic two-bone IK limbs) or by the verlet ragdoll.
// Both feed from the same joint set, so switching to the ragdoll needs no reparenting.
//
// Optional weapon hints (both optional): weaponGroup.userData.supportGrip = [x,y,z] or a
// descendant named 'support' / 'foregrip' marks where the left hand holds the weapon.

import {
  AdditiveBlending,
  BoxGeometry,
  BufferAttribute,
  CapsuleGeometry,
  Color,
  CylinderGeometry,
  Euler,
  ExtrudeGeometry,
  Group,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Quaternion,
  ShaderMaterial,
  Shape,
  SphereGeometry,
  TorusGeometry,
  Vector2,
  Vector3,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { PALETTE, PLAYER, WEAPON_BY_ID } from './config.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TAU = Math.PI * 2;
const BASE_SCALE = (PLAYER && PLAYER.height ? PLAYER.height : 1.8) / 1.8;
const RAG_SETTLE = 3.5; // seconds before the corpse starts fading
const RAG_FADE = 0.8;
const SPAWN_FX = 0.6;
const GRAVITY = 20;

const DETAIL = {
  low: { rad: 6, sph: 8, sphH: 6, tor: 8, tube: 3, cap: 1, bev: 1, curve: 1 },
  medium: { rad: 9, sph: 11, sphH: 8, tor: 12, tube: 4, cap: 2, bev: 1, curve: 2 },
  high: { rad: 12, sph: 14, sphH: 10, tor: 16, tube: 4, cap: 3, bev: 1, curve: 3 },
};

// Skeleton lengths (metres, unscaled; model is authored for a 1.80 m player).
const SK = { pelvisY: 0.95, spine: 0.12, chest: 0.2, neck: 0.23, head: 0.12, upperArm: 0.31, forearm: 0.27, thigh: 0.43, shin: 0.42, ankle: 0.085 };

const V = (x, y, z) => new Vector3(x, y, z);
const ONE = V(1, 1, 1);
const HIP_L = V(-0.1, -0.03, 0);
const HIP_R = V(0.1, -0.03, 0);
const AIM_PIVOT = V(0, 0.17, -0.02); // chest space
const WRIST_R = V(0.004, -0.04, 0.06); // hand space -> forearm end
const WRIST_L = V(-0.004, -0.04, 0.06);
const CHEST_PT = V(0, 0.1, -0.1); // ragdoll sternum particle (chest space)
const BACK_PT = V(0, 0.05, 0.2); // ragdoll backpack particle (chest space)
const PELVIS_PT = V(0, 0.03, -0.07); // pelvis space
// Right-hand grip placement in the aim frame.
const GRIP_HIP = V(0.13, -0.13, -0.24);
const GRIP_ADS = V(0.075, 0.075, -0.25);
const GRIP_SPRINT = V(0.05, -0.2, -0.16);
const GRIP_RELOAD = V(-0.04, -0.03, 0.05);
// Ankle targets in rig space, [left, right].
const FOOT_STAND = [V(-0.12, SK.ankle, -0.04), V(0.13, SK.ankle, 0.07)];
const FOOT_KNEEL = [V(-0.15, SK.ankle, -0.25), V(0.16, SK.ankle + 0.1, 0.27)];
const FOOT_CWALK = [V(-0.16, SK.ankle, -0.07), V(0.16, SK.ankle, 0.06)];
const FOOT_RISE = [V(-0.12, 0.4, -0.14), V(0.13, 0.3, 0.08)];
const FOOT_FALL = [V(-0.16, 0.13, -0.24), V(0.17, 0.2, 0.22)];
const FOOT_SLIDE = [V(-0.08, 0.125, -0.76), V(0.17, 0.085, -0.14)];
const SLIDE_POLE = [V(0, 1, -0.25), V(0.35, 0.85, -0.4)];
// Left-hand support point in weapon (right-hand) space, per weapon.
const SUPPORT = {
  pistol: [-0.03, -0.035, -0.02],
  razor: [0, -0.035, -0.19],
  volt: [0, -0.035, -0.22],
  crush: [0, -0.04, -0.25],
  venom: [0, -0.035, -0.22],
  chaos: [0, -0.03, -0.25],
  rail: [0, -0.035, -0.25],
  default: [0, -0.035, -0.22],
};

const PART_GEO = {
  pelvis: 'pelvis', torso: 'torso', head: 'head',
  upperArmL: 'upperArm', upperArmR: 'upperArm', forearmL: 'forearm', forearmR: 'forearm',
  handL: 'handL', handR: 'handR', thighL: 'thighL', thighR: 'thighR',
  shinL: 'shinL', shinR: 'shinR', footL: 'footL', footR: 'footR',
};
const PART_NAMES = Object.keys(PART_GEO);

// Ragdoll particles.
const HEAD = 0, CHEST = 1, PELV = 2, SHL = 3, SHR = 4, ELL = 5, ELR = 6, HAL = 7, HAR = 8;
const HIL = 9, HIR = 10, KNL = 11, KNR = 12, FTL = 13, FTR = 14, BACK = 15;
const NP = 16;
const P_RADIUS = [0.17, 0.12, 0.12, 0.09, 0.09, 0.06, 0.06, 0.06, 0.06, 0.09, 0.09, 0.07, 0.07, 0.07, 0.07, 0.09];
const P_INVMASS = [1.2, 0.7, 0.6, 0.9, 0.9, 1.4, 1.4, 1.8, 1.8, 0.9, 0.9, 1.3, 1.3, 1.6, 1.6, 0.9];
const P_IMPULSE = [1.35, 1.2, 0.9, 1.15, 1.15, 1.1, 1.1, 1.05, 1.05, 0.85, 0.85, 0.6, 0.6, 0.45, 0.45, 1.1];
const C_RIGID = [
  [HEAD, CHEST], [CHEST, SHL], [CHEST, SHR], [SHL, SHR], [CHEST, PELV], [PELV, HIL], [PELV, HIR], [HIL, HIR],
  [SHL, HIL], [SHR, HIR], [SHL, HIR], [SHR, HIL], [CHEST, HIL], [CHEST, HIR], [PELV, SHL], [PELV, SHR],
  [BACK, SHL], [BACK, SHR], [BACK, CHEST], [BACK, PELV], [BACK, HIL], [BACK, HIR],
  [SHL, ELL], [ELL, HAL], [SHR, ELR], [ELR, HAR], [HIL, KNL], [KNL, FTL], [HIR, KNR], [KNR, FTR],
];
const C_RANGE = [[HEAD, SHL, 0.85, 1.12], [HEAD, SHR, 0.85, 1.12], [HEAD, PELV, 0.92, 1.04], [HEAD, BACK, 0.88, 1.1]];
// Angle limits approximated by minimum distances (metres).
const C_MIN = [
  [SHL, HAL, 0.2], [SHR, HAR, 0.2], [HIL, FTL, 0.32], [HIR, FTR, 0.32], [KNL, KNR, 0.13], [FTL, FTR, 0.12],
  [HAL, HAR, 0.06], [HAL, CHEST, 0.1], [HAR, CHEST, 0.1], [HAL, PELV, 0.12], [HAR, PELV, 0.12],
  [FTL, PELV, 0.3], [FTR, PELV, 0.3], [ELL, HIL, 0.12], [ELR, HIR, 0.12], [HEAD, HAL, 0.15], [HEAD, HAR, 0.15],
  [KNL, CHEST, 0.25], [KNR, CHEST, 0.25],
];
const RAG_LIMB = {
  upperArmL: [SHL, ELL, SHL], forearmL: [ELL, HAL, ELL], handL: [ELL, HAL, HAL],
  upperArmR: [SHR, ELR, SHR], forearmR: [ELR, HAR, ELR], handR: [ELR, HAR, HAR],
  thighL: [HIL, KNL, HIL], shinL: [KNL, FTL, KNL], footL: [KNL, FTL, FTL],
  thighR: [HIR, KNR, HIR], shinR: [KNR, FTR, KNR], footR: [KNR, FTR, FTR],
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };
const damp = (cur, target, rate, dt) => cur + (target - cur) * (1 - Math.exp(-rate * dt));
const hash1 = (n) => { const s = Math.sin(n * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };

/** Critically damped spring (exact integration, stable for any dt). */
class Spring {
  constructor() { this.x = 0; this.v = 0; }
  step(dt, w) {
    const e = Math.exp(-w * dt);
    const c = this.v + w * this.x;
    this.x = (this.x + c * dt) * e;
    this.v = (this.v - w * c * dt) * e;
  }
  reset() { this.x = 0; this.v = 0; }
}

// Module-level scratch objects (single-threaded, never held across calls).
const _v1 = new Vector3(), _v2 = new Vector3(), _v3 = new Vector3(), _v4 = new Vector3(), _v5 = new Vector3();
const _q1 = new Quaternion(), _q2 = new Quaternion(), _qChest = new Quaternion(), _qHead = new Quaternion();
const _e = new Euler();
const _mTmp = new Matrix4(), _mPelvis = new Matrix4(), _mSpine = new Matrix4(), _mChest = new Matrix4();
const _mHead = new Matrix4(), _mAim = new Matrix4(), _mHandR = new Matrix4(), _mHandL = new Matrix4();
const _pole = new Vector3(), _shL = new Vector3(), _shR = new Vector3(), _wL = new Vector3(), _wR = new Vector3();
const _hip = new Vector3(), _foot = new Vector3();
const _ikD = new Vector3(), _ikMid = new Vector3(), _ikEnd = new Vector3(), _ikBend = new Vector3();
const _lmX = new Vector3(), _lmY = new Vector3(), _lmZ = new Vector3();
const _rUp = new Vector3(), _rRt = new Vector3(), _rBk = new Vector3(), _rMS = new Vector3(), _rMH = new Vector3();
const _rX = new Vector3(), _rY = new Vector3(), _rZ = new Vector3(), _rW = new Vector3();
const _rd = new Vector3(), _rn = new Vector3(), _rv = new Vector3(), _rTmp = new Vector3(), _rFwd = new Vector3();
const _mF = new Matrix4(), _mInv = new Matrix4();
const _rp1 = new Vector3(), _rp2 = new Vector3();
const _c1 = new Color();
const WHITE = new Color(1, 1, 1);
const HIT_RED = new Color(PALETTE.warnRed);

// ---------------------------------------------------------------------------
// Geometry (shared per detail level, merged per part + material)
// ---------------------------------------------------------------------------

class GeoBuilder {
  constructor() { this.buckets = new Map(); }
  add(mat, geo) {
    let g = geo;
    if (g.index) { g = geo.toNonIndexed(); geo.dispose(); }
    for (const name of Object.keys(g.attributes)) {
      if (name !== 'position' && name !== 'normal' && name !== 'uv') g.deleteAttribute(name);
    }
    if (!g.attributes.uv) g.setAttribute('uv', new BufferAttribute(new Float32Array(g.attributes.position.count * 2), 2));
    g.clearGroups();
    if (!this.buckets.has(mat)) this.buckets.set(mat, []);
    this.buckets.get(mat).push(g);
    return this;
  }
  build() {
    const out = {};
    for (const [mat, list] of this.buckets) {
      const merged = list.length === 1 ? list[0] : mergeGeometries(list, false);
      if (list.length > 1) list.forEach((g) => g.dispose());
      merged.computeBoundingSphere();
      merged.computeBoundingBox();
      out[mat] = merged;
    }
    return out;
  }
}

function shapeFrom(pts) {
  const s = new Shape();
  s.moveTo(pts[0][0], pts[0][1]);
  for (let i = 1; i < pts.length; i++) s.lineTo(pts[i][0], pts[i][1]);
  s.closePath();
  return s;
}

function roundedRect(w, h, r) {
  const s = new Shape(), x = -w / 2, y = -h / 2;
  s.moveTo(x + r, y);
  s.lineTo(x + w - r, y); s.quadraticCurveTo(x + w, y, x + w, y + r);
  s.lineTo(x + w, y + h - r); s.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  s.lineTo(x + r, y + h); s.quadraticCurveTo(x, y + h, x, y + h - r);
  s.lineTo(x, y + r); s.quadraticCurveTo(x, y, x + r, y);
  return s;
}

/** Extrude a shape along +Z, centred on z = 0. */
function extrude(shape, depth, bevel, D, curve = D.curve) {
  const g = new ExtrudeGeometry(shape, {
    depth, steps: 1, curveSegments: curve,
    bevelEnabled: bevel > 0, bevelThickness: bevel, bevelSize: bevel * 0.8, bevelSegments: D.bev,
  });
  g.translate(0, 0, -depth / 2);
  return g;
}

/** Side-view profile (forward, up) extruded across X; forward maps to -Z. */
function profileX(pts, width, bevel, D) {
  return extrude(shapeFrom(pts), width, bevel, D).rotateY(Math.PI / 2);
}

const hemi = (r, D) => new SphereGeometry(r, D.sph, Math.max(3, D.sphH >> 1), 0, TAU, 0, Math.PI / 2);
/** Open partial cylinder covering the front (-Z) arc of +-half radians. */
const frontShell = (rt, rb, h, half, D) => new CylinderGeometry(rt, rb, h, Math.max(4, D.rad >> 1), 1, true, Math.PI - half, half * 2);

function buildHead(D) {
  const b = new GeoBuilder();
  b.add('black', new SphereGeometry(0.165, D.sph + 2, D.sphH).scale(1, 1.05, 1.12).translate(0, 0.01, 0.012));
  // Chin bar wrapping the jaw + protruding beak.
  b.add('armor', new TorusGeometry(0.128, 0.042, D.tube + 2, D.tor, Math.PI).rotateX(-Math.PI / 2).scale(1, 1, 1.3).translate(0, -0.085, -0.015));
  b.add('black', profileX([[0, 0.03], [0.07, 0], [0.08, -0.035], [0.045, -0.06], [0, -0.05]], 0.1, 0.006, D).translate(0, -0.085, -0.18));
  for (const s of [-1, 1]) b.add('accent', new BoxGeometry(0.014, 0.026, 0.006).rotateX(-0.28).translate(s * 0.024, -0.1, -0.266));
  // Goggle visor, frame bands and the accent goggle strap round the back.
  b.add('visor', new CylinderGeometry(0.171, 0.166, 0.072, D.rad, 1, true, Math.PI - 1.15, 2.3).scale(1, 1, 1.13).translate(0, 0.005, 0.012));
  for (const y of [0.043, -0.033]) b.add('armor', new CylinderGeometry(0.176, 0.174, 0.012, D.rad, 1, true, Math.PI - 1.2, 2.4).scale(1, 1, 1.13).translate(0, y, 0.012));
  b.add('accent', new CylinderGeometry(0.17, 0.168, 0.03, D.rad, 1, true, -1.35, 2.7).scale(1, 1, 1.12).translate(0, 0.005, 0.012));
  // Peak / visor brim with centre stripe.
  const brim = shapeFrom([[-0.115, 0], [0.115, 0], [0.095, 0.1], [0.05, 0.145], [-0.05, 0.145], [-0.095, 0.1]]);
  b.add('armor', extrude(brim, 0.012, 0.004, D).rotateX(-Math.PI / 2).rotateX(0.32).translate(0, 0.1, -0.1));
  b.add('accent', new BoxGeometry(0.014, 0.006, 0.12).translate(0, 0.013, -0.07).rotateX(0.32).translate(0, 0.1, -0.1));
  // Twin racing stripes over the crown, ear vents, rear vents, neck roll.
  for (const s of [-1, 1]) {
    b.add('accent', new TorusGeometry(0.164, 0.0065, 3, Math.max(8, D.tor - 4), Math.PI - 0.8).rotateZ(0.6).rotateY(Math.PI / 2).scale(1, 1.05, 1.12).translate(s * 0.035, 0.01, 0.012));
    b.add('accent', new BoxGeometry(0.008, 0.022, 0.06).translate(s * 0.162, -0.035, 0.0));
    b.add('accent', new BoxGeometry(0.03, 0.012, 0.01).translate(s * 0.03, -0.06, 0.183));
  }
  b.add('black', new TorusGeometry(0.118, 0.028, 3, D.tor).rotateX(Math.PI / 2).scale(1, 1, 1.1).translate(0, -0.13, 0.02));
  return b.build();
}

function buildTorso(D) {
  const b = new GeoBuilder();
  b.add('jersey', new CapsuleGeometry(0.15, 0.2, D.cap, D.rad).scale(1.22, 1, 0.78).translate(0, 0.03, 0.01));
  b.add('jersey', new CapsuleGeometry(0.075, 0.28, D.cap, D.rad).rotateZ(Math.PI / 2).scale(1, 1, 0.9).translate(0, 0.165, 0.02));
  b.add('jersey', new CylinderGeometry(0.056, 0.062, 0.16, D.rad).translate(0, 0.29, 0));
  // Neck brace with struts.
  b.add('armor', new TorusGeometry(0.105, 0.03, D.tube, D.tor).rotateX(Math.PI / 2).scale(1, 1, 0.92).translate(0, 0.225, 0.005));
  b.add('armor', new BoxGeometry(0.05, 0.12, 0.025).rotateX(-0.35).translate(0, 0.165, -0.115));
  b.add('armor', new BoxGeometry(0.06, 0.15, 0.025).rotateX(0.25).translate(0, 0.15, 0.115));
  // Roost deflector: angled pec plates, sternum ridge, V accents, ab plates, back plate.
  const pec = [[0, 0.11], [0.115, 0.1], [0.145, 0.02], [0.125, -0.07], [0.04, -0.11], [0, -0.08]];
  for (const s of [-1, 1]) {
    b.add('armor', extrude(shapeFrom(pec.map(([x, y]) => [x * s, y])), 0.022, 0.008, D).rotateY(-0.38 * s).translate(0.012 * s, 0.07, -0.128));
    b.add('accent', new BoxGeometry(0.09, 0.01, 0.008).rotateZ(0.44 * s).translate(0.0825 * s, -0.085, -0.022).rotateY(-0.38 * s).translate(0.012 * s, 0.07, -0.128));
    b.add('accent', new BoxGeometry(0.01, 0.24, 0.04).translate(0.185 * s, 0, 0.01));
  }
  b.add('armor', new BoxGeometry(0.045, 0.2, 0.03).translate(0, 0.05, -0.142));
  b.add('accent', new BoxGeometry(0.012, 0.18, 0.008).translate(0, 0.05, -0.16));
  b.add('armor', extrude(roundedRect(0.2, 0.05, 0.014), 0.018, 0.005, D, 1).translate(0, -0.095, -0.122));
  b.add('armor', extrude(roundedRect(0.18, 0.05, 0.014), 0.018, 0.005, D, 1).translate(0, -0.16, -0.112));
  b.add('armor', extrude(shapeFrom([[-0.13, 0.15], [0.13, 0.15], [0.15, 0.02], [0.1, -0.16], [-0.1, -0.16], [-0.15, 0.02]]), 0.022, 0.008, D).translate(0, 0.05, 0.14));
  // Layered shoulder cups with glowing rims.
  for (const s of [-1, 1]) {
    b.add('armor', hemi(0.095, D).scale(1, 0.72, 1.18).rotateZ(-0.55 * s).translate(0.178 * s, 0.19, 0.02));
    b.add('armor', hemi(0.075, D).scale(1, 0.7, 1.12).rotateZ(-1.0 * s).translate(0.222 * s, 0.12, 0.02));
    b.add('accent', new TorusGeometry(0.094, 0.008, 3, Math.max(8, (D.tor * 0.75) | 0)).rotateX(Math.PI / 2).scale(1, 1, 1.18).rotateZ(-0.55 * s).translate(0.178 * s, 0.19, 0.02));
  }
  // Energy canister backpack.
  b.add('black', extrude(roundedRect(0.22, 0.3, 0.03), 0.06, 0.01, D).translate(0, 0.04, 0.178));
  for (const s of [-1, 1]) {
    const cx = 0.062 * s, cz = 0.235;
    b.add('core', new CylinderGeometry(0.03, 0.03, 0.22, D.rad).translate(cx, 0.04, cz));
    b.add('steel', new CylinderGeometry(0.045, 0.045, 0.03, D.rad).translate(cx, 0.165, cz));
    b.add('steel', new CylinderGeometry(0.045, 0.045, 0.03, D.rad).translate(cx, -0.085, cz));
    for (const y of [-0.03, 0.04, 0.11]) b.add('armor', new TorusGeometry(0.037, 0.007, 3, Math.max(6, D.rad >> 1)).rotateX(Math.PI / 2).translate(cx, y, cz));
    for (let k = 0; k < 3; k++) {
      const a = (k / 3) * TAU + 0.5;
      b.add('armor', new BoxGeometry(0.008, 0.22, 0.008).translate(cx + Math.cos(a) * 0.038, 0.04, cz + Math.sin(a) * 0.038));
    }
  }
  for (const y of [0.0, 0.06, 0.12]) b.add('accent', new BoxGeometry(0.02, 0.03, 0.012).translate(0, y, 0.215));
  return b.build();
}

function buildPelvis(D) {
  const b = new GeoBuilder();
  b.add('jersey', new CapsuleGeometry(0.13, 0.12, D.cap, D.rad).scale(1.2, 1, 0.8).translate(0, 0.15, 0.01));
  b.add('armor', new CylinderGeometry(0.162, 0.162, 0.07, D.rad).scale(1.04, 1, 0.78).translate(0, 0.03, 0));
  b.add('accent', new CylinderGeometry(0.166, 0.166, 0.012, D.rad, 1, true).scale(1.04, 1, 0.78).translate(0, 0.052, 0));
  b.add('steel', new BoxGeometry(0.075, 0.05, 0.02).translate(0, 0.03, -0.13));
  b.add('jersey', new SphereGeometry(0.19, D.sph, Math.max(4, D.sphH - 3)).scale(1, 0.7, 0.75).translate(0, -0.04, 0.01));
  for (const s of [-1, 1]) {
    b.add('armor', extrude(roundedRect(0.1, 0.12, 0.025), 0.02, 0.006, D, Math.min(2, D.curve)).rotateY((Math.PI / 2) * s).translate(0.188 * s, -0.04, 0));
    b.add('black', new BoxGeometry(0.06, 0.07, 0.04).translate(0.085 * s, 0, 0.14));
  }
  return b.build();
}

// Limb parts: bone runs along local -Y from the joint; local -Z faces the bend/pole side
// (knee front, elbow point).
function buildUpperArm(D) {
  const b = new GeoBuilder();
  b.add('jersey', new CapsuleGeometry(0.056, 0.2, D.cap, D.rad).translate(0, -0.15, 0));
  b.add('accent', new BoxGeometry(0.014, 0.17, 0.01).translate(0, -0.16, -0.055));
  return b.build();
}

function buildForearm(D) {
  const b = new GeoBuilder();
  b.add('jersey', new CylinderGeometry(0.05, 0.042, 0.22, D.rad).translate(0, -0.13, 0));
  b.add('armor', hemi(0.062, D).rotateX(-Math.PI / 2).scale(1, 1.25, 0.8).translate(0, -0.015, -0.012));
  b.add('black', new TorusGeometry(0.05, 0.009, 3, Math.max(6, D.rad - 2)).rotateX(Math.PI / 2).translate(0, -0.075, 0));
  b.add('armor', frontShell(0.056, 0.05, 0.13, 1.2, D).translate(0, -0.15, 0));
  b.add('accent', new BoxGeometry(0.012, 0.11, 0.008).translate(0, -0.15, -0.056));
  b.add('black', new CylinderGeometry(0.054, 0.056, 0.06, D.rad).translate(0, -0.25, 0));
  return b.build();
}

/** Padded glove; origin at the grip point, weapon frame (-Z forward). s = +1 right, -1 left. */
function buildHand(D, s) {
  const b = new GeoBuilder();
  b.add('black', new SphereGeometry(1, Math.max(6, D.sph >> 1), Math.max(4, D.sphH >> 1)).scale(0.043, 0.056, 0.05).translate(0.01 * s, -0.022, 0.012));
  b.add('armor', new BoxGeometry(0.02, 0.07, 0.055).translate(0.042 * s, -0.02, -0.01));
  b.add('accent', new BoxGeometry(0.006, 0.055, 0.01).translate(0.053 * s, -0.02, -0.01));
  b.add('black', new CapsuleGeometry(0.014, 0.03, 2, 6).rotateX(0.9).translate(-0.028 * s, 0.012, -0.02));
  return b.build();
}

function buildThigh(D, s) {
  const b = new GeoBuilder();
  b.add('jersey', new CapsuleGeometry(0.08, 0.27, D.cap, D.rad).translate(0, -0.2, 0));
  b.add('armor', frontShell(0.088, 0.082, 0.17, 1.0, D).translate(0, -0.17, 0));
  b.add('accent', new BoxGeometry(0.012, 0.24, 0.016).translate(0.08 * s, -0.2, 0));
  return b.build();
}

function buildShin(D, s) {
  const b = new GeoBuilder();
  b.add('jersey', new CapsuleGeometry(0.058, 0.22, D.cap, D.rad).translate(0, -0.14, 0));
  b.add('black', new CylinderGeometry(0.074, 0.066, 0.3, D.rad).translate(0, -0.27, 0));
  // Knee guard + cap plate + stripe.
  b.add('armor', hemi(0.07, D).rotateX(-Math.PI / 2).scale(1, 1.3, 0.85).translate(0, -0.01, -0.02));
  b.add('black', extrude(roundedRect(0.085, 0.11, 0.025), 0.016, 0.005, D, Math.min(2, D.curve)).translate(0, -0.03, -0.085));
  b.add('accent', new BoxGeometry(0.075, 0.012, 0.008).translate(0, -0.03, -0.1));
  // Boot shaft shin plate + stripe + outer buckles.
  b.add('armor', frontShell(0.082, 0.074, 0.24, 1.05, D).translate(0, -0.25, 0));
  b.add('accent', new BoxGeometry(0.014, 0.2, 0.008).translate(0, -0.25, -0.08));
  for (const y of [-0.17, -0.26, -0.35]) b.add('steel', new BoxGeometry(0.018, 0.014, 0.1).translate(0.07 * s, y, 0));
  return b.build();
}

/** Moto boot; origin at the ankle, -Z = toe, sole bottom at y = -ankle. */
function buildFoot(D, s) {
  const b = new GeoBuilder();
  b.add('black', profileX([[-0.075, 0.045], [-0.085, -0.06], [0.165, -0.06], [0.19, -0.035], [0.16, 0], [0.06, 0.035]], 0.11, 0.01, D));
  b.add('jersey', new BoxGeometry(0.125, 0.025, 0.29).translate(0, -0.072, -0.05));
  b.add('armor', new BoxGeometry(0.118, 0.045, 0.06).translate(0, -0.04, -0.15));
  b.add('armor', new BoxGeometry(0.11, 0.07, 0.04).translate(0, -0.02, 0.07));
  b.add('accent', new BoxGeometry(0.006, 0.012, 0.16).translate(0.064 * s, -0.045, -0.04));
  b.add('black', new CylinderGeometry(0.068, 0.07, 0.08, D.rad).translate(0, 0, 0));
  return b.build();
}

const GEO_CACHE = new Map();
function getGeometrySet(detail) {
  let set = GEO_CACHE.get(detail);
  if (!set) {
    const D = DETAIL[detail];
    set = {
      head: buildHead(D), torso: buildTorso(D), pelvis: buildPelvis(D),
      upperArm: buildUpperArm(D), forearm: buildForearm(D),
      handL: buildHand(D, -1), handR: buildHand(D, 1),
      thighL: buildThigh(D, -1), thighR: buildThigh(D, 1),
      shinL: buildShin(D, -1), shinR: buildShin(D, 1),
      footL: buildFoot(D, -1), footR: buildFoot(D, 1),
    };
    GEO_CACHE.set(detail, set);
  }
  return set;
}

// ---------------------------------------------------------------------------
// Materials: MeshStandardMaterial + fresnel rim, hit flash, materialize sweep, dissolve.
// ---------------------------------------------------------------------------

const RIM_FRAG_HEAD = /* glsl */ `#include <common>
uniform vec3 rimColor;
uniform float rimStrength;
uniform vec3 mxFlashColor;
uniform float mxFlash;
uniform float mxSweep;
uniform float mxBaseY;
uniform float mxFade;
uniform vec3 mxGlowColor;
varying vec3 vMxWorld;
float mxHash(vec3 p) {
  p = fract(p * 0.3183099 + vec3(0.11, 0.17, 0.13));
  p *= 17.0;
  return fract(p.x * p.y * p.z * (p.x + p.y + p.z));
}
float mxNoise(vec3 x) {
  vec3 i = floor(x);
  vec3 f = fract(x);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(mix(mxHash(i), mxHash(i + vec3(1.0, 0.0, 0.0)), f.x),
                 mix(mxHash(i + vec3(0.0, 1.0, 0.0)), mxHash(i + vec3(1.0, 1.0, 0.0)), f.x), f.y),
             mix(mix(mxHash(i + vec3(0.0, 0.0, 1.0)), mxHash(i + vec3(1.0, 0.0, 1.0)), f.x),
                 mix(mxHash(i + vec3(0.0, 1.0, 1.0)), mxHash(i + vec3(1.0, 1.0, 1.0)), f.x), f.y), f.z);
}`;

const RIM_FRAG_BODY = /* glsl */ `#include <emissivemap_fragment>
{
  vec3 mxV = normalize(vViewPosition);
  float mxFres = 1.0 - clamp(dot(normal, mxV), 0.0, 1.0);
  mxFres *= mxFres;
  totalEmissiveRadiance += rimColor * (rimStrength * mxFres * mxFres);
  totalEmissiveRadiance += mxFlashColor * mxFlash;
  float mxEdge = 0.0;
  if (mxSweep > -0.5) {
    float mxD = (vMxWorld.y - mxBaseY) - mxSweep;
    if (mxD > 0.0) discard;
    mxEdge = 1.0 - smoothstep(0.0, 0.16, -mxD);
    mxEdge += 0.4 * step(0.55, fract(vMxWorld.y * 36.0)) * (1.0 - smoothstep(0.0, 0.6, -mxD));
  }
  if (mxFade > 0.0) {
    float mxT = mxNoise(vMxWorld * 12.0) - mxFade * 1.08;
    if (mxT < 0.0) discard;
    mxEdge = max(mxEdge, 1.0 - smoothstep(0.0, 0.09, mxT));
  }
  totalEmissiveRadiance += mxGlowColor * (mxEdge * 3.0);
}`;

function installRim(material, U, rimScale) {
  const strength = { value: 0.4 * rimScale };
  material.userData.rimStrength = strength;
  material.userData.rimScale = rimScale;
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, {
      rimColor: U.rimColor, rimStrength: strength, mxFlashColor: U.flashColor, mxFlash: U.flash,
      mxSweep: U.sweep, mxBaseY: U.baseY, mxFade: U.fade, mxGlowColor: U.glowColor,
    });
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vMxWorld;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvMxWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', RIM_FRAG_HEAD)
      .replace('#include <emissivemap_fragment>', RIM_FRAG_BODY);
  };
  material.customProgramCacheKey = () => 'mx-character-rim-v1';
}

function createMaterials(accent, U) {
  const m = {
    jersey: new MeshStandardMaterial({ color: PALETTE.charcoal, roughness: 0.88, metalness: 0.05 }),
    armor: new MeshStandardMaterial({ color: PALETTE.gunmetal, roughness: 0.45, metalness: 0.45 }),
    black: new MeshStandardMaterial({ color: PALETTE.matte, roughness: 0.5, metalness: 0.3 }),
    steel: new MeshStandardMaterial({ color: PALETTE.steel, roughness: 0.3, metalness: 0.9 }),
    visor: new MeshStandardMaterial({ color: 0x020303, roughness: 0.08, metalness: 1, emissive: accent, emissiveIntensity: 0.035 }),
    accent: new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 1.8, roughness: 0.35, metalness: 0.1 }),
    core: new MeshStandardMaterial({ color: accent, emissive: accent, emissiveIntensity: 3.2, roughness: 0.2, metalness: 0 }),
  };
  const rimScale = { jersey: 1, armor: 1.1, black: 1, steel: 0.8, visor: 0.9, accent: 0.5, core: 0.3 };
  for (const k of Object.keys(m)) {
    m[k].name = `mx-char-${k}`;
    installRim(m[k], U, rimScale[k]);
  }
  return m;
}

const SHIELD_VERT = /* glsl */ `
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
void main() {
  vP = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vN = normalize(normalMatrix * normal);
  vV = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`;

const SHIELD_FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uOpacity;
varying vec3 vN;
varying vec3 vV;
varying vec3 vP;
float h21(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main() {
  float fres = 1.0 - abs(dot(normalize(vN), normalize(vV)));
  fres = pow(fres, 2.2);
  vec2 uv = vec2(atan(vP.z, vP.x) * 3.0, vP.y * 9.0 + uTime * 0.6);
  vec2 cell = floor(uv);
  vec2 f = fract(uv) - 0.5;
  float edge = smoothstep(0.4, 0.5, max(abs(f.x), abs(f.y)));
  float flick = step(0.9, h21(cell + floor(uTime * 9.0)));
  float n = h21(cell * 1.7 + 3.1) * (0.6 + 0.4 * sin(uTime * 5.0 + cell.x));
  float scan = 0.5 + 0.5 * sin(vP.y * 30.0 - uTime * 7.0);
  float a = fres * 0.9 + edge * 0.22 + scan * 0.07 + flick * 0.22 + n * 0.06;
  gl_FragColor = vec4(uColor * 1.6, clamp(a * uOpacity, 0.0, 1.0));
}`;

// ---------------------------------------------------------------------------
// IK + frames
// ---------------------------------------------------------------------------

/** Two-bone IK. Writes the joint into _ikMid, the (reach-clamped) end into _ikEnd, bend dir into _ikBend. */
function solveTwoBone(a, target, l1, l2, pole) {
  _ikD.subVectors(target, a);
  let L = _ikD.length();
  if (L < 1e-6) { _ikD.set(0, -1, 0); L = 1e-6; } else _ikD.divideScalar(L);
  const Lc = clamp(L, Math.abs(l1 - l2) + 1e-3, (l1 + l2) * 0.9995);
  _ikEnd.copy(a).addScaledVector(_ikD, Lc);
  const x = (l1 * l1 - l2 * l2 + Lc * Lc) / (2 * Lc);
  const h = Math.sqrt(Math.max(0, l1 * l1 - x * x));
  _ikBend.copy(pole).addScaledVector(_ikD, -pole.dot(_ikD));
  if (_ikBend.lengthSq() < 1e-8) _ikBend.set(0, 0, -1).addScaledVector(_ikD, _ikD.z);
  if (_ikBend.lengthSq() < 1e-8) _ikBend.set(1, 0, 0);
  _ikBend.normalize();
  _ikMid.copy(a).addScaledVector(_ikD, x).addScaledVector(_ikBend, h);
}

/** Segment frame: +Y from `to` back to `from`, -Z toward the bend, origin at `from`. */
function limbMatrix(out, from, to, bend) {
  _lmY.subVectors(from, to).normalize();
  _lmZ.copy(bend).addScaledVector(_lmY, -bend.dot(_lmY)).negate();
  if (_lmZ.lengthSq() < 1e-8) _lmZ.set(0, 0, 1).addScaledVector(_lmY, -_lmY.z);
  _lmZ.normalize();
  _lmX.crossVectors(_lmY, _lmZ);
  return out.makeBasis(_lmX, _lmY, _lmZ).setPosition(from);
}

function flatWorld(y) {
  return { resolveSphere(p, r) { if (p.y < y + r) { p.y = y + r; return true; } return false; } };
}

/** Torso basis from ragdoll particles into _rUp/_rRt/_rBk (+ shoulder/hip mid points). */
function ragTorsoBasis(p) {
  _rMS.addVectors(p[SHL], p[SHR]).multiplyScalar(0.5);
  _rMH.addVectors(p[HIL], p[HIR]).multiplyScalar(0.5);
  _rUp.subVectors(_rMS, _rMH).normalize();
  _rRt.subVectors(p[SHR], p[SHL]);
  _rRt.addScaledVector(_rUp, -_rRt.dot(_rUp)).normalize();
  _rBk.crossVectors(_rRt, _rUp);
}

function ragFrame(name, p, out) {
  if (name === 'torso') return out.makeBasis(_rRt, _rUp, _rBk).setPosition(_rMS);
  if (name === 'pelvis') {
    _rX.subVectors(p[HIR], p[HIL]);
    _rX.addScaledVector(_rUp, -_rX.dot(_rUp)).normalize();
    _rZ.crossVectors(_rX, _rUp);
    return out.makeBasis(_rX, _rUp, _rZ).setPosition(_rMH);
  }
  if (name === 'head') {
    _rY.subVectors(p[HEAD], _rMS).normalize();
    _rX.copy(_rRt).addScaledVector(_rY, -_rRt.dot(_rY)).normalize();
    _rZ.crossVectors(_rX, _rY);
    return out.makeBasis(_rX, _rY, _rZ).setPosition(p[HEAD]);
  }
  const [a, b, o] = RAG_LIMB[name];
  _rY.subVectors(p[a], p[b]).normalize();
  _rZ.copy(_rBk).addScaledVector(_rY, -_rBk.dot(_rY));
  const l = _rZ.length();
  if (l < 0.3) { // limb nearly parallel to the torso's back axis: blend in the right axis (continuous)
    _rW.copy(_rRt).addScaledVector(_rY, -_rRt.dot(_rY));
    _rZ.addScaledVector(_rW, (0.3 - l) / 0.3);
  }
  _rZ.normalize();
  _rX.crossVectors(_rY, _rZ);
  return out.makeBasis(_rX, _rY, _rZ).setPosition(p[o]);
}

// ---------------------------------------------------------------------------
// CharacterModel
// ---------------------------------------------------------------------------

export class CharacterModel {
  constructor({ accent = 0x7dff1a, detail = 'high' } = {}) {
    this.accent = new Color(accent);
    this.detail = DETAIL[detail] ? detail : 'high';

    this.root = new Group();
    this.root.name = 'CharacterModel';
    this.rig = new Group();
    this.rig.name = 'CharacterRig';
    this.rig.scale.setScalar(BASE_SCALE);
    this.root.add(this.rig);

    this._u = {
      rimColor: { value: this.accent.clone() },
      flash: { value: 0 },
      flashColor: { value: new Color(1, 1, 1) },
      sweep: { value: -1 },
      baseY: { value: 0 },
      fade: { value: 0 },
      glowColor: { value: this.accent.clone().lerp(WHITE, 0.25) },
    };
    this._mats = createMaterials(this.accent, this._u);

    // Body parts (shared geometry, per-instance materials).
    const geos = getGeometrySet(this.detail);
    this.parts = {};
    for (const name of PART_NAMES) {
      const g = new Group();
      g.name = name;
      g.matrixAutoUpdate = false;
      const set = geos[PART_GEO[name]];
      for (const key of Object.keys(set)) {
        const mesh = new Mesh(set[key], this._mats[key]);
        mesh.name = `${name}-${key}`;
        mesh.castShadow = key !== 'accent' && key !== 'core' && key !== 'visor';
        g.add(mesh);
      }
      this.rig.add(g);
      this.parts[name] = g;
    }

    // Spawn-protection shield shell.
    this._shieldGeo = new SphereGeometry(1, 28, 18);
    this._shieldMat = new ShaderMaterial({
      uniforms: { uColor: { value: this.accent.clone() }, uTime: { value: 0 }, uOpacity: { value: 0 } },
      vertexShader: SHIELD_VERT, fragmentShader: SHIELD_FRAG,
      transparent: true, depthWrite: false, blending: AdditiveBlending,
    });
    this.shield = new Mesh(this._shieldGeo, this._shieldMat);
    this.shield.name = 'spawnShield';
    this.shield.visible = false;
    this.shield.renderOrder = 10;
    this.root.add(this.shield);

    // Materialize scan ring.
    this._ringGeo = new TorusGeometry(0.46, 0.014, 6, 48).rotateX(Math.PI / 2);
    this._ringMat = new MeshBasicMaterial({ color: this.accent, transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false });
    this.spawnRing = new Mesh(this._ringGeo, this._ringMat);
    this.spawnRing.name = 'spawnRing';
    this.spawnRing.visible = false;
    this.spawnRing.renderOrder = 11;
    this.root.add(this.spawnRing);

    // Weapon.
    this._weapon = null;
    this._weaponId = null;
    this._muzzle = null;
    this._support = new Vector3().fromArray(SUPPORT.default);

    // Joint positions (rig space), in ragdoll particle order.
    this._j = Array.from({ length: NP }, () => new Vector3());
    this._vel = new Vector3();
    this._seed = Math.random() * 100;
    this._rag = null;
    this._autoDieArmed = true;
    this._t = 0;
    this._resetDynamics();
    this._computePose();
  }

  // ---------------------------------------------------------------- public API

  setWeapon(weaponId, weaponGroup) {
    if (this._weapon && this._weapon !== weaponGroup) this.parts.handR.remove(this._weapon);
    this._weaponId = weaponId;
    this._weapon = weaponGroup || null;
    this._muzzle = null;
    const name = typeof weaponId === 'number' ? WEAPON_BY_ID[weaponId] : weaponId;
    this._support.fromArray(SUPPORT[name] || SUPPORT.default);
    if (!weaponGroup) return;
    this.parts.handR.add(weaponGroup);
    this._muzzle = weaponGroup.getObjectByName('muzzle') || null;
    // Optional support-hand hint from the weapon itself.
    const hint = weaponGroup.userData && weaponGroup.userData.supportGrip;
    const node = weaponGroup.getObjectByName('support') || weaponGroup.getObjectByName('foregrip');
    if (hint) {
      if (Array.isArray(hint)) this._support.fromArray(hint); else this._support.set(hint.x, hint.y, hint.z);
    } else if (node) {
      weaponGroup.updateWorldMatrix(true, true);
      _mTmp.copy(weaponGroup.matrixWorld).invert();
      node.getWorldPosition(this._support).applyMatrix4(_mTmp).applyMatrix4(weaponGroup.matrix);
    }
    this._support.z = Math.max(this._support.z, -0.27); // keep within arm reach
  }

  getMuzzleWorldPosition(target) {
    if (this._muzzle) return this._muzzle.getWorldPosition(target);
    const hand = this.parts.handR;
    hand.updateWorldMatrix(true, false);
    return target.set(0, 0.06, -0.5).applyMatrix4(hand.matrixWorld);
  }

  getHeadWorldPosition(target) {
    return this.parts.head.getWorldPosition(target);
  }

  update(dt, s) {
    s = s || {};
    const ts = Number.isFinite(s.timeScale) ? Math.max(0, s.timeScale) : 1;
    dt = clamp(Number.isFinite(dt) ? dt : 0, 0, 0.1) * ts;
    this._t += dt;
    if (!s.dead) this._autoDieArmed = true;
    if (s.dead && !this._rag && this._autoDieArmed) this.die(null, null);
    if (this._rag) {
      this._stepRagdoll(dt);
      this._applyRagdollPose();
    } else {
      this._animate(dt, s);
    }
    this._updateEffects(dt, s);
  }

  pulseFire(kick = 1) {
    if (this._rag) return;
    this._recoil.v += 7 * kick;
    if (this._recoil.x > 0.3) this._recoil.x = 0.3;
  }

  pulseHit(direction) {
    this._flash = 1;
    if (this._rag) return;
    let px = -(direction ? direction.x || 0 : Math.random() - 0.5);
    let pz = -(direction ? direction.z || 0 : Math.random() - 0.5);
    const l = Math.hypot(px, pz) || 1;
    px /= l; pz /= l;
    const yaw = this.root.rotation.y, sy = Math.sin(yaw), cy = Math.cos(yaw);
    this._flinchX.v += (px * cy - pz * sy) * 6;
    this._flinchZ.v += (px * sy + pz * cy) * 6;
  }

  die(impulse, world) {
    const ix = impulse ? impulse.x || 0 : 0, iy = impulse ? impulse.y || 0 : 0, iz = impulse ? impulse.z || 0 : 0;
    if (this._rag) { // already ragdolled (e.g. auto-died from s.dead): merge late impulse / world
      const R = this._rag;
      if (world && typeof world.resolveSphere === 'function') R.world = world;
      if (impulse && R.t < 0.35) {
        for (let i = 0; i < NP; i++) R.prev[i].add(_v1.set(ix, iy, iz).multiplyScalar(-P_IMPULSE[i] * R.hPrev));
        R.asleep = false; R.sleepT = 0;
      }
      return;
    }
    this.rig.position.set(0, 0, 0);
    this.rig.scale.setScalar(BASE_SCALE);
    this.rig.visible = true;
    this.root.updateMatrixWorld(true);
    const RW = this.rig.matrixWorld;
    const h0 = 1 / 180;
    const R = {
      t: 0, pos: [], prev: [], hPrev: h0, cons: [], offsets: {}, sink: 0, asleep: false, sleepT: 0, groundT: 0,
      world: world && typeof world.resolveSphere === 'function' ? world : flatWorld(this.root.getWorldPosition(_v1).y),
    };
    for (let i = 0; i < NP; i++) R.pos.push(this._j[i].clone().applyMatrix4(RW));
    // Initial velocities: body motion + impulse (weighted to the upper body) + a slight random spin.
    const com = _v2.set(0, 0, 0);
    for (const p of R.pos) com.add(p);
    com.multiplyScalar(1 / NP);
    const spin = _v3.set(Math.random() - 0.5, (Math.random() - 0.5) * 0.6, Math.random() - 0.5).normalize().multiplyScalar(1 + Math.random() * 1.5);
    for (let i = 0; i < NP; i++) {
      const v = _v4.copy(this._vel).add(_v5.set(ix, iy, iz).multiplyScalar(P_IMPULSE[i]));
      v.add(_v5.subVectors(R.pos[i], com).cross(spin).negate()); // spin x r
      if (v.length() > 30) v.setLength(30);
      R.prev.push(R.pos[i].clone().addScaledVector(v, -h0));
    }
    // Constraints from the current pose (rest lengths measured now => no pop).
    const addC = (a, b, lo, hi) => {
      const wa = P_INVMASS[a], wb = P_INVMASS[b], sum = wa + wb;
      R.cons.push({ a, b, lo, hi, wa: wa / sum, wb: wb / sum, tone: 0 });
    };
    for (const [a, b] of C_RIGID) { const d = R.pos[a].distanceTo(R.pos[b]); addC(a, b, d, d); }
    for (const [a, b, lo, hi] of C_RANGE) { const d = R.pos[a].distanceTo(R.pos[b]); addC(a, b, d * lo, d * hi); }
    for (const [a, b, mn] of C_MIN) { const d = R.pos[a].distanceTo(R.pos[b]); addC(a, b, Math.min(mn, d * 0.98), Infinity); }
    // Fading "muscle tone" on the legs so knees buckle progressively instead of snapping.
    for (const [a, b] of [[HIL, FTL], [HIR, FTR], [PELV, KNL], [PELV, KNR]]) {
      const d = R.pos[a].distanceTo(R.pos[b]);
      addC(a, b, d, d);
      R.cons[R.cons.length - 1].tone = 0.12;
    }
    // Part offsets relative to their particle frames.
    ragTorsoBasis(R.pos);
    for (const name of PART_NAMES) {
      ragFrame(name, R.pos, _mF);
      R.offsets[name] = new Matrix4().copy(_mF).invert().multiply(this.parts[name].matrixWorld);
    }
    this._rag = R;
    this._shieldB = 0;
    this.shield.visible = false;
    this._spawnFx = -1;
    this._spawnScale = 1;
    this.spawnRing.visible = false;
    this._u.sweep.value = -1;
    this._u.fade.value = 0;
    this._flash = Math.max(this._flash, 0.8);
  }

  respawn() {
    this._rag = null;
    this._autoDieArmed = false; // ignore a stale s.dead until the state clears
    this.rig.visible = true;
    this.rig.position.set(0, 0, 0);
    this._u.fade.value = 0;
    this._resetDynamics();
    this._spawnFx = 0;
    this._spawnScale = 0.85;
    this._u.sweep.value = -0.1;
    this._computePose();
  }

  setVisible(v) {
    this.root.visible = !!v;
  }

  dispose() {
    if (this._weapon) { this.parts.handR.remove(this._weapon); this._weapon = null; this._muzzle = null; }
    this.root.removeFromParent();
    for (const m of Object.values(this._mats)) m.dispose();
    this._shieldGeo.dispose();
    this._shieldMat.dispose();
    this._ringGeo.dispose();
    this._ringMat.dispose();
    this._rag = null;
  }

  // ---------------------------------------------------------------- animation

  _resetDynamics() {
    this._snap = true;
    this._phase = 0;
    this._lv = new Vector2();
    this._dir = new Vector2(0, -1);
    this._speed = 0; this._move = 0; this._run = 0; this._cycleLen = 1.2;
    this._vy = 0; this._fall = 0; this._air = 0;
    this._crouch = 0; this._slide = 0; this._sprint = 0; this._ads = 0;
    this._reload = 0; this._reloadT = 0; this._wasReloading = false;
    this._pitch = 0;
    this._wasGround = true; this._airTime = 0; this._minVy = 0;
    this._land = new Spring(); this._recoil = new Spring();
    this._flinchX = new Spring(); this._flinchZ = new Spring();
    this._flash = 0; this._rushB = 0; this._shieldB = 0;
    this._spawnFx = -1; this._spawnScale = 1;
    this._vel.set(0, 0, 0);
  }

  _animate(dt, s) {
    const snap = this._snap;
    this._snap = false;
    const k = (rate) => (snap ? 1 : 1 - Math.exp(-rate * dt));

    const pos = s.position, vel = s.velocity;
    if (pos) this.root.position.set(pos.x || 0, pos.y || 0, pos.z || 0);
    const yaw = Number.isFinite(s.yaw) ? s.yaw : 0;
    this.root.rotation.set(0, yaw, 0);
    const vx = vel ? vel.x || 0 : 0, vy = vel ? vel.y || 0 : 0, vz = vel ? vel.z || 0 : 0;
    this._vel.set(vx, vy, vz);

    // Horizontal velocity in the character's local frame (x = right, y = +Z back).
    const sy = Math.sin(yaw), cy = Math.cos(yaw);
    this._lv.x += (vx * cy - vz * sy - this._lv.x) * k(12);
    this._lv.y += (vx * sy + vz * cy - this._lv.y) * k(12);
    const speed = Math.hypot(this._lv.x, this._lv.y);
    this._speed = speed;
    if (speed > 0.15) this._dir.set(this._lv.x / speed, this._lv.y / speed);

    const onGround = s.onGround !== false;
    const sliding = !!s.sliding;
    if (!onGround) {
      this._airTime += dt;
      this._minVy = Math.min(this._minVy, vy);
    } else {
      if (!this._wasGround && this._airTime > 0.12 && !snap) this._land.v -= clamp(-this._minVy / 13, 0.15, 1) * 3;
      this._airTime = 0;
      this._minVy = 0;
    }
    this._wasGround = onGround;

    this._air += ((onGround || sliding ? 0 : 1) - this._air) * k(onGround ? 14 : 8);
    this._vy += (vy - this._vy) * k(10);
    this._fall += (clamp(0.5 - this._vy / 6, 0, 1) - this._fall) * k(8);
    this._crouch += (clamp(s.crouch || 0, 0, 1) - this._crouch) * k(16);
    this._slide += ((sliding ? 1 : 0) - this._slide) * k(sliding ? 12 : 7);
    this._sprint += ((s.sprinting && speed > 2.5 && !sliding && !s.ads ? 1 : 0) - this._sprint) * k(8);
    this._ads += ((s.ads ? 1 : 0) - this._ads) * k(14);
    const reloading = !!s.reloading;
    if (reloading && !this._wasReloading && this._reload < 0.05) this._reloadT = 0;
    this._wasReloading = reloading;
    if (reloading) this._reloadT += dt;
    this._reload += ((reloading ? 1 : 0) - this._reload) * k(10);
    this._pitch += (clamp(Number.isFinite(s.pitch) ? s.pitch : 0, -1.5, 1.5) - this._pitch) * k(30);

    this._move = smooth01((speed - 0.15) / 1.1) * (1 - this._slide);
    this._run = clamp((speed - 2.5) / 4.5, 0, 1);
    this._cycleLen = clamp(1.0 + speed * 0.2, 1.2, 2.9);
    this._phase += ((speed * dt) / this._cycleLen) * (1 - this._air) * (1 - this._slide);
    this._phase -= Math.floor(this._phase);

    this._land.step(dt, 14);
    this._recoil.step(dt, 28);
    this._flinchX.step(dt, 16);
    this._flinchZ.step(dt, 16);

    // Landing squash + materialize scale-in on the rig.
    const sq = this._land.x, ms = this._spawnScale;
    this.rig.scale.set(BASE_SCALE * (1 - sq * 0.25) * ms, BASE_SCALE * (1 + sq * 0.5), BASE_SCALE * (1 - sq * 0.25) * ms);

    this._computePose();
  }

  /** Full procedural pose -> part matrices + joint positions (rig space). */
  _computePose() {
    const P = this.parts, J = this._j;
    const slide = this._slide, crouch = this._crouch;
    const air = this._air * (1 - slide);
    const sprint = this._sprint * (1 - slide) * (1 - air * 0.5);
    const ads = this._ads * (1 - sprint);
    const reload = this._reload, move = this._move, run = this._run, speed = this._speed;
    const phase = this._phase, t = this._t, pitch = this._pitch, fall = this._fall;
    const dx = this._dir.x, dz = this._dir.y;
    const moveAng = Math.atan2(dx, -dz);
    const still = 1 - move;
    const breath = Math.sin(t * 1.9);
    const land = this._land.x;
    const ph1 = phase * TAU;

    // ---- pelvis
    let py = lerp(SK.pelvisY, lerp(0.35, 0.43, move), crouch);
    py -= lerp(0.018, 0.05, run) * move * (1 - 0.5 * crouch) * (0.5 + 0.5 * Math.cos(ph1 * 2));
    py += breath * 0.004 * still + land;
    py = lerp(py, 0.215, slide);
    const pX = Math.sin(ph1) * 0.018 * move * (1 - 0.5 * run);
    const pZ = lerp(0.05 * crouch * (1 - 0.5 * move), 0.08, slide);
    const lean = lerp(-0.34 * crouch - 0.2 * sprint - 0.08 * run * move * (1 - sprint) + land * 2.5, 0.8, slide);
    const twist = (-Math.sin(2 * moveAng) * 0.32 - Math.cos(ph1) * 0.06 * (1 - 0.5 * crouch)) * move * (1 - air);
    const roll = (clamp(-this._lv.x * 0.012, -0.1, 0.1) + Math.sin(ph1) * 0.025 * move) * (1 - slide);
    _q1.setFromEuler(_e.set(lean, twist, roll, 'YXZ'));
    _mPelvis.compose(_v1.set(pX, py, pZ), _q1, ONE);
    P.pelvis.matrix.copy(_mPelvis);

    // ---- spine / chest (counter-twist keeps the upper body on the aim yaw)
    const pb = clamp(pitch, -1.2, 1.2) * (1 - 0.6 * sprint);
    const spX = lerp(-0.12 * crouch, -0.12, slide) + pb * 0.18 + breath * 0.012 * still + land * 1.2;
    const chX = lerp(-0.05 * crouch, -0.05, slide) + pb * 0.22 + this._flinchZ.x + this._recoil.x * 0.25;
    _q1.setFromEuler(_e.set(spX, -twist * 0.55, -roll * 0.5, 'YXZ'));
    _mSpine.multiplyMatrices(_mPelvis, _mTmp.compose(_v1.set(0, SK.spine, 0), _q1, ONE));
    _q1.setFromEuler(_e.set(chX, -twist * 0.45, -roll * 0.5 - this._flinchX.x, 'YXZ'));
    _mChest.multiplyMatrices(_mSpine, _mTmp.compose(_v1.set(0, SK.chest, 0), _q1, ONE));
    _qChest.setFromRotationMatrix(_mChest);
    P.torso.matrix.copy(_mChest);

    // ---- head (tracks aim pitch in rig space; ADS cheek weld tilt)
    _v1.set(0, SK.neck, 0).applyMatrix4(_mChest);
    _qHead.setFromEuler(_e.set(pitch * 0.85 - 0.1 * ads + this._flinchZ.x * 0.6 + land * 0.6, 0, -0.17 * ads - this._flinchX.x * 0.6, 'YXZ'));
    _v2.set(0.012 * ads, SK.head - 0.012 * ads, -0.02 * ads).applyQuaternion(_qHead).add(_v1);
    _mHead.compose(_v2, _qHead, ONE);
    P.head.matrix.copy(_mHead);
    J[HEAD].copy(_v2);

    // ---- aim frame + right hand (weapon). Exact aim pitch in rig space regardless of lean.
    _v1.copy(AIM_PIVOT).applyMatrix4(_mChest);
    _q1.setFromEuler(_e.set(pitch * (1 - 0.85 * sprint), 0, 0, 'YXZ'));
    _v2.copy(GRIP_HIP).lerp(GRIP_ADS, ads).lerp(GRIP_SPRINT, sprint).addScaledVector(GRIP_RELOAD, reload);
    const bob = 1 - 0.7 * ads;
    _v2.x += Math.sin(ph1) * 0.012 * move * bob;
    _v2.y += (-Math.abs(Math.cos(ph1)) * 0.014 * move + Math.sin(ph1 * 2) * 0.02 * sprint) * bob + breath * 0.003 + 0.025 * air + this._recoil.x * 0.1;
    _v2.z += this._recoil.x * 0.7 + Math.sin(ph1) * 0.03 * sprint;
    const sway = Math.sin(t * 1.3) * 0.012 * still;
    const rx = -0.75 * sprint + 0.35 * reload + this._recoil.x * 1.8 + sway + Math.sin(ph1 * 2) * 0.05 * sprint;
    const ry = 0.7 * sprint + 0.28 * reload + Math.cos(t * 0.9) * 0.01 * still + Math.sin(ph1) * 0.1 * sprint;
    const rz = 0.35 * sprint - 0.6 * reload;
    _q2.setFromEuler(_e.set(rx, ry, rz, 'YXZ'));
    _mAim.compose(_v1, _q1, ONE);
    _mHandR.multiplyMatrices(_mAim, _mTmp.compose(_v2, _q2, ONE));
    P.handR.matrix.copy(_mHandR);

    // ---- left hand: weapon support point, reload path, falling balance.
    _mHandL.multiplyMatrices(_mHandR, _mTmp.makeTranslation(this._support.x, this._support.y, this._support.z));
    _v3.setFromMatrixPosition(_mHandL);
    if (reload > 0.002) { this._reloadPoint(_v3, _v4); _v3.lerp(_v4, reload); }
    const bal = air * fall * 0.5 * (1 - ads);
    if (bal > 0.002) _v3.lerp(_v4.set(-0.42, -0.02, -0.08).applyMatrix4(_mChest), bal);
    _mHandL.setPosition(_v3);
    P.handL.matrix.copy(_mHandL);

    // ---- arms (IK shoulder -> wrist)
    const shY = 0.18 + 0.02 * ads + breath * 0.003 * still;
    _shR.set(0.2, shY, 0.02).applyMatrix4(_mChest);
    _shL.set(-0.2, shY, 0.02).applyMatrix4(_mChest);
    _wR.copy(WRIST_R).applyMatrix4(_mHandR);
    _wL.copy(WRIST_L).applyMatrix4(_mHandL);
    _pole.set(lerp(0.45, 0.85, ads), lerp(-0.8, -0.42, ads), 0.25).applyQuaternion(_qChest);
    this._limb(P.upperArmR, P.forearmR, _shR, _wR, SK.upperArm, SK.forearm, _pole, SHR, ELR, HAR);
    _pole.set(-0.55, lerp(-0.75, -0.6, ads), 0.1).applyQuaternion(_qChest);
    this._limb(P.upperArmL, P.forearmL, _shL, _wL, SK.upperArm, SK.forearm, _pole, SHL, ELL, HAL);

    // ---- legs (IK hip -> ankle target)
    const duty = lerp(0.58, 0.4, run);
    const stride = Math.min(duty * this._cycleLen, 0.25 + 0.055 * speed) * (1 - 0.35 * crouch);
    const liftH = lerp(0.1, 0.24, run) * (1 - 0.4 * crouch);
    const gm = move * (1 - air);
    for (let i = 0; i < 2; i++) {
      const sd = i === 0 ? -1 : 1;
      _hip.copy(i === 0 ? HIP_L : HIP_R).applyMatrix4(_mPelvis);
      _foot.copy(FOOT_STAND[i]).lerp(_v1.copy(FOOT_KNEEL[i]).lerp(FOOT_CWALK[i], move), crouch);
      let fp = i === 1 ? -0.6 * crouch * still : 0; // kneeling back foot on its toes
      if (gm > 0.001) {
        let u = phase + i * 0.5;
        u -= Math.floor(u);
        let off, lift = 0, cross = 0, gp;
        if (u < duty) {
          const w = u / duty;
          off = stride * (0.5 - w);
          gp = lerp(0.22, -0.3, w);
        } else {
          const w = (u - duty) / (1 - duty);
          const sn = Math.sin(Math.PI * w);
          off = stride * (smooth01(w) - 0.5);
          lift = liftH * sn;
          cross = sn;
          gp = lerp(-0.55, 0.22, w) * (0.4 + 0.6 * run);
        }
        _foot.x += dx * off * gm;
        _foot.z += dz * off * gm + Math.abs(dx) * 0.11 * cross * sd * gm; // strafe cross-step
        _foot.y += lift * gm;
        fp += gp * gm * (1 - Math.abs(dx) * 0.5) * (dz < 0 ? 1 : 0.4);
      }
      if (air > 0.001) {
        _foot.lerp(_v1.copy(FOOT_RISE[i]).lerp(FOOT_FALL[i], fall), air);
        fp = lerp(fp, -0.35, air);
      }
      if (slide > 0.001) {
        _foot.lerp(FOOT_SLIDE[i], slide);
        fp = lerp(fp, i === 0 ? 0.6 : 0.1, slide);
      }
      _pole.set(-Math.sin(twist) + sd * (0.12 + 0.3 * crouch), 0, -Math.cos(twist));
      if (slide > 0.001) _pole.lerp(SLIDE_POLE[i], slide);
      _pole.normalize();
      const thigh = i === 0 ? P.thighL : P.thighR, shin = i === 0 ? P.shinL : P.shinR, footPart = i === 0 ? P.footL : P.footR;
      const kn = i === 0 ? KNL : KNR;
      this._limb(thigh, shin, _hip, _foot, SK.thigh, SK.shin, _pole, i === 0 ? HIL : HIR, kn, i === 0 ? FTL : FTR);
      // Knee-floor guard (deep kneel): tilting the pole upward always raises the knee.
      for (let k = 0; k < 3 && air < 0.5 && J[kn].y < 0.085; k++) {
        _pole.y += (0.085 - J[kn].y) * 14;
        _pole.normalize();
        this._limb(thigh, shin, _hip, _foot, SK.thigh, SK.shin, _pole, i === 0 ? HIL : HIR, kn, i === 0 ? FTL : FTR);
      }
      _q1.setFromEuler(_e.set(fp, twist * 0.8 - sd * 0.1, 0, 'YXZ'));
      footPart.matrix.compose(J[i === 0 ? FTL : FTR], _q1, ONE);
    }

    // ---- ragdoll seed points
    J[CHEST].copy(CHEST_PT).applyMatrix4(_mChest);
    J[BACK].copy(BACK_PT).applyMatrix4(_mChest);
    J[PELV].copy(PELVIS_PT).applyMatrix4(_mPelvis);

    for (const name of PART_NAMES) P[name].matrixWorldNeedsUpdate = true;
  }

  _limb(partA, partB, a, target, l1, l2, pole, ja, jb, jc) {
    solveTwoBone(a, target, l1, l2, pole);
    limbMatrix(partA.matrix, a, _ikMid, _ikBend);
    limbMatrix(partB.matrix, _ikMid, _ikEnd, _ikBend);
    this._j[ja].copy(a);
    this._j[jb].copy(_ikMid);
    this._j[jc].copy(_ikEnd);
  }

  /** Left-hand reload path: grip -> mag well -> belt pouch -> mag well (seat) -> grip. */
  _reloadPoint(grip, out) {
    const CYCLE = 1.2;
    const u = (this._reloadT % CYCLE) / CYCLE;
    const well = _rp1.set(0, -0.1, -0.1).applyMatrix4(_mHandR);
    if (u < 0.18) return out.copy(grip).lerp(well, smooth01(u / 0.18));
    if (u < 0.66) {
      const pouch = _rp2.set(-0.12, 0.04, -0.14).applyMatrix4(_mPelvis);
      const w = u < 0.42 ? smooth01((u - 0.18) / 0.24) : 1 - smooth01((u - 0.42) / 0.24);
      return out.copy(well).lerp(pouch, w);
    }
    if (u < 0.82) return out.copy(well).setY(well.y + 0.025 * Math.sin((Math.PI * (u - 0.66)) / 0.16));
    return out.copy(well).lerp(grip, smooth01((u - 0.82) / 0.18));
  }

  // ---------------------------------------------------------------- ragdoll

  _stepRagdoll(dt) {
    const R = this._rag;
    R.t += dt;
    if (dt <= 0 || R.asleep) return;
    const n = dt > 1 / 70 ? 4 : dt > 1 / 130 ? 3 : 2;
    const h = dt / n;
    for (let i = 0; i < n; i++) this._ragSubstep(R, h);
  }

  _ragSubstep(R, h) {
    const p = R.pos, q = R.prev;
    const ratio = clamp(h / R.hPrev, 0.25, 4);
    // ~0.99 per 60 Hz frame in flight; once resting on the ground the drag ramps up so free
    // limb DOFs (a raised leg/arm) settle instead of swinging forever.
    const dampF = Math.exp(-h * lerp(0.6, 7, smooth01((R.groundT - 0.8) / 1.2)));
    const maxStep = 30 * h;
    const g = GRAVITY * h * h;
    let maxMove = 0;
    for (let i = 0; i < NP; i++) {
      _rv.subVectors(p[i], q[i]).multiplyScalar(ratio * dampF);
      _rv.y -= g;
      const l = _rv.length();
      if (l > maxStep) _rv.multiplyScalar(maxStep / l);
      if (l > maxMove) maxMove = l;
      q[i].copy(p[i]);
      p[i].add(_rv);
    }
    R.hPrev = h;

    const tone = Math.max(0, 1 - R.t / 0.6);
    for (let it = 0; it < 8; it++) {
      for (const c of R.cons) {
        const k = c.tone ? c.tone * tone : 1;
        if (k <= 0) continue;
        const a = p[c.a], b = p[c.b];
        _rd.subVectors(b, a);
        const L = _rd.length();
        if (L < 1e-6) continue;
        const target = L < c.lo ? c.lo : L > c.hi ? c.hi : L;
        if (target === L) continue;
        const diff = ((L - target) / L) * k;
        a.addScaledVector(_rd, diff * c.wa);
        b.addScaledVector(_rd, -diff * c.wb);
      }
      if (it % 2 === 1) { this._kneeHinge(p, q, HIL, KNL, FTL); this._kneeHinge(p, q, HIR, KNR, FTR); }
    }

    // World collision + Coulomb-ish friction, inelastic normal response.
    const world = R.world, mu = 0.7;
    let contacts = 0;
    for (let i = 0; i < NP; i++) {
      _rTmp.copy(p[i]);
      if (!world.resolveSphere(p[i], P_RADIUS[i] * BASE_SCALE)) continue;
      contacts++;
      if (!Number.isFinite(p[i].x + p[i].y + p[i].z)) p[i].copy(_rTmp);
      _rn.subVectors(p[i], _rTmp);
      const depth = _rn.length();
      if (depth < 1e-9) continue;
      _rn.divideScalar(depth);
      _rv.subVectors(p[i], q[i]);
      _rv.addScaledVector(_rn, -_rv.dot(_rn)); // tangential displacement only
      const vt = _rv.length();
      const keep = vt > 1e-9 ? Math.max(0, 1 - (mu * depth + 2e-5) / vt) : 0;
      q[i].copy(p[i]).addScaledVector(_rv, -keep);
    }

    if (contacts >= 3) R.groundT += h;
    // Sleep once settled (prevents micro-jitter).
    if (maxMove / h < 0.06 + GRAVITY * h) { R.sleepT += h; if (R.sleepT > 0.5 && R.t > 1.0) R.asleep = true; } else R.sleepT = 0;
  }

  /**
   * Keep each knee bending forward relative to the pelvis (no hyper-extension).
   * The projection is applied to current AND previous positions so it corrects pose without
   * injecting velocity (a verlet position fix would otherwise fling the knee).
   */
  _kneeHinge(p, q, hip, knee, foot) {
    ragTorsoBasis(p);
    _rFwd.copy(_rBk).negate();
    _rY.subVectors(p[foot], p[hip]);
    const len = _rY.length();
    if (len < 1e-5) return;
    _rY.divideScalar(len);
    _rZ.copy(_rFwd).addScaledVector(_rY, -_rFwd.dot(_rY));
    const l = _rZ.length();
    if (l < 0.3) { _rW.copy(_rUp).addScaledVector(_rY, -_rUp.dot(_rY)); _rZ.addScaledVector(_rW, (0.3 - l) / 0.3); }
    _rZ.normalize();
    _rd.addVectors(p[hip], p[foot]).multiplyScalar(0.5);
    const f = _rd.subVectors(p[knee], _rd).dot(_rZ);
    if (f < 0.01) {
      const c = Math.min(0.01 - f, 0.02);
      p[knee].addScaledVector(_rZ, c * 0.6); q[knee].addScaledVector(_rZ, c * 0.6);
      p[hip].addScaledVector(_rZ, -c * 0.2); q[hip].addScaledVector(_rZ, -c * 0.2);
      p[foot].addScaledVector(_rZ, -c * 0.2); q[foot].addScaledVector(_rZ, -c * 0.2);
    }
  }

  _applyRagdollPose() {
    const R = this._rag;
    const f = clamp((R.t - RAG_SETTLE) / RAG_FADE, 0, 1);
    R.sink = smooth01(f) * 0.35 * BASE_SCALE;
    if (f >= 1) { this.rig.visible = false; return; }
    this.rig.updateWorldMatrix(true, false);
    _mInv.copy(this.rig.matrixWorld).invert();
    ragTorsoBasis(R.pos);
    for (const name of PART_NAMES) {
      ragFrame(name, R.pos, _mF).multiply(R.offsets[name]);
      _mF.elements[13] -= R.sink;
      const part = this.parts[name];
      part.matrix.multiplyMatrices(_mInv, _mF);
      part.matrixWorldNeedsUpdate = true;
    }
  }

  // ---------------------------------------------------------------- effects

  _updateEffects(dt, s) {
    const U = this._u, M = this._mats, R = this._rag, t = this._t;

    // Rush pulse.
    this._rushB = damp(this._rushB, s.rush && !R ? 1 : 0, 6, dt);
    const pulse = 0.5 + 0.5 * Math.sin(t * 11);
    let accentI = 1.8 * (1 + this._rushB * (0.6 + 1.0 * pulse));
    let coreI = 3.2 * (1 + this._rushB * (0.5 + 1.2 * pulse)) * (0.92 + 0.08 * Math.sin(t * 7.3));
    let rim = 0.4 + this._rushB * (0.45 + 0.4 * pulse);

    // Hit flash: white burst cooling to red.
    this._flash *= Math.exp(-dt * 9);
    let flash = this._flash * 1.5;
    _c1.copy(HIT_RED).lerp(WHITE, this._flash);

    if (R) {
      if (R.t < 0.9) { // energy glitch flicker
        const g = hash1(Math.floor(R.t * 22) + this._seed);
        accentI *= g < 0.35 ? 0.05 : g < 0.7 ? 2.6 : 1;
        coreI *= g < 0.5 ? 0.1 : 1.8;
        if (g > 0.78) { flash = Math.max(flash, 0.4 + g); _c1.copy(this.accent).lerp(WHITE, 0.5); }
      } else {
        const d = smooth01((R.t - 0.9) / 1.0);
        accentI *= lerp(1, 0.18, d);
        coreI *= lerp(1, 0.05, d);
        rim *= lerp(1, 0.25, d);
      }
      U.fade.value = clamp((R.t - RAG_SETTLE) / RAG_FADE, 0, 1);
    }

    // Materialize sweep.
    if (this._spawnFx >= 0) {
      this._spawnFx += dt;
      const p = this._spawnFx / SPAWN_FX;
      if (p >= 1) {
        this._spawnFx = -1;
        this._spawnScale = 1;
        U.sweep.value = -1;
        this.spawnRing.visible = false;
      } else {
        U.sweep.value = (-0.1 + p * 2.1) * BASE_SCALE;
        this._spawnScale = lerp(0.85, 1, 1 - Math.pow(1 - p, 3));
        this.spawnRing.visible = true;
        this.spawnRing.position.set(0, U.sweep.value, 0);
        this.spawnRing.scale.setScalar((1.15 - 0.3 * p) * BASE_SCALE);
        this._ringMat.opacity = Math.sin(Math.PI * p) * 0.9;
        if ((1 - p) * 0.6 > flash) { flash = (1 - p) * 0.6; _c1.copy(this.accent); }
      }
    }

    M.accent.emissiveIntensity = accentI;
    M.core.emissiveIntensity = coreI;
    M.visor.emissiveIntensity = 0.035 + 0.1 * this._rushB;
    for (const m of Object.values(M)) m.userData.rimStrength.value = rim * m.userData.rimScale;
    U.flash.value = flash;
    U.flashColor.value.copy(_c1);
    U.baseY.value = this.root.position.y;

    // Spawn-protection shield.
    this._shieldB = damp(this._shieldB, s.spawnProtected && !R ? 1 : 0, 10, dt);
    const sh = this.shield;
    sh.visible = this._shieldB > 0.01;
    if (sh.visible) {
      const hF = lerp(lerp(1, 0.66, this._crouch), 0.56, this._slide);
      sh.scale.set(0.62, 1.02 * hF, lerp(0.62, 0.85, this._slide)).multiplyScalar(BASE_SCALE);
      sh.position.set(0, 0.93 * hF * BASE_SCALE, -0.25 * this._slide * BASE_SCALE);
      this._shieldMat.uniforms.uTime.value = t;
      this._shieldMat.uniforms.uOpacity.value = this._shieldB * (0.85 + 0.15 * Math.sin(t * 17));
    }
  }
}

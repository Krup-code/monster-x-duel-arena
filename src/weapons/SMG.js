// VOLT SMG - compact high-rate SMG: front stick magazine, vertical foregrip, vented glowing
// barrel shroud and lightning-bolt inlays.
import * as THREE from 'three';
import { createKit } from './materials.js';

const BORE_Y = 0.062;

// Classic lightning bolt (unit space: a = across, b = along, b = -1 is the tip).
const BOLT = [[0.3, 1], [-0.25, 0], [0.05, 0], [-0.3, -1], [0.35, 0.15], [0.05, 0.15]];

function buildModel({ detail = 'high' } = {}) {
  const k = createKit(detail);
  const { m, hi } = k;

  const root = new THREE.Group();
  root.name = 'weapon_volt';
  const body = k.group('body', root);
  root.add(k.energy);
  const mag = k.group('magazine', root, 0, 0.02, -0.107);
  mag.rotation.x = 0.06;

  // ---- Receiver: one polymer profile with magwell + trigger guard ----
  const recv = [
    [0.06, 0.03], [0.06, 0.086], [0.046, 0.098], [-0.125, 0.098], [-0.15, 0.093], [-0.222, 0.093], [-0.236, 0.082],
    [-0.236, 0.03], [-0.226, 0.016], [-0.14, 0.016], [-0.132, -0.008], [-0.134, -0.03], [-0.08, -0.03], [-0.076, -0.01],
    [-0.068, -0.016], [-0.012, -0.016], [-0.006, 0.016], [0.042, 0.016],
  ];
  const guard = [[-0.066, 0.01], [-0.066, -0.008], [-0.06, -0.01], [-0.016, -0.01], [-0.012, 0.01]];
  k.add(body, k.side(recv, 0.036, { holes: [guard], bevel: 0.002 }), m.polymer);
  k.trigger(body, -0.036, 0.011);
  k.grip(body, { z: -0.004, y: 0.018, height: 0.095, depth: 0.042, width: 0.03, rake: 0.28 });
  k.rail(body, 0.04, -0.14, 0.098, 0.02);

  // Charging slot + knob (left), ejection port (right), selector, mag release, screws.
  k.add(body, k.box(0.001, 0.005, 0.07), m.dark, -0.0181, 0.08, -0.095);
  k.add(body, k.cylX(0.0045, 0.012, 12), m.steel, -0.0235, 0.08, -0.128);
  if (hi) k.add(body, k.cylX(0.0055, 0.003, 12), m.gunmetal, -0.0295, 0.08, -0.128);
  k.add(body, k.box(0.0012, 0.012, 0.03), m.dark, 0.0182, 0.072, -0.11);
  k.add(body, k.box(0.0015, 0.004, 0.012), m.steel, -0.0185, 0.032, 0.024, -0.5);
  k.add(body, k.cylX(0.0035, 0.002, 10), m.steel, 0.0185, 0.006, -0.073);
  k.screwPair(body, 0.018, 0.04, 0.046);
  k.screwPair(body, 0.018, 0.04, -0.214);
  k.screwPair(body, 0.018, 0.082, -0.214);
  k.decalPair(body, 0.05, 0.012, 0.018 + 0.0006, 0.064, -0.185);

  // Lightning-bolt inlays + edge lines (energy).
  const boltPts = BOLT.map(([a, b]) => [b * 0.042, a * 0.03]);
  const boltGeo = k.side(boltPts, 0.0012, { bevel: 0 });
  k.pair(k.energy, boltGeo, k.energyMat, 0.0184, 0.06, -0.045);
  k.stripPair(0.0012, 0.002, 0.15, 0.0182, 0.089, -0.05);
  k.stripPair(0.0012, 0.002, 0.06, 0.0182, 0.024, -0.2);

  // ---- Vented shroud over a glowing energy core ----
  k.add(body, k.cylZ(0.019, 0.019, 0.008, 20), m.gunmetal, 0, BORE_Y, -0.24);
  k.add(body, k.cylZ(0.019, 0.019, 0.01, 20), m.gunmetal, 0, BORE_Y, -0.315);
  const bar = k.box(0.0045, 0.006, 0.072);
  for (let i = 0; i < 6; i++) {
    const a = Math.PI / 6 + (i * Math.PI) / 3;
    k.add(body, bar, m.gunmetal, Math.cos(a) * 0.0165, BORE_Y + Math.sin(a) * 0.0165, -0.277, 0, 0, a);
  }
  k.glow(k.cylZ(0.0105, 0.0105, 0.072, 14), 0, BORE_Y, -0.277);

  // Compensator.
  k.add(body, k.cylZ(0.0115, 0.013, 0.03, 18), m.steel, 0, BORE_Y, -0.335);
  k.add(body, k.cylZ(0.0105, 0.0105, 0.004, 18), m.steel, 0, BORE_Y, -0.352);
  k.add(body, k.cylZ(0.0045, 0.0045, 0.001, 12), m.dark, 0, BORE_Y, -0.3542);
  if (hi) for (const z of [-0.328, -0.339]) k.add(body, k.box(0.01, 0.0012, 0.004), m.dark, 0, BORE_Y + 0.0123, z);

  // ---- Vertical foregrip (slightly raked) ----
  const mount = [[-0.165, 0.018], [-0.205, 0.018], [-0.21, 0.01], [-0.2, 0.0], [-0.17, 0.0], [-0.162, 0.01]];
  k.add(body, k.side(mount, 0.03, { bevel: 0.002 }), m.polymer);
  const fg = k.group(null, body, 0, 0.004, -0.186);
  fg.rotation.x = 0.12;
  k.add(fg, new THREE.CapsuleGeometry(0.0135, 0.058, k.seg(4, 2), k.seg(14)), m.rubber, 0, -0.038, 0);
  k.add(fg, k.cylY(0.012, 0.006, 16), m.gunmetal, 0, -0.0795, 0);
  if (hi) {
    const rib = k.torus(0.0137, 0.0016, 4, 14);
    for (const y of [-0.02, -0.038, -0.056]) k.add(fg, rib, m.rubber, 0, y, 0, Math.PI / 2);
  }

  // ---- Folding skeletal stock ----
  const stock = [[0.058, 0.09], [0.18, 0.086], [0.198, 0.08], [0.2, -0.02], [0.188, -0.028], [0.17, -0.026], [0.06, 0.04]];
  const stockHole = [[0.09, 0.074], [0.17, 0.072], [0.176, 0.06], [0.178, -0.008], [0.168, -0.01]];
  k.add(body, k.side(stock, 0.028, { holes: [stockHole], bevel: 0.003 }), m.polymer);
  const butt = [[0.196, 0.082], [0.208, 0.082], [0.21, 0.074], [0.21, -0.022], [0.204, -0.03], [0.194, -0.026]];
  k.add(body, k.side(butt, 0.032, { bevel: 0.003 }), m.rubber);
  k.add(body, k.box(0.032, 0.03, 0.012), m.gunmetal, 0, 0.06, 0.064);
  k.add(body, k.cylY(0.004, 0.034, 10), m.steel, 0, 0.06, 0.064);
  k.stripPair(0.0012, 0.002, 0.07, 0.0142, 0.08, 0.13);

  // ---- Mini reflex sight ----
  const oBase = [[0.006, 0.1075], [0.006, 0.114], [0.0, 0.118], [-0.036, 0.118], [-0.044, 0.112], [-0.044, 0.1075]];
  k.add(body, k.side(oBase, 0.024, { bevel: 0.0015 }), m.gunmetal);
  const frameOuter = [[-0.0145, 0.116], [0.0145, 0.116], [0.0145, 0.136], [0.008, 0.145], [-0.008, 0.145], [-0.0145, 0.136]];
  const frameHole = [[-0.0115, 0.12], [0.0115, 0.12], [0.0115, 0.134], [0.006, 0.141], [-0.006, 0.141], [-0.0115, 0.134]];
  k.add(body, k.axial(frameOuter, -0.03, -0.042, { holes: [frameHole], bevel: 0.001 }), m.gunmetal);
  k.add(body, new THREE.PlaneGeometry(0.023, 0.021), m.glass, 0, 0.1305, -0.036, -0.12);
  k.add(body, k.box(0.016, 0.006, 0.012), m.gunmetal, 0, 0.121, -0.004);
  k.glow(k.box(0.0012, 0.0012, 0.0004), 0, 0.1305, -0.0368);
  k.glow(k.torus(0.0024, 0.0003, 3, 16), 0, 0.1305, -0.0368);
  if (hi) k.add(body, k.box(0.004, 0.002, 0.004), m.steel, 0.006, 0.1192, 0.002);

  // ---- Stick magazine (local space, origin at the top) ----
  k.add(mag, k.side([[0.02, 0], [0.02, -0.2], [-0.02, -0.2], [-0.02, 0]], 0.021, { bevel: 0.002 }), m.polymer);
  k.add(mag, k.side([[0.022, -0.198], [0.024, -0.214], [-0.024, -0.214], [-0.022, -0.198]], 0.025, { bevel: 0.002 }), m.gunmetal);
  const whiteBolt = k.side(BOLT.map(([a, b]) => [a * 0.012, b * 0.018]), 0.0008, { bevel: 0 });
  k.pair(mag, whiteBolt, m.white, 0.0107, -0.14, 0);
  if (hi) {
    const rib = k.box(0.0225, 0.003, 0.038);
    for (const y of [-0.075, -0.1, -0.175]) k.add(mag, rib, m.polymer, 0, y, 0);
    k.add(mag, k.cylZ(0.0042, 0.0042, 0.02, 12), m.brass, 0, 0.003, 0.006);
    k.add(mag, k.cylZ(0.0012, 0.0042, 0.008, 12), m.steel, 0, 0.003, -0.008);
  }

  k.marker(root, 'muzzle', 0, BORE_Y, -0.354);
  k.marker(root, 'sight', 0, 0.1305, 0.006);
  return k.finish(root, body, mag);
}

const volt = {
  id: 'volt', name: 'VOLT SMG', slot: 'primary', type: 'hitscan', damage: 14, headMul: 1.4, rpm: 950, auto: true,
  mag: 36, reserve: 144, reloadTime: 1.7, pellets: 1,
  spread: { base: 1.1, move: 0.9, air: 2.2, ads: 0.6, perShot: 0.22, max: 5.0, recover: 11 },
  recoil: { pitch: 0.3, yaw: 0.32, recover: 13, kick: 0.6 },
  falloff: { start: 12, end: 30, min: 0.55 }, range: 120,
  adsFov: 0.85, adsTime: 0.11, moveMul: 1.06, fireMoveMul: 1.04, switchTime: 0.24,
  knockback: 0, pickupRespawn: 15, rare: false, sound: 'volt_fire', tracer: 0.4, color: 0x7dff1a,
  buildModel,
};

export default volt;

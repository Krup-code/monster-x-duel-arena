// VENOM DMR - long precision rifle: octagonal handguard with snake-scale cut plates glowing
// from beneath, fluted barrel, fang muzzle brake and a big scope with a glowing lens ring.
import * as THREE from 'three';
import { createKit } from './materials.js';

const BORE_Y = 0.064;
const SCOPE_Y = 0.142;

function scaleHoles() {
  const holes = [];
  const dz = 0.0085;
  const dy = 0.0048;
  const rows = [
    { y: 0.0575, z0: -0.215 },
    { y: 0.0705, z0: -0.2255 },
  ];
  for (const { y, z0 } of rows) {
    for (let c = z0; c > -0.496; c -= 0.021) {
      holes.push([[c - dz, y], [c, y + dy], [c + dz, y], [c, y - dy]]);
    }
  }
  return holes;
}

function buildModel({ detail = 'high' } = {}) {
  const k = createKit(detail);
  const { m, hi } = k;

  const root = new THREE.Group();
  root.name = 'weapon_venom';
  const body = k.group('body', root);
  root.add(k.energy);
  const mag = k.group('magazine', root, 0, 0.02, -0.115);
  mag.rotation.x = 0.03;

  // ---- Lower + upper receivers ----
  const lower = [
    [0.06, 0.052], [0.06, 0.028], [0.044, 0.014], [-0.006, 0.014], [-0.006, -0.006], [-0.016, -0.014], [-0.072, -0.014],
    [-0.08, -0.024], [-0.082, -0.036], [-0.15, -0.036], [-0.154, -0.02], [-0.158, 0.004], [-0.16, 0.052],
  ];
  const guard = [[-0.068, 0.01], [-0.068, -0.004], [-0.062, -0.008], [-0.016, -0.008], [-0.012, 0.006], [-0.012, 0.01]];
  k.add(body, k.side(lower, 0.032, { holes: [guard], bevel: 0.002 }), m.polymer);
  k.trigger(body, -0.034, 0.012);
  k.grip(body, { z: -0.004, y: 0.016, height: 0.1, depth: 0.046, width: 0.031, rake: 0.3 });
  k.decalPair(body, 0.052, 0.012, 0.0166, -0.022, -0.116);

  const upper = [[0.062, 0.05], [0.062, 0.088], [0.056, 0.094], [-0.168, 0.094], [-0.168, 0.05]];
  k.add(body, k.side(upper, 0.032, { bevel: 0.0025 }), m.gunmetal);
  k.add(body, k.box(0.034, 0.005, 0.01), m.steel, 0, 0.0905, 0.068);
  k.add(body, k.box(0.008, 0.004, 0.01), m.steel, -0.021, 0.0905, 0.068);
  k.add(body, k.box(0.0012, 0.013, 0.05), m.dark, 0.0162, 0.07, -0.035);
  k.add(body, k.box(0.01, 0.016, 0.026), m.gunmetal, 0.017, 0.074, 0.04);
  k.add(body, k.cylZ(0.0065, 0.0065, 0.024, 16), m.steel, 0.019, 0.074, 0.038);
  k.add(body, k.box(0.0015, 0.004, 0.013), m.steel, -0.0167, 0.033, 0.022, 0.4);
  k.add(body, k.cylX(0.004, 0.002, 12), m.steel, -0.0165, 0.033, 0.022);
  k.add(body, k.cylX(0.004, 0.002, 12), m.steel, 0.0168, 0.022, -0.078);
  k.add(body, k.cylX(0.0035, 0.0345, 10), m.steel, 0, 0.044, 0.052);
  k.add(body, k.cylX(0.0035, 0.0345, 10), m.steel, 0, 0.046, -0.148);
  if (hi) k.add(body, k.box(0.0004, 0.002, 0.002), m.warn, -0.0163, 0.026, 0.031);

  // ---- Octagonal handguard + snake-scale plates ----
  const oct = [[-0.012, 0.094], [0.012, 0.094], [0.025, 0.081], [0.025, 0.047], [0.012, 0.034], [-0.012, 0.034], [-0.025, 0.047], [-0.025, 0.081]];
  k.add(body, k.axial(oct, -0.165, -0.56, { bevel: 0.002 }), m.gunmetal);
  k.rail(body, 0.058, -0.205, 0.094, 0.021);
  k.screwPair(body, 0.0252, 0.064, -0.18);
  k.screwPair(body, 0.0252, 0.064, -0.54);
  if (hi) {
    // Scale-cut inlay plates float just above a glowing strip so the diamonds shine through.
    const plate = [[-0.2, 0.05], [-0.2, 0.078], [-0.505, 0.078], [-0.522, 0.064], [-0.505, 0.05]];
    const holes = scaleHoles();
    for (const s of [1, -1]) k.add(body, k.facePlate(plate, s, { holes }), m.polymer, s * 0.0256, 0, 0);
    k.stripPair(0.0003, 0.027, 0.297, 0.02515, 0.064, -0.3535);
  } else {
    k.stripPair(0.001, 0.004, 0.3, 0.0252, 0.064, -0.355);
  }
  if (hi) for (const z of [-0.33, -0.39, -0.45]) k.add(body, k.box(0.012, 0.001, 0.03), m.dark, 0, 0.0336, z);

  // ---- Fluted barrel + fang brake ----
  k.add(body, k.cylZ(0.0098, 0.0098, 0.205, 18), m.steel, 0, BORE_Y, -0.6585);
  k.add(body, k.cylZ(0.014, 0.014, 0.012, 20), m.gunmetal, 0, BORE_Y, -0.562);
  if (hi) {
    const flute = k.box(0.0012, 0.0022, 0.15);
    for (let i = 0; i < 6; i++) {
      const a = (i * Math.PI) / 3;
      k.add(body, flute, m.dark, Math.cos(a) * 0.0095, BORE_Y + Math.sin(a) * 0.0095, -0.66, 0, 0, a);
    }
  }
  k.add(body, k.cylZ(0.0135, 0.0135, 0.046, 18), m.gunmetal, 0, BORE_Y, -0.781);
  k.add(body, k.cylZ(0.012, 0.012, 0.004, 18), m.steel, 0, BORE_Y, -0.806);
  k.add(body, k.cylZ(0.0042, 0.0042, 0.001, 12), m.dark, 0, BORE_Y, -0.8082);
  const port = k.box(0.0012, 0.007, 0.008);
  for (const z of [-0.772, -0.788]) k.pair(body, port, m.dark, 0.0134, BORE_Y, z);
  const fang = [[-0.77, 0.058], [-0.8, 0.058], [-0.806, 0.05], [-0.806, 0.04], [-0.802, 0.03], [-0.797, 0.02], [-0.794, 0.034], [-0.786, 0.046], [-0.774, 0.052]];
  k.pair(body, k.side(fang, 0.006, { bevel: 0.001, bevelSegments: 1 }), m.white, 0.0085, 0, 0);
  const drop = new THREE.SphereGeometry(0.0022, k.seg(6, 4), k.seg(4, 3));
  k.pair(k.energy, drop, k.energyMat, 0.0085, 0.0215, -0.7975);

  // ---- Precision stock: cheek riser, skeleton cut, pad, venom drip line ----
  const stock = [[0.058, 0.088], [0.196, 0.088], [0.206, 0.08], [0.206, -0.04], [0.194, -0.046], [0.176, -0.044], [0.166, -0.01], [0.1, 0.02], [0.06, 0.03]];
  const sHole = [[0.11, 0.07], [0.18, 0.07], [0.184, 0.04], [0.172, 0.004], [0.15, 0.012]];
  k.add(body, k.side(stock, 0.036, { holes: [sHole], bevel: 0.004 }), m.polymer);
  const riser = [[0.08, 0.086], [0.08, 0.098], [0.09, 0.106], [0.186, 0.106], [0.192, 0.1], [0.192, 0.086]];
  k.add(body, k.side(riser, 0.03, { bevel: 0.003 }), m.gunmetal);
  k.pair(body, k.cylX(0.006, 0.006, 16), m.steel, 0.0195, 0.06, 0.075);
  const pad = [[0.204, 0.086], [0.216, 0.086], [0.218, 0.078], [0.218, -0.044], [0.212, -0.05], [0.204, -0.046]];
  k.add(body, k.side(pad, 0.04, { bevel: 0.003 }), m.rubber);
  k.stripPair(0.0012, 0.0022, 0.095, 0.0182, 0.079, 0.1435);
  k.stripPair(0.0012, 0.009, 0.0022, 0.0182, 0.0745, 0.0965);
  k.pair(k.energy, drop, k.energyMat, 0.0182, 0.0688, 0.0965);

  // ---- Scope ----
  for (const z of [-0.03, -0.15]) {
    k.add(body, k.box(0.026, 0.022, 0.018), m.gunmetal, 0, 0.1145, z);
    k.add(body, k.torus(0.0168, 0.0035, 5, 18), m.gunmetal, 0, SCOPE_Y, z);
    k.screwPair(body, 0.0128, 0.112, z + 0.005);
  }
  k.add(body, k.cylZ(0.015, 0.015, 0.19, 20), m.gunmetal, 0, SCOPE_Y, -0.075);
  const objective = [[0.015, -0.168], [0.015, -0.172], [0.0255, -0.205], [0.0262, -0.208], [0.0262, -0.244], [0.025, -0.25], [0.0215, -0.25], [0.0215, -0.246]];
  k.add(body, k.lathe(objective, 22), m.gunmetal, 0, SCOPE_Y, 0);
  const ocular = [[0.019, 0.072], [0.0195, 0.07], [0.0195, 0.036], [0.0185, 0.034], [0.015, 0.022], [0.015, 0.018]];
  k.add(body, k.lathe(ocular, 20), m.gunmetal, 0, SCOPE_Y, 0);
  const eyecup = [[0.0165, 0.087], [0.0165, 0.09], [0.0195, 0.09], [0.0205, 0.086], [0.0205, 0.07], [0.0198, 0.068]];
  k.add(body, k.lathe(eyecup, 20), m.rubber, 0, SCOPE_Y, 0);
  const front = k.circle(0.0218, 22);
  front.rotateY(Math.PI);
  k.add(body, front, m.lens, 0, SCOPE_Y, -0.246);
  k.add(body, k.circle(0.0168, 20), m.lens, 0, SCOPE_Y, 0.087);
  k.glow(k.torus(0.0238, 0.0016, 4, 28), 0, SCOPE_Y, -0.2505);
  k.glow(k.torus(0.0197, 0.0008, 3, 20), 0, SCOPE_Y, 0.05);

  // Turret saddle, elevation (top), windage (right), illumination / parallax (left, glowing ring).
  k.add(body, k.side([[-0.055, 0.13], [-0.058, 0.158], [-0.092, 0.158], [-0.095, 0.13]], 0.034, { bevel: 0.002 }), m.gunmetal);
  k.add(body, k.cylY(0.0105, 0.016, 16), m.gunmetal, 0, 0.163, -0.075);
  k.add(body, k.cylY(0.0115, 0.008, 18), m.steel, 0, 0.174, -0.075);
  k.add(body, k.cylX(0.0095, 0.014, 16), m.gunmetal, 0.022, SCOPE_Y, -0.075);
  k.add(body, k.cylX(0.0105, 0.007, 18), m.steel, 0.0325, SCOPE_Y, -0.075);
  k.add(body, k.cylX(0.0105, 0.012, 16), m.gunmetal, -0.021, SCOPE_Y, -0.075);
  k.glow(k.torus(0.0098, 0.0009, 3, 18), -0.0272, SCOPE_Y, -0.075, 0, Math.PI / 2);
  if (hi) {
    k.add(body, k.box(0.0008, 0.006, 0.0006), m.white, 0, 0.174, -0.0632);
    k.add(body, k.box(0.0006, 0.006, 0.0008), m.white, 0.0362, SCOPE_Y, -0.075);
  }

  // ---- Box magazine (local space, origin at the top) ----
  const magProf = [[0.03, 0], [0.03, -0.1], [0.028, -0.112], [-0.034, -0.112], [-0.035, -0.1], [-0.031, 0]];
  k.add(mag, k.side(magProf, 0.024, { bevel: 0.0025 }), m.polymer);
  k.add(mag, k.side([[0.032, -0.106], [0.032, -0.118], [-0.038, -0.118], [-0.038, -0.106]], 0.028, { bevel: 0.002 }), m.gunmetal);
  if (hi) {
    k.pair(mag, k.box(0.0006, 0.002, 0.026), m.white, 0.0122, -0.08, 0);
    k.add(mag, k.box(0.022, 0.004, 0.05), m.gunmetal, 0, -0.002, 0);
    k.add(mag, k.cylZ(0.0052, 0.0052, 0.04, 12), m.brass, 0, 0.004, 0.006);
    k.add(mag, k.cylZ(0.0012, 0.0052, 0.016, 12), m.steel, 0, 0.004, -0.022);
  }

  k.marker(root, 'muzzle', 0, BORE_Y, -0.808);
  k.marker(root, 'sight', 0, SCOPE_Y, 0.09);
  return k.finish(root, body, mag);
}

const venom = {
  id: 'venom', name: 'VENOM DMR', slot: 'primary', type: 'hitscan', damage: 45, headMul: 1.8, rpm: 220, auto: false,
  mag: 12, reserve: 36, reloadTime: 2.1, pellets: 1,
  spread: { base: 0.12, move: 2.4, air: 4.0, ads: 0.0, perShot: 0.5, max: 4.0, recover: 8 },
  recoil: { pitch: 1.7, yaw: 0.35, recover: 9, kick: 1.6 },
  falloff: null, range: 260,
  adsFov: 0.5, adsTime: 0.2, moveMul: 0.97, fireMoveMul: 0.9, switchTime: 0.34, scope: true,
  knockback: 0, pickupRespawn: 15, rare: false, sound: 'venom_fire', tracer: 1.0, color: 0x7dff1a,
  buildModel,
};

export default venom;

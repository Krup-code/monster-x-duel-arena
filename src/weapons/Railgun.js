// ENERGY RAIL - bulky railgun: exposed glowing core wrapped by helical charging coils inside a
// steel cage, capacitor pods, twin rail prongs at the muzzle and a swappable energy cell.
import * as THREE from 'three';
import { createKit, makeEnergyMaterial, ENERGY_INTENSITY } from './materials.js';

const BORE_Y = 0.075;

class Helix extends THREE.Curve {
  constructor(radius, length, turns) {
    super();
    this.radius = radius;
    this.length = length;
    this.turns = turns;
  }

  getPoint(t, target = new THREE.Vector3()) {
    const a = t * this.turns * Math.PI * 2;
    return target.set(Math.cos(a) * this.radius, Math.sin(a) * this.radius, (0.5 - t) * this.length);
  }
}

function buildModel({ detail = 'high' } = {}) {
  const k = createKit(detail);
  const { m, hi } = k;

  const root = new THREE.Group();
  root.name = 'weapon_rail';
  const body = k.group('body', root);
  root.add(k.energy);
  // Coils live inside the energy group (they glow) but have their own material so the
  // game can spin / brighten them independently while recharging. Axis = bore axis.
  const coil = k.group('coil', k.energy, 0, BORE_Y, 0);
  const coilMat = makeEnergyMaterial(ENERGY_INTENSITY);
  coil.userData.material = coilMat;
  const cell = k.group('magazine', root, 0, 0.014, -0.119);

  // ---- Main body, magwell collar, trigger plate, grip ----
  const shell = [[0.08, 0.022], [0.08, 0.118], [0.062, 0.138], [-0.12, 0.138], [-0.15, 0.126], [-0.212, 0.126], [-0.222, 0.114], [-0.222, 0.03], [-0.208, 0.018], [0.05, 0.018]];
  k.add(body, k.side(shell, 0.07, { bevel: 0.005 }), m.gunmetal);
  const collar = [[-0.084, 0.02], [-0.084, 0.004], [-0.088, -0.004], [-0.15, -0.004], [-0.154, 0.004], [-0.154, 0.02]];
  k.add(body, k.side(collar, 0.054, { bevel: 0.003 }), m.gunmetal);
  const plate = [[0.044, 0.02], [-0.08, 0.02], [-0.08, 0.006], [-0.074, -0.014], [-0.012, -0.014], [-0.006, 0.014], [0.04, 0.014]];
  const guard = [[-0.066, 0.01], [-0.066, -0.004], [-0.06, -0.008], [-0.02, -0.008], [-0.016, 0.01]];
  k.add(body, k.side(plate, 0.03, { holes: [guard], bevel: 0.002 }), m.polymer);
  k.trigger(body, -0.036, 0.012);
  k.grip(body, { z: -0.004, y: 0.02, height: 0.102, depth: 0.048, width: 0.034, rake: 0.28 });

  // Layered side armor with glowing vent slits and a rear heat sink.
  const panel = [[0.06, 0.04], [0.06, 0.11], [0.045, 0.126], [-0.11, 0.126], [-0.13, 0.11], [-0.13, 0.05], [-0.11, 0.034]];
  k.pair(body, k.side(panel, 0.006, { bevel: 0.0015 }), m.polymer, 0.037, 0, 0);
  for (const y of hi ? [0.058, 0.068, 0.078] : [0.068]) k.stripPair(0.001, 0.0035, 0.045, 0.0402, y, -0.07);
  if (hi) {
    const fin = k.box(0.004, 0.05, 0.0025);
    for (let i = 0; i < 6; i++) k.pair(body, fin, m.steel, 0.042, 0.075, 0.012 + i * 0.007);
  }
  k.decalPair(body, 0.07, 0.016, 0.0406, 0.104, -0.04);
  k.screwPair(body, 0.0402, 0.045, 0.05);
  k.screwPair(body, 0.0402, 0.045, -0.118);
  k.screwPair(body, 0.0402, 0.117, -0.118);

  // ---- Stock ----
  const stock = [[0.078, 0.12], [0.27, 0.108], [0.292, 0.1], [0.3, 0.08], [0.3, -0.03], [0.288, -0.04], [0.268, -0.036], [0.15, 0.03], [0.078, 0.04]];
  const sHole = [[0.12, 0.09], [0.255, 0.088], [0.268, 0.07], [0.27, -0.01], [0.25, -0.012]];
  k.add(body, k.side(stock, 0.05, { holes: [sHole], bevel: 0.005 }), m.polymer);
  const pad = [[0.296, 0.102], [0.31, 0.1], [0.312, 0.09], [0.312, -0.034], [0.306, -0.044], [0.294, -0.04]];
  k.add(body, k.side(pad, 0.054, { bevel: 0.004 }), m.rubber);
  k.stripPair(0.0012, 0.0024, 0.15, 0.0252, 0.1046, 0.18, 0.0625);

  // ---- Exposed core, cage, spines, coil housings ----
  k.glow(k.cylZ(0.016, 0.016, 0.34, 16), 0, BORE_Y, -0.38);
  const rod = k.box(0.007, 0.007, 0.34);
  for (const [sx, sy] of [[1, 1], [-1, 1], [1, -1], [-1, -1]]) {
    k.add(body, rod, m.steel, sx * 0.026, BORE_Y + sy * 0.026, -0.38, 0, 0, Math.PI / 4);
  }
  k.add(body, k.side([[-0.205, 0.104], [-0.205, 0.124], [-0.54, 0.124], [-0.556, 0.112], [-0.556, 0.104]], 0.02, { bevel: 0.002 }), m.gunmetal);
  k.add(body, k.side([[-0.205, 0.03], [-0.205, 0.046], [-0.556, 0.046], [-0.556, 0.036], [-0.54, 0.03]], 0.018, { bevel: 0.002 }), m.gunmetal);
  if (hi) for (const z of [-0.3, -0.376, -0.452]) k.add(body, k.box(0.012, 0.0012, 0.02), m.dark, 0, 0.1242, z);
  for (const z of [-0.262, -0.338, -0.414, -0.49]) {
    const ring = [[0.03, z + 0.01], [0.045, z + 0.01], [0.045, z - 0.01], [0.03, z - 0.01], [0.03, z + 0.01]];
    k.add(body, k.lathe(ring, 16), m.gunmetal, 0, BORE_Y, 0);
  }

  // Helical charging coils (spin around the bore axis).
  const tubular = hi ? 30 : 16;
  const radial = hi ? 4 : 3;
  for (const [z, len] of [[-0.3, 0.04], [-0.376, 0.04], [-0.452, 0.04], [-0.522, 0.03]]) {
    const geo = new THREE.TubeGeometry(new Helix(0.024, len, len * 62), tubular, 0.0022, radial, false);
    k.glow(geo, 0, 0, z, 0, 0, 0, coil, coilMat);
  }

  // Capacitor pods with glowing charge windows.
  k.pair(body, k.cylZ(0.01, 0.01, 0.11, 16), m.steel, 0.052, 0.052, -0.29);
  k.pair(body, k.cylZ(0.011, 0.011, 0.008, 16), m.gunmetal, 0.052, 0.052, -0.231);
  k.pair(body, k.cylZ(0.011, 0.011, 0.008, 16), m.gunmetal, 0.052, 0.052, -0.349);
  k.pair(k.energy, k.cylZ(0.0103, 0.0103, 0.03, 16), k.energyMat, 0.052, 0.052, -0.29);
  for (const z of [-0.262, -0.338]) k.pair(body, k.box(0.016, 0.01, 0.012), m.gunmetal, 0.042, 0.052, z);

  // ---- Front block, emitter, rail prongs ----
  const block = [[-0.538, 0.03], [-0.538, 0.122], [-0.552, 0.13], [-0.588, 0.13], [-0.598, 0.118], [-0.598, 0.032], [-0.588, 0.02], [-0.552, 0.02]];
  k.add(body, k.side(block, 0.06, { bevel: 0.004 }), m.gunmetal);
  k.glow(k.box(0.016, 0.02, 0.0015), 0, BORE_Y, -0.5988);
  k.screwPair(body, 0.03, 0.04, -0.568);
  k.screwPair(body, 0.03, 0.11, -0.568);
  const prongTop = [[-0.585, 0.088], [-0.585, 0.118], [-0.64, 0.113], [-0.76, 0.1], [-0.803, 0.091], [-0.792, 0.086], [-0.7, 0.086]];
  const prongBot = prongTop.map(([z, y]) => [z, 2 * BORE_Y - y]);
  k.add(body, k.side(prongTop, 0.026, { bevel: 0.002 }), m.steel);
  k.add(body, k.side(prongBot, 0.026, { bevel: 0.002 }), m.steel);
  k.strip(0.01, 0.0014, 0.2, 0, 0.0853, -0.69);
  k.strip(0.01, 0.0014, 0.2, 0, 2 * BORE_Y - 0.0853, -0.69);
  k.stripPair(0.001, 0.0018, 0.15, 0.0132, 0.0915, -0.675);
  k.stripPair(0.001, 0.0018, 0.15, 0.0132, 2 * BORE_Y - 0.0915, -0.675);
  if (hi) for (const y of [0.106, 2 * BORE_Y - 0.106]) k.pair(body, k.box(0.0012, 0.004, 0.03), m.white, 0.0132, y, -0.62);

  // ---- Digital scope ----
  k.add(body, k.box(0.03, 0.008, 0.12), m.gunmetal, 0, 0.141, -0.04);
  const scope = [[0.07, 0.144], [0.07, 0.186], [0.055, 0.196], [-0.12, 0.196], [-0.15, 0.186], [-0.15, 0.152], [-0.135, 0.144]];
  k.add(body, k.side(scope, 0.048, { bevel: 0.003 }), m.gunmetal);
  k.add(body, new THREE.PlaneGeometry(0.032, 0.03), m.lens, 0, 0.17, 0.0706);
  k.strip(0.034, 0.0012, 0.0008, 0, 0.1856, 0.0708);
  k.strip(0.034, 0.0012, 0.0008, 0, 0.1544, 0.0708);
  k.stripPair(0.0012, 0.0312, 0.0008, 0.017, 0.17, 0.0708);
  const sLens = k.circle(0.015, 24);
  sLens.rotateY(Math.PI);
  k.add(body, sLens, m.lens, 0, 0.169, -0.1505);
  k.glow(k.torus(0.0155, 0.0012, 4, 28), 0, 0.169, -0.151);
  k.glow(k.box(0.0008, 0.01, 0.03), -0.0244, 0.176, -0.04);
  k.add(body, k.box(0.014, 0.02, 0.04), m.gunmetal, 0.03, 0.168, -0.09);
  const rfLens = k.circle(0.006, 16);
  rfLens.rotateY(Math.PI);
  k.add(body, rfLens, m.lens, 0.03, 0.168, -0.1102);

  // ---- Energy cell (local space, origin at the top) ----
  const cellProf = [[0.028, 0], [0.028, -0.068], [0.02, -0.078], [-0.02, -0.078], [-0.028, -0.068], [-0.028, 0]];
  k.add(cell, k.side(cellProf, 0.044, { bevel: 0.003 }), m.gunmetal);
  k.add(cell, k.box(0.0456, 0.026, 0.034), m.lens, 0, -0.044, 0);
  k.add(cell, k.box(0.02, 0.004, 0.001), m.warn, 0, -0.06, 0.0285);
  if (hi) {
    k.pair(cell, k.box(0.0006, 0.003, 0.012), m.white, 0.0222, -0.024, 0.012);
    k.pair(cell, k.box(0.006, 0.004, 0.006), m.steel, 0.01, 0.002, 0);
  }

  k.marker(root, 'muzzle', 0, BORE_Y, -0.803);
  k.marker(root, 'sight', 0, 0.17, 0.071);
  return k.finish(root, body, cell, coil);
}

const rail = {
  id: 'rail', name: 'ENERGY RAIL', slot: 'special', type: 'hitscan', damage: 90, headDamage: 150, headMul: 1.6667, rpm: 40, auto: false,
  mag: 5, reserve: 5, reloadTime: 2.6, pellets: 1, chargeSound: true,
  spread: { base: 0, move: 0.4, air: 0.8, ads: 0, perShot: 0, max: 1.0, recover: 10 },
  recoil: { pitch: 3.2, yaw: 0.4, recover: 6, kick: 2.4 },
  falloff: null, range: 300, pierce: false,
  adsFov: 0.42, adsTime: 0.22, moveMul: 0.96, fireMoveMul: 0.9, switchTime: 0.38, scope: true,
  knockback: 2.0, pickupRespawn: 28, rare: true, sound: 'rail_fire', tracer: 1.0, color: 0x9dff3a,
  buildModel,
};

export default rail;

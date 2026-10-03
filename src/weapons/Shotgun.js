// CRUSH SHOTGUN - heavy pump-action: chunky receiver, tube magazine, ribbed pump,
// ported box muzzle brake, ghost-ring sights and a side saddle of shells.
import * as THREE from 'three';
import { createKit } from './materials.js';

const BORE_Y = 0.074;
const TUBE_Y = 0.04;

function buildModel({ detail = 'high' } = {}) {
  const k = createKit(detail);
  const { m, hi } = k;

  const root = new THREE.Group();
  root.name = 'weapon_crush';
  const body = k.group('body', root);
  root.add(k.energy);
  // Pump origin at its center; slides +Z when racking.
  const pump = k.group('pump', root, 0, TUBE_Y, -0.39);

  // ---- Receiver + trigger plate ----
  const recv = [[0.062, 0.03], [0.062, 0.094], [0.048, 0.108], [-0.15, 0.108], [-0.172, 0.096], [-0.172, 0.03], [-0.16, 0.022], [0.05, 0.022]];
  k.add(body, k.side(recv, 0.046, { bevel: 0.004 }), m.gunmetal);
  const plate = [[0.046, 0.026], [-0.112, 0.026], [-0.112, 0.014], [-0.1, 0.01], [-0.08, -0.004], [-0.074, -0.014], [-0.012, -0.014], [-0.004, 0.012], [0.04, 0.012]];
  const guard = [[-0.068, 0.018], [-0.068, 0.0], [-0.06, -0.008], [-0.016, -0.008], [-0.012, 0.004], [-0.012, 0.018]];
  k.add(body, k.side(plate, 0.034, { holes: [guard], bevel: 0.002 }), m.polymer);
  k.trigger(body, -0.034, 0.018);
  k.grip(body, { z: -0.004, y: 0.014, height: 0.1, depth: 0.046, width: 0.034, rake: 0.3 });

  // Loading port (bottom), ejection port + bolt face (right), safety, pins.
  k.add(body, k.box(0.02, 0.0012, 0.04), m.dark, 0, 0.0216, -0.14);
  k.add(body, k.box(0.0012, 0.02, 0.06), m.dark, 0.0232, 0.084, -0.07);
  k.add(body, k.box(0.0012, 0.012, 0.024), m.steel, 0.0236, 0.084, -0.06);
  // Cross-bolt safety through the trigger plate (red ring = FIRE side).
  k.add(body, k.cylX(0.004, 0.037, 12), m.steel, 0, 0.019, -0.086);
  if (hi) k.add(body, k.cylX(0.0026, 0.001, 10), m.warn, 0.0189, 0.019, -0.086);
  k.add(body, k.cylX(0.0035, 0.0475, 10), m.steel, 0, 0.034, 0.03);
  k.add(body, k.cylX(0.0035, 0.0475, 10), m.steel, 0, 0.034, -0.1);
  k.screwPair(body, 0.0232, 0.06, -0.16);
  k.decal(body, 0.06, 0.014, 0.0236, 0.045, -0.11, 1);

  // Energy: top-edge lines and twin chevrons on the receiver.
  k.stripPair(0.0012, 0.0028, 0.17, 0.0232, 0.099, -0.06);
  for (const dz of [0, 0.012]) {
    k.stripPair(0.0012, 0.0024, 0.022, 0.0232, 0.0652, 0.0331 + dz, -0.6);
    k.stripPair(0.0012, 0.0024, 0.022, 0.0232, 0.0528, 0.0331 + dz, 0.6);
  }

  // Side saddle with four shells (left side, faces the player).
  k.add(body, k.box(0.005, 0.044, 0.096), m.gunmetal, -0.0255, 0.066, -0.074);
  const hull = k.cylY(0.0102, 0.046, 14);
  const head = k.cylY(0.0108, 0.009, 14);
  for (let i = 0; i < 4; i++) {
    const z = -0.038 - i * 0.024;
    k.add(body, hull, m.shell, -0.0385, 0.062, z);
    k.add(body, head, m.brass, -0.0385, 0.0895, z);
  }

  // Ghost-ring rear sight.
  const gBase = [[0.04, 0.106], [0.04, 0.113], [0.034, 0.116], [0.004, 0.116], [0.0, 0.106]];
  k.add(body, k.side(gBase, 0.03, { bevel: 0.0015 }), m.gunmetal);
  k.pair(body, k.box(0.0045, 0.016, 0.016), m.gunmetal, 0.0125, 0.123, 0.02);
  k.add(body, k.torus(0.0062, 0.0018, 6, 18), m.gunmetal, 0, 0.1215, 0.02);
  k.add(body, k.box(0.004, 0.004, 0.004), m.gunmetal, 0, 0.1155, 0.02);

  // ---- Barrel, vent rib, front fiber sight ----
  k.add(body, k.cylZ(0.0125, 0.0125, 0.488, 20), m.steel, 0, BORE_Y, -0.416);
  k.add(body, k.cylZ(0.016, 0.016, 0.016, 20), m.gunmetal, 0, BORE_Y, -0.178);
  k.add(body, k.box(0.008, 0.003, 0.46), m.gunmetal, 0, 0.093, -0.405);
  if (hi) {
    const post = k.box(0.004, 0.006, 0.004);
    for (let z = -0.19; z > -0.64; z -= 0.045) k.add(body, post, m.gunmetal, 0, 0.0895, z);
  } else {
    k.add(body, k.box(0.003, 0.006, 0.46), m.gunmetal, 0, 0.0895, -0.405);
  }
  const ramp = [[-0.622, 0.093], [-0.626, 0.11], [-0.636, 0.118], [-0.642, 0.118], [-0.642, 0.093]];
  k.add(body, k.side(ramp, 0.008, { bevel: 0.001 }), m.gunmetal);
  if (hi) k.pair(body, k.box(0.0025, 0.012, 0.014), m.gunmetal, 0.0065, 0.118, -0.635);
  k.glow(k.cylZ(0.0017, 0.0017, 0.012, 10), 0, 0.1213, -0.636);

  // ---- Tube magazine + cap + barrel clamp ----
  k.add(body, k.cylZ(0.0135, 0.0135, 0.43, 18), m.gunmetal, 0, TUBE_Y, -0.387);
  const cap = [[0.0138, -0.6], [0.0148, -0.604], [0.0148, -0.618], [0.012, -0.626], [0.006, -0.629], [0.0, -0.63]];
  k.add(body, k.lathe(cap, 18), m.steel, 0, TUBE_Y, 0);
  k.glow(k.torus(0.0149, 0.0012, 4, 20), 0, TUBE_Y, -0.611);
  k.add(body, k.side([[-0.578, 0.03], [-0.578, 0.082], [-0.592, 0.082], [-0.592, 0.03]], 0.026, { bevel: 0.003 }), m.gunmetal);
  k.screwPair(body, 0.013, 0.056, -0.585);

  // ---- Ported box muzzle brake ----
  const brake = [[-0.652, 0.05], [-0.652, 0.098], [-0.738, 0.098], [-0.749, 0.088], [-0.749, 0.06], [-0.738, 0.05]];
  const ports = [[-0.666, -0.681], [-0.69, -0.705], [-0.714, -0.729]].map(([a, b]) => [[a, 0.058], [b, 0.058], [b, 0.09], [a, 0.09]]);
  k.add(body, k.side(brake, 0.04, { holes: ports, bevel: 0.0025 }), m.gunmetal);
  k.add(body, k.cylZ(0.0105, 0.0105, 0.002, 18), m.dark, 0, BORE_Y, -0.749);
  if (hi) for (const z of [-0.7, -0.722]) k.add(body, k.box(0.016, 0.0012, 0.006), m.dark, 0, 0.0982, z);
  k.stripPair(0.001, 0.0024, 0.08, 0.0203, 0.0542, -0.7);

  // ---- Pump (local space) ----
  const pumpProf = [[0.085, 0.03], [-0.085, 0.03], [-0.091, 0.022], [-0.091, -0.02], [-0.082, -0.03], [0.082, -0.03], [0.091, -0.02], [0.091, 0.022]];
  k.add(pump, k.side(pumpProf, 0.058, { bevel: 0.006 }), m.polymer);
  const rib = k.box(0.061, 0.046, 0.007);
  for (let i = 0; i < (hi ? 6 : 3); i++) {
    const z = hi ? -0.06 + i * 0.024 : -0.048 + i * 0.048;
    k.add(pump, rib, m.rubber, 0, -0.002, z);
  }
  k.pair(pump, k.cylZ(0.0025, 0.0025, 0.14, 8), m.steel, 0.019, 0.004, 0.155);

  // ---- Fixed skeletal stock + recoil pad ----
  const stock = [[0.058, 0.1], [0.19, 0.096], [0.2, 0.09], [0.2, -0.034], [0.188, -0.04], [0.17, -0.036], [0.08, 0.03], [0.058, 0.034]];
  const sHole = [[0.105, 0.074], [0.172, 0.074], [0.176, 0.02], [0.168, -0.006]];
  k.add(body, k.side(stock, 0.042, { holes: [sHole], bevel: 0.005 }), m.polymer);
  const pad = [[0.198, 0.094], [0.214, 0.094], [0.218, 0.084], [0.218, -0.036], [0.212, -0.044], [0.198, -0.04]];
  k.add(body, k.side(pad, 0.046, { bevel: 0.004 }), m.rubber);
  k.decalPair(body, 0.062, 0.013, 0.0216, 0.084, 0.135);
  k.stripPair(0.0012, 0.0024, 0.06, 0.0212, 0.01, 0.13, 0.633);

  k.marker(root, 'muzzle', 0, BORE_Y, -0.749);
  k.marker(root, 'sight', 0, 0.1215, 0.022);
  return k.finish(root, body, pump);
}

const crush = {
  id: 'crush', name: 'CRUSH SHOTGUN', slot: 'primary', type: 'hitscan', damage: 10, headMul: 1.25, rpm: 70, auto: false,
  mag: 6, reserve: 24, reloadTime: 0.42, shellReload: true, pellets: 10,
  spread: { base: 5.2, move: 0.6, air: 1.0, ads: 4.0, perShot: 0, max: 6.5, recover: 8 },
  recoil: { pitch: 4.2, yaw: 0.8, recover: 7, kick: 2.6 },
  falloff: { start: 8, end: 24, min: 0.3 }, range: 60,
  adsFov: 0.9, adsTime: 0.14, moveMul: 0.98, fireMoveMul: 0.9, switchTime: 0.32,
  knockback: 6.5, pickupRespawn: 15, rare: false, sound: 'crush_fire', tracer: 0.6, color: 0x7dff1a,
  buildModel,
};

export default crush;

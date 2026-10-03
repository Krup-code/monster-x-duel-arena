// CHAOS LAUNCHER - shoulder-fired tube with flared bell + venturi, hazard bands,
// reflex targeting sight and a visible rocket nose in the muzzle.
import * as THREE from 'three';
import { createKit } from './materials.js';

const TUBE_Y = 0.12;

function buildModel({ detail = 'high' } = {}) {
  const k = createKit(detail);
  const { m, hi } = k;

  const root = new THREE.Group();
  root.name = 'weapon_chaos';
  const body = k.group('body', root);
  root.add(k.energy);
  // Rocket group origin sits on the tube axis just behind the warhead.
  const rocket = k.group('rocket', root, 0, TUBE_Y, -0.56);

  // ---- Launch tube: one hollow lathe (outer wall, front bell, bore, rear venturi) ----
  const tube = [
    [0.064, 0.425], [0.072, 0.425], [0.072, 0.412], [0.062, 0.378], [0.062, -0.552], [0.071, -0.572], [0.074, -0.64],
    [0.07, -0.652], [0.058, -0.652], [0.056, -0.642], [0.054, -0.6], [0.054, 0.38], [0.06, 0.418], [0.064, 0.425],
  ];
  k.add(body, k.lathe(tube, 28), m.gunmetal, 0, TUBE_Y, 0);
  // Polymer jacket (ends hidden under steel bands), hazard bands (open sleeves over the tube).
  k.add(body, k.cylZ(0.0638, 0.0638, 0.835, 28, true), m.polymer, 0, TUBE_Y, -0.0725);
  const band = k.cylZ(0.0655, 0.0655, 0.012, 28);
  for (const z of [0.345, -0.05, -0.49]) k.add(body, band, m.steel, 0, TUBE_Y, z);
  k.add(body, k.cylZ(0.0648, 0.0648, 0.035, 28, true), m.hazard, 0, TUBE_Y, 0.3);
  k.add(body, k.cylZ(0.0648, 0.0648, 0.04, 28, true), m.hazard, 0, TUBE_Y, -0.52);
  // Back-blast warning diamond + white stencil ticks on the bell (which flares toward the front).
  k.add(body, k.box(0.012, 0.0015, 0.012), m.warn, 0, TUBE_Y + 0.0625, 0.37, 0, Math.PI / 4);
  if (hi) {
    for (const z of [-0.6, -0.61, -0.62]) {
      const r = 0.071 + ((-0.572 - z) / 0.068) * 0.003;
      k.add(body, k.box(0.02, 0.0012, 0.004), m.white, 0, TUBE_Y + r + 0.0004, z);
    }
  }
  k.decalPair(body, 0.11, 0.026, 0.0646, TUBE_Y, 0.12);

  // Energy: twin lines along the upper flanks (split around the middle band) + glowing venturi ring.
  const flank = [Math.cos(Math.PI / 6) * 0.06456, TUBE_Y + Math.sin(Math.PI / 6) * 0.06456];
  k.stripPair(0.002, 0.004, 0.225, flank[0], flank[1], 0.0775, 0, 0, Math.PI / 6);
  k.stripPair(0.002, 0.004, 0.365, flank[0], flank[1], -0.2475, 0, 0, Math.PI / 6);
  k.glow(k.torus(0.057, 0.003, 5, 36), 0, TUBE_Y, 0.405);

  // ---- Trigger housing + grip ----
  const housing = [[0.07, 0.068], [-0.13, 0.068], [-0.13, 0.052], [-0.108, 0.032], [-0.084, 0.014], [-0.078, -0.012], [-0.016, -0.012], [-0.006, 0.014], [0.046, 0.016], [0.07, 0.04]];
  const guard = [[-0.068, 0.01], [-0.068, -0.004], [-0.06, -0.006], [-0.02, -0.006], [-0.016, 0.01]];
  k.add(body, k.side(housing, 0.04, { holes: [guard], bevel: 0.002 }), m.polymer);
  k.trigger(body, -0.036, 0.012);
  k.grip(body, { z: -0.006, y: 0.018, height: 0.1, depth: 0.046, width: 0.032, rake: 0.25 });
  k.add(body, k.cylX(0.0045, 0.041, 12), m.steel, 0, 0.045, -0.1);
  if (hi) k.add(body, k.cylX(0.003, 0.001, 10), m.warn, 0.0205, 0.045, -0.1);
  k.screwPair(body, 0.02, 0.05, 0.04);

  // ---- Front vertical grip ----
  const fg = k.group(null, body, 0, 0.06, -0.29);
  fg.rotation.x = 0.1;
  const mount = [[0.025, 0.004], [-0.025, 0.004], [-0.03, -0.006], [-0.02, -0.016], [0.02, -0.016], [0.028, -0.006]];
  k.add(fg, k.side(mount, 0.034, { bevel: 0.003 }), m.polymer);
  k.add(fg, new THREE.CapsuleGeometry(0.016, 0.06, k.seg(4, 2), k.seg(14)), m.rubber, 0, -0.06, 0);
  k.add(fg, k.cylY(0.0145, 0.008, 16), m.gunmetal, 0, -0.104, 0);
  if (hi) {
    const rib = k.torus(0.0163, 0.0018, 4, 16);
    for (const y of [-0.04, -0.06, -0.08]) k.add(fg, rib, m.rubber, 0, y, 0, Math.PI / 2);
  }

  // ---- Shoulder rest ----
  const rest = [[0.18, 0.064], [0.345, 0.064], [0.352, 0.054], [0.342, 0.016], [0.3, -0.004], [0.222, 0.0], [0.18, 0.034]];
  k.add(body, k.side(rest, 0.05, { bevel: 0.005 }), m.polymer);
  const restPad = [[0.3, 0.0], [0.342, 0.018], [0.352, 0.052], [0.358, 0.05], [0.348, 0.012], [0.302, -0.008]];
  k.add(body, k.side(restPad, 0.052, { bevel: 0.003 }), m.rubber);

  // ---- Targeting reflex sight on a short rail ----
  k.add(body, k.side([[0.06, 0.176], [0.06, 0.19], [-0.09, 0.19], [-0.09, 0.176]], 0.03, { bevel: 0.002 }), m.gunmetal);
  k.rail(body, 0.055, -0.085, 0.19, 0.021);
  const oBase = [[0.04, 0.1995], [0.04, 0.206], [0.032, 0.21], [-0.074, 0.21], [-0.08, 0.204], [-0.08, 0.1995]];
  k.add(body, k.side(oBase, 0.036, { bevel: 0.0015 }), m.gunmetal);
  const rangefinder = [[0.04, 0.208], [0.04, 0.214], [0.03, 0.22], [-0.024, 0.22], [-0.024, 0.208]];
  k.add(body, k.side(rangefinder, 0.036, { bevel: 0.0015 }), m.gunmetal);
  const hoodOuter = [[-0.024, 0.208], [0.024, 0.208], [0.024, 0.244], [0.016, 0.254], [-0.016, 0.254], [-0.024, 0.244]];
  const hoodHole = [[-0.0195, 0.214], [0.0195, 0.214], [0.0195, 0.24], [0.012, 0.249], [-0.012, 0.249], [-0.0195, 0.24]];
  k.add(body, k.axial(hoodOuter, -0.028, -0.078, { holes: [hoodHole], bevel: 0.0015 }), m.gunmetal);
  k.add(body, new THREE.PlaneGeometry(0.038, 0.034), m.glass, 0, 0.2315, -0.074);
  // Chevron reticle + range ticks.
  const arm = k.box(0.0065, 0.0007, 0.0003);
  k.glow(arm, -0.0025, 0.2298, -0.0732, 0, 0, 0.7);
  k.glow(arm, 0.0025, 0.2298, -0.0732, 0, 0, -0.7);
  const tick = k.box(0.004, 0.0006, 0.0003);
  k.glow(tick, -0.009, 0.2315, -0.0732);
  k.glow(tick, 0.009, 0.2315, -0.0732);
  k.glow(k.box(0.0008, 0.0008, 0.0003), 0, 0.2265, -0.0732);
  // Status lights on the rangefinder rear face.
  const led = k.box(0.003, 0.0015, 0.0006);
  for (const x of [-0.012, -0.007, -0.002]) k.glow(led, x, 0.214, 0.0403);
  k.add(body, k.box(0.003, 0.0015, 0.0006), m.warn, 0.01, 0.214, 0.0403);
  if (hi) {
    k.add(body, k.cylZ(0.006, 0.006, 0.004, 16), m.gunmetal, 0.012, 0.204, -0.081);
    const rLens = k.circle(0.0045, 16);
    rLens.rotateY(Math.PI);
    k.add(body, rLens, m.lens, 0.012, 0.204, -0.0831);
  }

  // ---- Rocket (local space) ----
  k.add(rocket, k.cylZ(0.046, 0.046, 0.14, 20), m.steel, 0, 0, 0.06);
  const nose = [[0.046, 0.0], [0.046, -0.02], [0.044, -0.034], [0.038, -0.05], [0.029, -0.062], [0.017, -0.071], [0.006, -0.075], [0.0, -0.076]];
  k.add(rocket, k.lathe(nose, 20, { sharp: false }), m.orange);
  k.add(rocket, k.cylZ(0.0466, 0.0466, 0.008, 20), m.polymer, 0, 0, -0.004);
  k.add(rocket, k.cylZ(0.0464, 0.0464, 0.004, 20), m.white, 0, 0, 0.014);
  k.add(rocket, new THREE.SphereGeometry(0.0035, k.seg(10), k.seg(6, 4)), m.warn, 0, 0, -0.0755);

  k.marker(root, 'muzzle', 0, TUBE_Y, -0.652);
  k.marker(root, 'sight', 0, 0.2315, 0.04);
  return k.finish(root, body, rocket);
}

const chaos = {
  id: 'chaos', name: 'CHAOS LAUNCHER', slot: 'special', type: 'projectile', damage: 100, headMul: 1.0, rpm: 75, auto: false,
  mag: 3, reserve: 9, reloadTime: 2.3, pellets: 1,
  projectile: { speed: 34, radius: 0.18, splashRadius: 4.6, splashMax: 80, splashMin: 20, selfDamageMul: 0.32, knockback: 13, gravity: 0, lifetime: 6 },
  spread: { base: 0, move: 0, air: 0, ads: 0, perShot: 0, max: 0, recover: 10 },
  recoil: { pitch: 2.8, yaw: 0.5, recover: 6, kick: 2.2 },
  falloff: null, range: 200,
  adsFov: 0.85, adsTime: 0.18, moveMul: 0.95, fireMoveMul: 0.9, switchTime: 0.4,
  knockback: 0, pickupRespawn: 25, rare: true, sound: 'chaos_fire', tracer: 0, color: 0xff7a1a,
  buildModel,
};

export default chaos;

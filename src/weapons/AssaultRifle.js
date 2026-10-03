// RAZOR AR - black rifle with a blade-cut handguard, acid-green energy lines and a holo sight.
import * as THREE from 'three';
import { createKit } from './materials.js';

const BORE_Y = 0.066;

function buildModel({ detail = 'high' } = {}) {
  const k = createKit(detail);
  const { m, hi } = k;

  const root = new THREE.Group();
  root.name = 'weapon_razor';
  const body = k.group('body', root);
  root.add(k.energy);
  const mag = k.group('magazine', root, 0, 0.02, -0.111);

  // ---- Lower receiver with magwell and trigger guard ----
  const lower = [
    [0.06, 0.052], [0.06, 0.03], [0.044, 0.014], [-0.006, 0.014], [-0.006, -0.006], [-0.016, -0.014], [-0.072, -0.014],
    [-0.08, -0.022], [-0.082, -0.034], [-0.142, -0.034], [-0.146, -0.02], [-0.15, 0.004], [-0.152, 0.052],
  ];
  const guard = [[-0.068, 0.01], [-0.068, -0.004], [-0.062, -0.008], [-0.016, -0.008], [-0.012, 0.006], [-0.012, 0.01]];
  k.add(body, k.side(lower, 0.032, { holes: [guard], bevel: 0.002 }), m.polymer);
  k.trigger(body, -0.034, 0.012);
  k.grip(body, { z: -0.004, y: 0.016, height: 0.098, depth: 0.044, width: 0.03, rake: 0.32 });

  // Controls: selector (with SAFE / FIRE marks), mag release, bolt catch, takedown pins.
  k.add(body, k.box(0.0015, 0.004, 0.013), m.steel, -0.0167, 0.033, 0.022, 0.4);
  k.add(body, k.cylX(0.004, 0.002, 12), m.steel, -0.0165, 0.033, 0.022);
  if (hi) {
    k.add(body, k.box(0.0004, 0.002, 0.002), m.white, -0.0163, 0.04, 0.031);
    k.add(body, k.box(0.0004, 0.002, 0.002), m.warn, -0.0163, 0.026, 0.031);
  }
  k.add(body, k.cylX(0.004, 0.002, 12), m.steel, 0.0168, 0.022, -0.075);
  k.add(body, k.box(0.0015, 0.006, 0.014), m.gunmetal, -0.0166, 0.036, -0.074);
  k.add(body, k.cylX(0.0035, 0.0345, 10), m.steel, 0, 0.044, 0.052);
  k.add(body, k.cylX(0.0035, 0.0345, 10), m.steel, 0, 0.046, -0.14);
  k.decalPair(body, 0.05, 0.012, 0.0166, -0.02, -0.112);

  // ---- Upper receiver ----
  const upper = [[0.062, 0.05], [0.062, 0.087], [0.056, 0.093], [-0.152, 0.093], [-0.156, 0.088], [-0.156, 0.05]];
  k.add(body, k.side(upper, 0.03, { bevel: 0.0025 }), m.gunmetal);
  // Charging handle (T) and latch.
  k.add(body, k.box(0.034, 0.005, 0.01), m.steel, 0, 0.0905, 0.068);
  k.add(body, k.box(0.008, 0.004, 0.01), m.steel, -0.02, 0.0905, 0.068);
  // Forward assist + housing (right).
  k.add(body, k.box(0.01, 0.016, 0.026), m.gunmetal, 0.016, 0.074, 0.04);
  k.add(body, k.cylZ(0.0065, 0.0065, 0.024, 16), m.steel, 0.018, 0.074, 0.038);
  // Ejection port (right).
  k.add(body, k.box(0.0012, 0.013, 0.048), m.dark, 0.0152, 0.069, -0.03);
  if (hi) k.add(body, k.box(0.0012, 0.003, 0.05), m.gunmetal, 0.0154, 0.0615, -0.03);
  k.stripPair(0.0012, 0.0022, 0.13, 0.0152, 0.084, -0.075);

  // ---- Razor handguard (blade-cut front) ----
  const hg = [[-0.148, 0.093], [-0.43, 0.093], [-0.436, 0.086], [-0.436, 0.066], [-0.398, 0.036], [-0.335, 0.027], [-0.148, 0.03]];
  k.add(body, k.side(hg, 0.042, { bevel: 0.004 }), m.polymer);
  if (hi) {
    const slot = k.box(0.001, 0.0055, 0.022);
    for (const z of [-0.185, -0.22, -0.255, -0.29]) k.pair(body, slot, m.dark, 0.0212, 0.041, z);
    for (const z of [-0.2, -0.24, -0.28]) k.add(body, k.box(0.008, 0.001, 0.022), m.dark, 0, 0.0296, z);
  }
  k.screwPair(body, 0.0212, 0.084, -0.16);
  k.screwPair(body, 0.0212, 0.084, -0.424);
  // Energy lines: upper line, lower line and a slanted line following the blade edge.
  k.stripPair(0.0012, 0.0026, 0.24, 0.0212, 0.074, -0.29);
  k.stripPair(0.0012, 0.0022, 0.13, 0.0212, 0.056, -0.235);
  k.stripPair(0.0012, 0.0022, 0.036, 0.0212, 0.057, -0.412, 0.668);

  k.rail(body, 0.058, -0.428, 0.093, 0.021);

  // ---- Barrel, gas block, razor flash hider ----
  k.add(body, k.cylZ(0.0095, 0.0095, 0.115, 18), m.gunmetal, 0, BORE_Y, -0.4875);
  k.add(body, k.cylZ(0.0125, 0.0125, 0.006, 18), m.steel, 0, BORE_Y, -0.441);
  k.add(body, k.side([[-0.462, 0.072], [-0.478, 0.072], [-0.478, 0.054], [-0.462, 0.054]], 0.018, { bevel: 0.0015 }), m.gunmetal);
  k.add(body, k.cylZ(0.0115, 0.0115, 0.016, 18), m.steel, 0, BORE_Y, -0.548);
  k.add(body, k.cylZ(0.0045, 0.0045, 0.001, 12), m.dark, 0, BORE_Y, -0.5565);
  const prong = k.side([[-0.556, 0.004], [-0.556, 0.0115], [-0.588, 0.0115], [-0.602, 0.0075], [-0.596, 0.004]], 0.0055,
    { bevel: 0.0008, bevelSegments: 1 });
  for (let i = 0; i < 3; i++) k.add(body, prong, m.steel, 0, BORE_Y, 0, 0, 0, (i * Math.PI * 2) / 3);

  // ---- Stock: buffer tube + skeletal razor stock + butt pad ----
  k.add(body, k.cylZ(0.0145, 0.0145, 0.15, 18), m.gunmetal, 0, BORE_Y, 0.133);
  k.add(body, k.cylZ(0.017, 0.017, 0.006, 18), m.steel, 0, BORE_Y, 0.066);
  const stock = [
    [0.095, 0.088], [0.23, 0.098], [0.246, 0.096], [0.25, 0.07], [0.25, -0.03], [0.236, -0.036], [0.215, -0.03],
    [0.14, 0.03], [0.1, 0.042], [0.095, 0.05],
  ];
  k.add(body, k.side(stock, 0.04, { holes: [[[0.165, 0.044], [0.226, 0.082], [0.226, 0.0]]], bevel: 0.004 }), m.polymer);
  const pad = [[0.246, 0.097], [0.258, 0.096], [0.261, 0.088], [0.261, -0.03], [0.256, -0.038], [0.244, -0.036]];
  k.add(body, k.side(pad, 0.044, { bevel: 0.003 }), m.rubber);
  k.stripPair(0.0012, 0.0022, 0.1, 0.0202, 0.085, 0.165, -0.074);
  k.stripPair(0.0012, 0.0022, 0.05, 0.0202, 0.008, 0.19, 0.675);

  // ---- Holo sight ----
  const sBase = [[0.0, 0.1025], [0.0, 0.11], [-0.006, 0.114], [-0.094, 0.114], [-0.1, 0.108], [-0.1, 0.1025]];
  k.add(body, k.side(sBase, 0.03, { bevel: 0.0015 }), m.gunmetal);
  const sRear = [[-0.004, 0.112], [-0.004, 0.122], [-0.01, 0.127], [-0.04, 0.127], [-0.04, 0.112]];
  k.add(body, k.side(sRear, 0.03, { bevel: 0.0015 }), m.gunmetal);
  const hoodOuter = [[-0.019, 0.112], [0.019, 0.112], [0.019, 0.15], [0.012, 0.159], [-0.012, 0.159], [-0.019, 0.15]];
  const hoodHole = [[-0.0145, 0.118], [0.0145, 0.118], [0.0145, 0.147], [0.009, 0.1535], [-0.009, 0.1535], [-0.0145, 0.147]];
  k.add(body, k.axial(hoodOuter, -0.04, -0.092, { holes: [hoodHole], bevel: 0.0015 }), m.gunmetal);
  k.add(body, new THREE.PlaneGeometry(0.029, 0.034), m.glass, 0, 0.1355, -0.088);
  k.glow(k.torus(0.0032, 0.00045, 3, 20), 0, 0.1358, -0.0872);
  k.glow(k.box(0.0009, 0.0009, 0.0003), 0, 0.1358, -0.0872);
  if (hi) {
    k.add(body, k.box(0.006, 0.002, 0.006), m.steel, -0.008, 0.1275, -0.016);
    k.add(body, k.box(0.006, 0.002, 0.006), m.steel, -0.008, 0.1275, -0.028);
    k.add(body, k.box(0.002, 0.0015, 0.002), m.warn, 0.008, 0.1275, -0.022);
    k.add(body, k.box(0.004, 0.006, 0.014), m.steel, 0.017, 0.108, -0.06);
  }

  // ---- Curved magazine (local space, origin at the top) ----
  const magProf = [
    [0.028, 0], [0.028, -0.05], [0.022, -0.1], [0.01, -0.15], [0.0, -0.176], [-0.002, -0.182], [-0.064, -0.168],
    [-0.062, -0.158], [-0.051, -0.122], [-0.04, -0.084], [-0.032, -0.04], [-0.03, 0],
  ];
  k.add(mag, k.side(magProf, 0.022, { bevel: 0.0025 }), m.polymer);
  k.add(mag, k.side([[0.003, -0.172], [-0.001, -0.188], [-0.068, -0.174], [-0.066, -0.162]], 0.026, { bevel: 0.0015 }), m.gunmetal);
  if (hi) {
    k.pair(mag, k.box(0.0006, 0.0025, 0.012), m.white, 0.0112, -0.09, -0.014);
    k.add(mag, k.box(0.02, 0.004, 0.04), m.gunmetal, 0, -0.002, -0.002);
    k.add(mag, k.cylZ(0.0045, 0.0045, 0.03, 12), m.brass, 0, 0.004, 0.001);
    k.add(mag, k.cylZ(0.0012, 0.0045, 0.012, 12), m.steel, 0, 0.004, -0.02);
  }

  k.marker(root, 'muzzle', 0, BORE_Y, -0.602);
  k.marker(root, 'sight', 0, 0.1358, -0.04);
  return k.finish(root, body, mag);
}

const razor = {
  id: 'razor', name: 'RAZOR AR', slot: 'primary', type: 'hitscan', damage: 22, headMul: 1.5, rpm: 650, auto: true,
  mag: 30, reserve: 120, reloadTime: 1.9, pellets: 1,
  spread: { base: 0.55, move: 1.5, air: 3.0, ads: 0.18, perShot: 0.32, max: 4.0, recover: 9 },
  recoil: { pitch: 0.55, yaw: 0.28, recover: 10, kick: 1.0 },
  falloff: { start: 30, end: 60, min: 0.7 }, range: 200,
  adsFov: 0.78, adsTime: 0.15, moveMul: 1.0, fireMoveMul: 0.92, switchTime: 0.3,
  knockback: 0, pickupRespawn: 15, rare: false, sound: 'razor_fire', tracer: 0.5, color: 0x7dff1a,
  buildModel,
};

export default razor;

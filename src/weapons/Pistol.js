// STING P9 - polymer-frame sidearm with a stinger compensator and a green laser module.
import * as THREE from 'three';
import { createKit } from './materials.js';

const BORE_Y = 0.061;

function buildModel({ detail = 'high' } = {}) {
  const k = createKit(detail);
  const { m, hi } = k;

  const root = new THREE.Group();
  root.name = 'weapon_pistol';
  const body = k.group('body', root);
  const slide = k.group('slide', root);
  root.add(k.energy);
  // Magazine axis follows the grip rake; origin = top of the magazine.
  const mag = k.group('magazine', root, 0, 0.018, -0.003);
  mag.rotation.x = -0.267;

  // ---- Frame: dust cover, trigger guard (hole) and raked grip in one polymer profile ----
  const frame = [
    [0.036, 0.044], [-0.165, 0.044], [-0.165, 0.027], [-0.077, 0.027], [-0.077, 0.002], [-0.066, -0.007],
    [-0.018, -0.006],
    [-0.0105, -0.022], [-0.0128, -0.036], [-0.004, -0.05], [-0.0052, -0.064], [0.0036, -0.078], [0.006, -0.092],
    [0.006, -0.101], [0.052, -0.089], [0.054, -0.082], [0.049, -0.05], [0.04, -0.01], [0.031, 0.012],
    [0.04, 0.022], [0.054, 0.03], [0.052, 0.036], [0.04, 0.04],
  ];
  const guardHole = [[-0.069, 0.023], [-0.069, 0.007], [-0.061, 0.0], [-0.025, 0.0], [-0.022, 0.023]];
  k.add(body, k.side(frame, 0.026, { holes: [guardHole], bevel: 0.002 }), m.polymer);

  // Stippled rubber grip panels.
  const panel = [[-0.01, -0.01], [0.033, -0.01], [0.045, -0.08], [0.01, -0.088]];
  k.pair(body, k.side(panel, 0.002, { bevel: 0.0006, bevelSegments: 1 }), m.rubber, 0.0138, 0, 0);

  k.trigger(body, -0.04, 0.024);

  // Slide stop + takedown lever.
  k.add(body, k.box(0.0016, 0.004, 0.024), m.gunmetal, -0.0137, 0.0405, -0.05);
  k.pair(body, k.box(0.0016, 0.003, 0.008), m.steel, 0.0136, 0.034, -0.075);
  k.screwPair(body, 0.0135, 0.033, 0.006, { r: 0.0018 });

  // Accessory rail ribs under the dust cover.
  if (hi) for (const z of [-0.088, -0.1, -0.112]) k.add(body, k.box(0.02, 0.003, 0.0045), m.polymer, 0, 0.0255, z);

  // Laser / light module with a glowing green emitter.
  const laser = [[-0.124, 0.027], [-0.163, 0.027], [-0.166, 0.022], [-0.166, 0.013], [-0.16, 0.01], [-0.13, 0.01], [-0.124, 0.016]];
  k.add(body, k.side(laser, 0.022, { bevel: 0.002 }), m.polymer);
  k.add(body, k.cylZ(0.0058, 0.0058, 0.003, 16), m.gunmetal, 0, 0.0185, -0.1655);
  k.glow(k.cylZ(0.0042, 0.0042, 0.0012, 16), 0, 0.0185, -0.1675);
  if (hi) k.add(body, k.box(0.0008, 0.002, 0.003), m.warn, 0.0112, 0.022, -0.135);

  // Energy lines along the frame under the slide + a small sting mark.
  k.stripPair(0.0012, 0.0022, 0.115, 0.0131, 0.037, -0.095);
  k.stripPair(0.0012, 0.0018, 0.016, 0.0132, 0.031, 0.008, -0.55);

  // ---- Slide (moves +Z on fire) ----
  const slideProf = [
    [0.04, 0.047], [0.04, 0.074], [0.035, 0.078], [-0.148, 0.078], [-0.166, 0.071], [-0.168, 0.05], [-0.163, 0.044], [0.037, 0.044],
  ];
  k.add(slide, k.side(slideProf, 0.0255, { bevel: 0.002 }), m.gunmetal);

  // Stinger compensator (brushed steel) with ports.
  const comp = [[-0.163, 0.046], [-0.163, 0.077], [-0.184, 0.077], [-0.197, 0.068], [-0.197, 0.05], [-0.204, 0.04], [-0.186, 0.042], [-0.17, 0.044]];
  k.add(slide, k.side(comp, 0.026, { bevel: 0.002 }), m.steel);
  k.add(slide, k.cylZ(0.0045, 0.0045, 0.002, 16), m.dark, 0, BORE_Y, -0.1975);
  if (hi) {
    for (const z of [-0.171, -0.178]) k.add(slide, k.box(0.012, 0.0012, 0.0035), m.dark, 0, 0.0772, z);
    k.pair(slide, k.box(0.0012, 0.008, 0.006), m.dark, 0.0131, 0.062, -0.186);
  }

  // Ejection port (right) with the barrel hood showing.
  k.add(slide, k.box(0.0012, 0.012, 0.034), m.dark, 0.0128, 0.068, -0.022);
  k.add(slide, k.box(0.0012, 0.0042, 0.03), m.steel, 0.0131, 0.0716, -0.022);

  // Top lightening cut.
  if (hi) k.add(slide, k.box(0.009, 0.0012, 0.046), m.dark, 0, 0.0782, -0.098);

  // Cocking serrations (rear + front).
  if (hi) {
    const fin = k.box(0.0012, 0.024, 0.0022);
    for (let i = 0; i < 7; i++) k.pair(slide, fin, m.gunmetal, 0.0129, 0.061, 0.032 - i * 0.0045);
    for (let i = 0; i < 4; i++) k.pair(slide, fin, m.gunmetal, 0.0129, 0.061, -0.128 - i * 0.0045);
  }

  // Iron sights: two-post rear, tall front post, white dots.
  k.add(slide, k.box(0.022, 0.004, 0.009), m.gunmetal, 0, 0.08, 0.031);
  k.pair(slide, k.box(0.0075, 0.0055, 0.009), m.gunmetal, 0.00725, 0.0845, 0.031);
  k.add(slide, k.box(0.0035, 0.0125, 0.006), m.gunmetal, 0, 0.0808, -0.152);
  if (hi) {
    k.pair(slide, k.box(0.0022, 0.0022, 0.0006), m.white, 0.007, 0.0848, 0.0358);
    k.add(slide, k.box(0.002, 0.002, 0.0006), m.white, 0, 0.0845, -0.1487);
  }

  // Striker indicator (rear face) and sponsor decal.
  k.add(slide, k.box(0.003, 0.003, 0.0008), m.warn, 0, 0.064, 0.0404);
  k.decalPair(slide, 0.058, 0.013, 0.01275 + 0.0006, 0.06, -0.085);

  // ---- Magazine (local space, origin at the top) ----
  k.add(mag, k.box(0.019, 0.117, 0.029), m.steel, 0, -0.0585, 0);
  const base = [[0.02, -0.116], [-0.02, -0.116], [-0.023, -0.121], [-0.02, -0.126], [0.021, -0.126], [0.023, -0.121]];
  k.add(mag, k.side(base, 0.025, { bevel: 0.002 }), m.polymer);
  k.add(mag, k.box(0.017, 0.004, 0.026), m.polymer, 0, -0.001, 0);
  if (hi) {
    k.pair(mag, k.box(0.0006, 0.002, 0.016), m.white, 0.0126, -0.121, 0);
    const hole = k.box(0.0008, 0.003, 0.003);
    for (const y of [-0.04, -0.06, -0.08]) k.pair(mag, hole, m.dark, 0.0096, y, 0.008);
    k.add(mag, k.cylZ(0.0045, 0.0045, 0.018, 12), m.brass, 0, 0.0035, 0.002);
    k.add(mag, k.cylZ(0.0014, 0.0045, 0.007, 12), m.steel, 0, 0.0035, -0.0105);
  }

  k.marker(root, 'muzzle', 0, BORE_Y, -0.198);
  k.marker(root, 'sight', 0, 0.0865, 0.036);
  return k.finish(root, body, slide, mag);
}

const pistol = {
  id: 'pistol', name: 'STING P9', slot: 'secondary', type: 'hitscan', damage: 19, headMul: 2.0, rpm: 400, auto: false,
  mag: 12, reserve: Infinity, reloadTime: 1.25, pellets: 1,
  spread: { base: 0.45, move: 1.2, air: 2.4, ads: 0.15, perShot: 0.6, max: 3.0, recover: 10 },
  recoil: { pitch: 0.9, yaw: 0.25, recover: 12, kick: 0.9 },
  falloff: { start: 22, end: 45, min: 0.6 }, range: 150,
  adsFov: 0.85, adsTime: 0.12, moveMul: 1.05, fireMoveMul: 1.0, switchTime: 0.22,
  knockback: 0, pickupRespawn: 15, rare: false, sound: 'pistol_fire', tracer: 0.35, color: 0x7dff1a,
  buildModel,
};

export default pistol;

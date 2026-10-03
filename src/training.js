// TRAINING GROUNDS: firing range with stationary + moving targets and a strafing dummy,
// weapon racks with every weapon, and a movement course (jump pads, mantles, slide
// tunnel, wall kicks, ramps). Hits show damage numbers; the HUD tracks accuracy and DPS.
import * as THREE from 'three';
import { ArenaBuilder } from './arenaBuilder.js';
import { PALETTE } from './config.js';
import { Arena, MAPS, addJumpPadPublic, signPlanePublic } from './arena.js';
import { neon } from './textures.js';

function targetMesh(lib, color = PALETTE.acid) {
  const g = new THREE.Group();
  const mat = new THREE.MeshStandardMaterial({ color: 0x1a1d1e, roughness: 0.5, metalness: 0.6, emissive: new THREE.Color(color), emissiveIntensity: 0.15 });
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 1.36, 0.12), mat);
  body.position.y = 0.72 + 0.05;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), mat);
  head.position.y = 1.58;
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.22, 0.02, 6, 24), neon(color, 2.5));
  ring.position.set(0, 1.58, 0.07);
  const bull = new THREE.Mesh(new THREE.RingGeometry(0.1, 0.16, 24), neon(color, 2));
  bull.position.set(0, 1.05, 0.065);
  const stand = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.06, 0.3, 8), lib.M.trim);
  stand.position.y = 0.05;
  g.add(body, head, ring, bull, stand);
  g.userData.mat = mat;
  return g;
}

export async function buildTraining(lib, opts = {}) {
  const detail = opts.geometry || 'high';
  const B = new ArenaBuilder(lib, detail);
  const W = B.world;
  const M = lib.M;
  const arena = new Arena(MAPS.training);
  arena.group = B.group;
  arena.world = W;
  arena.fog = new THREE.FogExp2(0x030604, 0.008);
  arena.isTraining = true;
  const progress = opts.onProgress || (() => {});

  const X0 = -30, X1 = 34, Z0 = -44, Z1 = 20, CEIL = 12;
  // shell
  B.box(X0 - 1, -0.6, Z0 - 1, X1 + 1, CEIL + 1, Z0, 'wall');
  B.box(X0 - 1, -0.6, Z1, X1 + 1, CEIL + 1, Z1 + 1, 'wall');
  B.box(X0 - 1, -0.6, Z0, X0, CEIL + 1, Z1, 'wall');
  B.box(X1, -0.6, Z0, X1 + 1, CEIL + 1, Z1, 'wall');
  B.box(X0, CEIL, Z0, X1, CEIL + 0.5, Z1, 'darkMetal');
  B.floor(X0, Z0, 12, Z1, -0.6, 0, 'concrete');
  B.floor(12, Z0, X1, Z1, -0.6, 0, 'plate');
  // range lane markings
  for (const d of [10, 20, 35, 45]) {
    const z = 8 - d;
    B.visualBox(-11, 0, z - 0.06, 11, 0.012, z + 0.06, 'neonGreenSoft');
  }
  B.visualBox(-11, 0, 7.9, 11, 0.02, 8.1, 'hazard');
  // shooting booth dividers
  for (const x of [-11, -5.5, 0, 5.5, 11]) B.box(x - 0.1, 0, 8, x + 0.1, 1.2, 12, 'darkMetal');
  B.box(-11, 0, 7.6, 11, 1.0, 8.0, 'concrete');
  // side walls of the range
  B.box(-11.6, 0, Z0, -11.2, 4, 7.6, 'wall');
  B.box(11.2, 0, Z0, 11.6, 4, 7.6, 'wall');
  // backstop berm
  B.box(-11.2, 0, Z0, 11.2, 5, Z0 + 1.5, 'gravel');
  // distance signs
  const distTex = {};
  for (const d of [10, 20, 35, 45]) {
    const c = document.createElement('canvas');
    c.width = 256; c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#050605'; g.fillRect(0, 0, 256, 128);
    g.fillStyle = '#7dff1a'; g.font = '700 84px Teko, Rajdhani, Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillText(d + 'M', 128, 68);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    distTex[d] = t;
    B.mesh(signPlanePublic(t, 1.6, 0.8, { pos: [-11.15, 3.2, 8 - d], rotY: Math.PI / 2, glow: 1.4 }));
    B.mesh(signPlanePublic(t, 1.6, 0.8, { pos: [11.15, 3.2, 8 - d], rotY: -Math.PI / 2, glow: 1.4 }));
  }
  progress(0.3);

  // ---------------- targets ----------------
  const addTarget = (kind, x, z, extra = {}) => {
    const mesh = targetMesh(lib, kind === 'moving' ? PALETTE.p2 : PALETTE.acid);
    mesh.position.set(x, 0, z);
    B.mesh(mesh);
    const t = {
      id: arena.targets.length, kind, pos: new THREE.Vector3(x, 0, z), height: 1.8, maxHealth: extra.health ?? Infinity,
      health: extra.health ?? Infinity, alive: true, respawnAt: 0, mesh, flash: 0, base: new THREE.Vector3(x, 0, z), ...extra,
    };
    arena.targets.push(t);
    return t;
  };
  for (const [d, xs] of [[10, [-8.2, -2.7, 2.7, 8.2]], [20, [-6, 0, 6]], [35, [-4, 4]], [45, [0]]]) {
    for (const x of xs) addTarget('static', x, 8 - d);
  }
  addTarget('moving', 0, -7, { range: 8, speed: 3.2 });
  addTarget('moving', 0, -22, { range: 9, speed: 6.0, phase: 1.3 });
  addTarget('moving', 0, -32, { range: 8, speed: 4.5, phase: 2.2, vertical: true });
  // Strafing dummy pen: it dodges like a player, takes real damage and respawns.
  addTarget('dummy', 0, -14, { health: 150, range: 7, speed: 6.5 });
  arena.animated.push((dt, t) => {
    for (const tg of arena.targets) {
      if (tg.kind === 'moving') {
        tg.pos.x = tg.base.x + Math.sin(t * (tg.speed / tg.range) + (tg.phase || 0)) * tg.range;
        if (tg.vertical) tg.pos.y = Math.max(0, Math.sin(t * 1.7 + (tg.phase || 0))) * 1.6;
      } else if (tg.kind === 'dummy' && tg.alive) {
        tg.strafeTimer = (tg.strafeTimer ?? 0) - dt;
        if (tg.strafeTimer <= 0) {
          tg.strafeTimer = 0.25 + Math.random() * 0.7;
          tg.dir = Math.random() < 0.5 ? -1 : 1;
          if (Math.abs(tg.pos.x - tg.base.x) > tg.range * 0.8) tg.dir = -Math.sign(tg.pos.x - tg.base.x);
          tg.crouch = Math.random() < 0.15;
        }
        tg.pos.x += tg.dir * tg.speed * dt;
        tg.pos.x = Math.max(tg.base.x - tg.range, Math.min(tg.base.x + tg.range, tg.pos.x));
        tg.height = tg.crouch ? 1.15 : 1.8;
      }
      tg.mesh.position.copy(tg.pos);
      tg.mesh.scale.y = tg.height / 1.8;
      tg.flash = Math.max(0, tg.flash - dt * 5);
      tg.mesh.userData.mat.emissiveIntensity = 0.15 + tg.flash * 2.5;
      tg.mesh.visible = tg.alive;
    }
  });
  progress(0.45);

  // ---------------- weapon racks ----------------
  const P = (kind, pos, extra = {}) => arena.addPickup({ kind, pos: new THREE.Vector3(...pos), training: true, ...extra }, lib, detail);
  const rack = ['razor', 'volt', 'crush', 'venom', 'pistol', 'chaos', 'rail'];
  rack.forEach((w, i) => P('weapon', [-9 + i * 3, 0, 16], { weapon: w, respawnOverride: 1 }));
  B.box(-11, 0, 17.4, 11, 2.4, 17.8, 'wall');
  B.visualBox(-11, 2.2, 17.35, 11, 2.3, 17.4, 'neonGreen');
  P('health', [-14, 0, 12], { respawnOverride: 3 });
  P('armor', [-17, 0, 12], { respawnOverride: 3 });
  P('energy', [-20, 0, 12], { respawnOverride: 2 });
  P('mega', [-23, 0, 12], { respawnOverride: 6 });

  // ---------------- movement course (x 14..34) ----------------
  // mantle blocks of increasing height
  [0.6, 1.0, 1.3].forEach((h, i) => B.box(15 + i * 3.2, 0, 14, 17 + i * 3.2, h, 16, 'darkMetal'));
  // slide tunnel
  B.box(15, 1.1, 4, 26, 1.5, 7, 'darkMetal');
  B.box(15, 0, 3.6, 26, 1.5, 4, 'darkMetal');
  B.box(15, 0, 7, 26, 1.5, 7.4, 'darkMetal');
  B.visualBox(15, 1.08, 4.1, 26, 1.1, 6.9, 'neonGreenSoft');
  // wall-kick shaft
  B.box(28, 0, -4, 28.6, 9, 4, 'wall');
  B.box(32.4, 0, -4, 33, 9, 4, 'wall');
  B.box(28.6, 6.5, 2.2, 32.4, 6.8, 4, 'plate');
  // ramp + platform + stairs
  B.ramp([15, 0, -14], [23, 4.5, -10], 'x', 1, 'concrete');
  B.box(23, 0, -14, 27, 4.5, -10, 'concrete');
  B.stairs('z', -18, -24, 23, 27, 0, 4.5, 'plate', { mirror: false });
  B.box(23, 0, -30, 27, 4.5, -24, 'concrete');
  // gap jumps
  B.box(16, 0, -30, 20, 2.5, -26, 'darkMetal');
  B.box(16, 0, -38, 20, 2.5, -34, 'darkMetal');
  // jump pads
  addJumpPadPublic(arena, B, [18, 0, -20], [0, 13, -0.01], PALETTE.acid);
  addJumpPadPublic(arena, B, [25, 0, -6], [0, 15, -4], PALETTE.acid);
  progress(0.7);

  // ---------------- lights ----------------
  const hemi = new THREE.HemisphereLight(0x8e9894, 0x1a1c1c, 1.25);
  B.mesh(hemi);
  const sun = new THREE.DirectionalLight(0xdfe8ff, 1.6);
  sun.position.set(10, 30, 6);
  B.mesh(sun); B.mesh(sun.target);
  arena.sun = sun;
  for (const [x, z, c] of [[0, 4, 0xf2f5f0], [0, -18, PALETTE.acid], [0, -36, 0xf2f5f0], [22, 6, 0xf2f5f0], [22, -20, PALETTE.acid], [-18, 10, PALETTE.p2]]) {
    const l = new THREE.PointLight(c, 40, 28, 1.5);
    l.position.set(x, 8, z);
    B.mesh(l);
    arena.lights.push(l);
  }
  for (let z = Z0 + 4; z < Z1; z += 8) B.visualBox(-0.4, CEIL - 0.1, z, 0.4, CEIL, z + 3, 'neonWhite');
  B.mesh(signPlanePublic(lib.signs.logo, 10, 3.75, { pos: [0, 8.5, 19.9], rotY: Math.PI, glow: 2 }));
  B.mesh(signPlanePublic(lib.signs.holoAd2, 9, 4.5, { pos: [0, 8.2, Z0 + 0.05], rotY: 0, glow: 1.4 }));

  // stats board (updated by the game)
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 512;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const board = new THREE.Mesh(new THREE.PlaneGeometry(8, 4), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.6, 1.6, 1.6) }));
  board.position.set(-20, 4.5, 19.9);
  board.rotation.y = Math.PI;
  B.mesh(board);
  arena.statsBoard = { canvas: c, ctx: c.getContext('2d'), tex };

  arena.spawns = [{ pos: new THREE.Vector3(0, 0, 11), yaw: 0 }, { pos: new THREE.Vector3(-16, 0, 6), yaw: 0 }];
  arena.initialSpawns = [arena.spawns[0], arena.spawns[1]];
  arena.flyover = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 6, 18), new THREE.Vector3(0, 4, 4), new THREE.Vector3(0, 3, -10)]);
  arena.flyoverLook = new THREE.Vector3(0, 1.5, -20);
  arena.menuPath = arena.flyover;
  arena.bounds = { min: new THREE.Vector3(X0, -1, Z0), max: new THREE.Vector3(X1, CEIL, Z1) };
  arena.killY = -10;
  B.finalize(true);
  progress(1);
  return arena;
}

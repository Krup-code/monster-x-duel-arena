// Shared weapon materials + a small procedural-geometry kit used by every weapon model.
//
// Conventions for all weapon models (meters): barrel points along -Z, +Y up, +X right,
// origin at the pistol grip / trigger hand. Each model is a THREE.Group with named parts
// ('muzzle', 'sight', 'energy', and per-weapon 'slide' / 'magazine' / 'pump' / 'rocket' / 'coil').
//
// Static parts are merged per material after construction (see bakeGroup) so a full
// first-person weapon costs a handful of draw calls instead of ~100.

import * as THREE from 'three';
import { PALETTE } from '../config.js';

const HAS_DOM = typeof document !== 'undefined' && typeof document.createElement === 'function';

/** Default emissive intensity of acid-green energy parts (bloom threshold friendly). */
export const ENERGY_INTENSITY = 2.6;

// ---------------------------------------------------------------------------
// Procedural textures (browser only; created lazily, shared by all weapons)
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

function toTexture(canvas, { repeat = [1, 1], srgb = false, wrap = THREE.RepeatWrapping } = {}) {
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = wrap;
  tex.repeat.set(repeat[0], repeat[1]);
  tex.anisotropy = 4;
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// Fine polymer grain: mostly-white roughness multiplier with darker speckles (tileable noise).
function drawGrain() {
  const S = 256;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const rnd = mulberry32(0x5eed);
  for (let i = 0; i < S * S; i++) {
    const n = rnd();
    let v = 255 - n * n * 64;
    if (rnd() < 0.015) v -= 40;
    const o = i * 4;
    img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
    img.data[o + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Brushed / lathe-turned streaks (rows) for steel roughness.
function drawBrushed() {
  const S = 256;
  const c = makeCanvas(S, S);
  const ctx = c.getContext('2d');
  const img = ctx.createImageData(S, S);
  const rnd = mulberry32(0xb125);
  for (let y = 0; y < S; y++) {
    const row = 222 + (rnd() - 0.5) * 50;
    for (let x = 0; x < S; x++) {
      const v = Math.max(0, Math.min(255, row + (rnd() - 0.5) * 18));
      const o = (y * S + x) * 4;
      img.data[o] = img.data[o + 1] = img.data[o + 2] = v;
      img.data[o + 3] = 255;
    }
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// "MONSTER-X" sponsor panel with an angular X emblem.
function drawDecal() {
  const W = 512;
  const H = 128;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const acid = '#7dff1a';
  const white = '#f2f5f0';
  const cut = 18;
  g.clearRect(0, 0, W, H);
  g.beginPath();
  g.moveTo(cut, 0);
  g.lineTo(W - cut, 0);
  g.lineTo(W, cut);
  g.lineTo(W, H - cut);
  g.lineTo(W - cut, H);
  g.lineTo(cut, H);
  g.lineTo(0, H - cut);
  g.lineTo(0, cut);
  g.closePath();
  g.fillStyle = '#0c0f0d';
  g.fill();
  g.lineWidth = 5;
  g.strokeStyle = acid;
  g.stroke();

  // Angular X emblem: two slanted bars.
  const bar = (x0, y0, x1, y1, w, color) => {
    g.beginPath();
    g.moveTo(x0 - w, y0);
    g.lineTo(x0 + w, y0);
    g.lineTo(x1 + w, y1);
    g.lineTo(x1 - w, y1);
    g.closePath();
    g.fillStyle = color;
    g.fill();
  };
  const ex = 22;
  const ey = 20;
  const es = 88;
  bar(ex + 16, ey, ex + es - 16, ey + es, 14, acid);
  bar(ex + es - 16, ey, ex + 16, ey + es, 9, white);

  // Wordmark, auto-fit to the panel.
  const tx = 128;
  const avail = W - tx - 26;
  let size = 64;
  const font = (s) => `italic 900 ${s}px "Arial Black", Impact, "Helvetica Neue", Arial, sans-serif`;
  g.font = font(size);
  while (size > 20 && g.measureText('MONSTER-X').width > avail) {
    size -= 2;
    g.font = font(size);
  }
  g.textBaseline = 'middle';
  const ty = H * 0.46;
  g.fillStyle = white;
  g.fillText('MONSTER-', tx, ty);
  const w = g.measureText('MONSTER-').width;
  g.fillStyle = acid;
  g.fillText('X', tx + w, ty);
  g.fillRect(tx, H - 28, avail, 5);
  return c;
}

// Orange / black diagonal hazard stripes (tiles horizontally).
function drawHazard() {
  const W = 256;
  const H = 64;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  g.fillStyle = '#121414';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#ff7a1a';
  for (let x = -H; x < W + H; x += 32) {
    g.beginPath();
    g.moveTo(x, H);
    g.lineTo(x + 16, H);
    g.lineTo(x + 16 + H, 0);
    g.lineTo(x + H, 0);
    g.closePath();
    g.fill();
  }
  return c;
}

let textures = null;
function getTextures() {
  if (textures) return textures;
  textures = { grain: null, brushed: null, decal: null, hazard: null };
  if (!HAS_DOM) return textures;
  try {
    textures.grain = toTexture(drawGrain(), { repeat: [4, 4] });
    textures.brushed = toTexture(drawBrushed(), { repeat: [2, 2] });
    textures.decal = toTexture(drawDecal(), { srgb: true, wrap: THREE.ClampToEdgeWrapping });
    textures.hazard = toTexture(drawHazard(), { repeat: [2, 1], srgb: true });
  } catch {
    // No 2D canvas available: materials fall back to flat colors.
  }
  return textures;
}

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------

let MATERIALS = null;

/**
 * Shared (cached) weapon materials. Never mutate these per weapon instance;
 * per-instance emissive parts use makeEnergyMaterial().
 */
export function getWeaponMaterials() {
  if (MATERIALS) return MATERIALS;
  const t = getTextures();
  const std = (name, params) => new THREE.MeshStandardMaterial({ name: `weapon_${name}`, ...params });
  MATERIALS = {
    polymer: std('polymer', { color: 0x141716, roughness: 0.55, metalness: 0.1, roughnessMap: t.grain }),
    gunmetal: std('gunmetal', { color: PALETTE.gunmetal, roughness: 0.35, metalness: 0.85, roughnessMap: t.grain }),
    steel: std('steel', { color: 0x8a9296, roughness: 0.28, metalness: 1.0, roughnessMap: t.brushed }),
    rubber: std('rubber', { color: 0x111111, roughness: 0.9, metalness: 0.0, roughnessMap: t.grain, bumpMap: t.grain, bumpScale: 0.6 }),
    lens: std('lens', { color: 0x0a1a10, roughness: 0.05, metalness: 0.5, emissive: PALETTE.acid, emissiveIntensity: 0.12 }),
    glass: std('glass', {
      color: 0x9dff6a, roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.14,
      depthWrite: false, side: THREE.DoubleSide,
    }),
    white: std('white', { color: PALETTE.white, roughness: 0.5, metalness: 0.0 }),
    warn: std('warn', { color: 0xff4a1a, roughness: 0.4, metalness: 0.0, emissive: 0xff4a1a, emissiveIntensity: 1.6 }),
    orange: std('orange', { color: PALETTE.warnOrange, roughness: 0.45, metalness: 0.1 }),
    dark: std('dark', { color: 0x050605, roughness: 0.8, metalness: 0.2 }),
    brass: std('brass', { color: 0xc79a4a, roughness: 0.3, metalness: 1.0 }),
    shell: std('shell', { color: 0x3f8f16, roughness: 0.5, metalness: 0.05 }),
    decal: std('decal', {
      color: t.decal ? 0xffffff : 0x1a1d1c, map: t.decal, roughness: 0.45, metalness: 0.15,
      alphaTest: t.decal ? 0.5 : 0, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    }),
    hazard: std('hazard', { color: t.hazard ? 0xffffff : PALETTE.warnOrange, map: t.hazard, roughness: 0.6, metalness: 0.05 }),
  };
  return MATERIALS;
}

/** A NEW emissive acid-green material (one per model instance so pulsing stays local). */
export function makeEnergyMaterial(intensity = 2.5, color = PALETTE.acid) {
  return new THREE.MeshStandardMaterial({
    name: 'weapon_energy',
    color,
    emissive: color,
    emissiveIntensity: intensity,
    roughness: 0.35,
    metalness: 0.0,
    toneMapped: true,
  });
}

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

const v2 = ([a, b]) => new THREE.Vector2(a, b);

/** THREE.Shape from [[x, y], ...] (implicitly closed). */
export function shapeFrom(points) {
  return new THREE.Shape(points.map(v2));
}

function pathFrom(points) {
  return new THREE.Path(points.map(v2));
}

function buildShape(profile, holes) {
  const shape = profile instanceof THREE.Shape ? profile : shapeFrom(profile);
  for (const h of holes) shape.holes.push(h instanceof THREE.Path ? h : pathFrom(h));
  return shape;
}

/**
 * Side-profile extrusion: profile points are [z, y] in weapon space, extruded across X
 * and centered (x in [-width/2, width/2]). The bevel eats into the faces (bevelOffset = -bevel)
 * so the silhouette matches the profile exactly while edges read as machined chamfers.
 */
export function sideExtrude(profile, width, { holes = [], bevel = 0.0025, bevelSegments = 2, curveSegments = 6 } = {}) {
  const shape = buildShape(profile, holes);
  const b = Math.min(bevel, width * 0.3);
  const depth = Math.max(width - 2 * b, 1e-4);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    curveSegments,
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments,
  });
  geo.rotateY(-Math.PI / 2); // shape x -> +z, extrusion -> -x
  geo.translate(depth / 2, 0, 0);
  return geo;
}

/** Cross-section ([x, y]) extruded along Z between zRear (> zFront) and zFront. */
export function axialExtrude(section, zRear, zFront, { holes = [], bevel = 0.002, bevelSegments = 2, curveSegments = 6 } = {}) {
  const shape = buildShape(section, holes);
  const len = zRear - zFront;
  const b = Math.min(bevel, len * 0.3);
  const depth = Math.max(len - 2 * b, 1e-4);
  const geo = new THREE.ExtrudeGeometry(shape, {
    depth,
    steps: 1,
    curveSegments,
    bevelEnabled: b > 0,
    bevelThickness: b,
    bevelSize: b,
    bevelOffset: -b,
    bevelSegments,
  });
  geo.translate(0, 0, zFront + b);
  return geo;
}

/**
 * Surface of revolution around the Z axis. profile = [[radius, z], ...] ordered rear -> front
 * (z decreasing) for outward normals. sharp=true duplicates interior points so each profile
 * segment is flat-shaded along its length (crisp machined steps) while staying smooth around.
 */
export function latheZ(profile, segments = 24, { sharp = true, phiStart = 0, phiLength = Math.PI * 2 } = {}) {
  const pts = [];
  profile.forEach(([r, z], i) => {
    const p = new THREE.Vector2(r, -z);
    pts.push(p);
    if (sharp && i > 0 && i < profile.length - 1) pts.push(p.clone());
  });
  const geo = new THREE.LatheGeometry(pts, segments, phiStart, phiLength);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Cylinder along Z: rFront at -Z end, rRear at +Z end, centered on the origin. */
export function cylZ(rFront, rRear, length, segments = 16, openEnded = false) {
  const geo = new THREE.CylinderGeometry(rFront, rRear, length, segments, 1, openEnded);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

/** Cylinder along X, centered. */
export function cylX(r, length, segments = 12) {
  const geo = new THREE.CylinderGeometry(r, r, length, segments);
  geo.rotateZ(Math.PI / 2);
  return geo;
}

/** Cylinder along Y, centered. */
export function cylY(r, length, segments = 12) {
  return new THREE.CylinderGeometry(r, r, length, segments);
}

/** Mesh factory: adds to parent with position/rotation and shadow flags. */
export function addMesh(parent, geometry, material, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  mesh.rotation.set(rx, ry, rz);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  parent.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------------------
// Static merging
// ---------------------------------------------------------------------------

const _ta = new THREE.Vector3();
const _tb = new THREE.Vector3();
const _tc = new THREE.Vector3();

// True for zero-area triangles (lathe corner duplicates, cone apexes, collapsed bevels).
function isDegenerate(p, i) {
  _ta.fromBufferAttribute(p, i);
  _tb.fromBufferAttribute(p, i + 1).sub(_ta);
  _tc.fromBufferAttribute(p, i + 2).sub(_ta);
  return _tb.cross(_tc).lengthSq() < 1e-20;
}

// Concatenates non-indexed geometries (position/normal/uv), dropping degenerate triangles.
function concatGeometries(geos) {
  const keep = [];
  let count = 0;
  for (const g of geos) {
    if (!g.attributes.normal) g.computeVertexNormals();
    const p = g.attributes.position;
    const tris = [];
    for (let i = 0; i + 2 < p.count; i += 3) if (!isDegenerate(p, i)) tris.push(i);
    keep.push(tris);
    count += tris.length * 3;
  }
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const uv = new Float32Array(count * 2);
  let o = 0;
  geos.forEach((g, gi) => {
    const p = g.attributes.position;
    const n = g.attributes.normal;
    const t = g.attributes.uv;
    for (const start of keep[gi]) {
      for (let i = start; i < start + 3; i++, o++) {
        pos[o * 3] = p.getX(i);
        pos[o * 3 + 1] = p.getY(i);
        pos[o * 3 + 2] = p.getZ(i);
        nor[o * 3] = n.getX(i);
        nor[o * 3 + 1] = n.getY(i);
        nor[o * 3 + 2] = n.getZ(i);
        if (t) {
          uv[o * 2] = t.getX(i);
          uv[o * 2 + 1] = t.getY(i);
        }
      }
    }
    g.dispose();
  });
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  out.computeBoundingBox();
  out.computeBoundingSphere();
  return out;
}

/**
 * Merge every mesh under `group` into one mesh per material, baked into the group's local space.
 * Named descendants (and everything below them) are left untouched so they stay addressable.
 */
export function bakeGroup(group) {
  group.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(group.matrixWorld).invert();
  const meshes = [];
  const collect = (obj) => {
    for (const child of obj.children) {
      if (child.name) continue;
      if (child.isMesh && !Array.isArray(child.material)) meshes.push(child);
      else if (!child.isMesh) collect(child);
    }
  };
  collect(group);
  if (meshes.length === 0) return group;

  const buckets = new Map();
  const local = new THREE.Matrix4();
  for (const mesh of meshes) {
    local.multiplyMatrices(inv, mesh.matrixWorld);
    const g = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    g.applyMatrix4(local);
    let list = buckets.get(mesh.material);
    if (!list) buckets.set(mesh.material, (list = []));
    list.push(g);
  }
  const sources = new Set();
  for (const mesh of meshes) {
    sources.add(mesh.geometry);
    mesh.parent.remove(mesh);
  }
  for (const g of sources) g.dispose();

  // Drop now-empty unnamed helper groups.
  const prune = (obj) => {
    for (const child of [...obj.children]) {
      if (child.name || child.isMesh) continue;
      prune(child);
      if (child.children.length === 0 && child.type === 'Group') obj.remove(child);
    }
  };
  prune(group);

  for (const [material, geos] of buckets) {
    const mesh = new THREE.Mesh(concatGeometries(geos), material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    group.add(mesh);
  }
  return group;
}

// ---------------------------------------------------------------------------
// Kit: detail-aware builders shared by the weapon files
// ---------------------------------------------------------------------------

/**
 * Creates a per-model builder kit. Each kit owns a fresh energy material and an 'energy' group,
 * so every built model pulses independently.
 */
export function createKit(detail = 'high') {
  const hi = detail !== 'low';
  const m = getWeaponMaterials();
  const energyMat = makeEnergyMaterial(ENERGY_INTENSITY);
  const energy = new THREE.Group();
  energy.name = 'energy';
  energy.userData.baseIntensity = ENERGY_INTENSITY;
  const bevelSegments = hi ? 2 : 1;
  const curveSegments = hi ? 6 : 2;

  const k = {
    hi,
    detail,
    m,
    energy,
    energyMat,

    /** Segment count scaled for detail level. */
    seg: (n, min = 6) => (hi ? n : Math.max(min, Math.round(n * 0.5))),

    group(name, parent, x = 0, y = 0, z = 0) {
      const g = new THREE.Group();
      if (name) g.name = name;
      g.position.set(x, y, z);
      if (parent) parent.add(g);
      return g;
    },

    add: addMesh,

    /** Adds the same part mirrored at +x and -x. */
    pair(parent, geo, mat, x, y, z, rx = 0, ry = 0, rz = 0) {
      return [addMesh(parent, geo, mat, x, y, z, rx, ry, rz), addMesh(parent, geo, mat, -x, y, z, rx, -ry, -rz)];
    },

    box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
    side: (profile, width, opts = {}) => sideExtrude(profile, width, { bevelSegments, curveSegments, ...opts }),
    axial: (section, zRear, zFront, opts = {}) => axialExtrude(section, zRear, zFront, { bevelSegments, curveSegments, ...opts }),
    lathe: (profile, segs = 24, opts = {}) => latheZ(profile, k.seg(segs), opts),
    cylZ: (rFront, rRear, len, segs = 16, open = false) => cylZ(rFront, rRear, len, k.seg(segs), open),
    cylX: (r, len, segs = 12) => cylX(r, len, k.seg(segs)),
    cylY: (r, len, segs = 12) => cylY(r, len, k.seg(segs)),
    torus: (r, tube, radial = 6, tubular = 24, arc = Math.PI * 2) =>
      new THREE.TorusGeometry(r, tube, k.seg(radial, 3), k.seg(tubular, 8), arc),
    circle: (r, segs = 24) => new THREE.CircleGeometry(r, k.seg(segs)),

    /** Flat single-sided inlay in the YZ plane ([z, y] profile, optional holes) facing +X (side=1) or -X. */
    facePlate(profile, side = 1, { holes = [] } = {}) {
      const flip = (pts) => pts.map(([z, y]) => [side > 0 ? -z : z, y]);
      const geo = new THREE.ShapeGeometry(buildShape(flip(profile), holes.map(flip)), curveSegments);
      geo.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
      return geo;
    },

    /** Emissive part under the energy group (or a nested group inside it). */
    glow(geo, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, parent = energy, mat = energyMat) {
      return addMesh(parent, geo, mat, x, y, z, rx, ry, rz);
    },
    strip(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
      return k.glow(new THREE.BoxGeometry(w, h, d), x, y, z, rx, ry, rz);
    },
    stripPair(w, h, d, x, y, z, rx = 0, ry = 0, rz = 0) {
      return k.pair(energy, new THREE.BoxGeometry(w, h, d), energyMat, x, y, z, rx, ry, rz);
    },

    /** Hex screw head (high detail only). */
    screw(parent, x, y, z, { axis = 'x', r = 0.0022, len = 0.0016 } = {}) {
      if (!hi) return null;
      const geo = axis === 'x' ? cylX(r, len, 6) : axis === 'y' ? cylY(r, len, 6) : cylZ(r, r, len, 6);
      return addMesh(parent, geo, m.steel, x, y, z);
    },
    screwPair(parent, x, y, z, opts) {
      k.screw(parent, x, y, z, opts);
      k.screw(parent, -x, y, z, opts);
    },

    /** MONSTER-X decal plane facing +X (side=1) or -X (side=-1); text reads toward the muzzle on the right side. */
    decal(parent, w, h, x, y, z, side = 1, tilt = 0) {
      const geo = new THREE.PlaneGeometry(w, h);
      geo.rotateY(side > 0 ? Math.PI / 2 : -Math.PI / 2);
      const mesh = addMesh(parent, geo, m.decal, x, y, z, tilt * side);
      mesh.castShadow = false;
      return mesh;
    },
    decalPair(parent, w, h, x, y, z, tilt = 0) {
      k.decal(parent, w, h, x, y, z, 1, tilt);
      k.decal(parent, w, h, -x, y, z, -1, tilt);
    },

    /** Picatinny rail between zRear and zFront sitting on yBase (teeth top = yBase + 0.0095). */
    rail(parent, zRear, zFront, yBase, width = 0.021) {
      const hw = width / 2;
      const base = [
        [-hw, yBase], [hw, yBase], [hw, yBase + 0.003], [hw - 0.0022, yBase + 0.0052],
        [-hw + 0.0022, yBase + 0.0052], [-hw, yBase + 0.003],
      ];
      addMesh(parent, k.axial(base, zRear, zFront, { bevel: 0.0008, bevelSegments: 1 }), m.gunmetal);
      const yTop = yBase + 0.0095;
      const ySlot = yBase + 0.0065;
      const y0 = yBase + 0.0045;
      const tw = width - 0.0045;
      if (!hi) {
        addMesh(parent, new THREE.BoxGeometry(tw, yTop - y0, zRear - zFront), m.gunmetal, 0, (yTop + y0) / 2, (zRear + zFront) / 2);
        return;
      }
      const pts = [[zRear, y0], [zRear, yTop]];
      const pitch = 0.01;
      const tooth = 0.0048;
      let z = zRear;
      while (z - pitch > zFront + 0.002) {
        pts.push([z - tooth, yTop], [z - tooth, ySlot], [z - pitch, ySlot], [z - pitch, yTop]);
        z -= pitch;
      }
      pts.push([zFront, yTop], [zFront, y0]);
      addMesh(parent, sideExtrude(pts, tw, { bevel: 0 }), m.gunmetal);
    },

    /** Raked pistol grip with finger grooves and a palm swell; top front corner at (z, y). */
    grip(parent, { z = -0.006, y = 0.016, height = 0.1, depth = 0.046, width = 0.03, rake = 0.3, mat = m.rubber } = {}) {
      const dz = rake * height;
      const F0 = [z, y];
      const F1 = [z + dz, y - height];
      const B0 = [z + depth, y];
      const B1 = [z + depth + dz + 0.002, y - height];
      const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      const pts = [[z + depth + 0.004, y], F0];
      [0.16, 0.33, 0.5, 0.67, 0.84].forEach((t, i) => {
        const p = lerp(F0, F1, t);
        pts.push([p[0] + (i % 2 === 0 ? 0.0035 : -0.0005), p[1]]);
      });
      pts.push([F1[0] - 0.002, F1[1] + 0.005], [F1[0] - 0.001, F1[1]], B1, [B1[0] + 0.002, B1[1] + 0.006]);
      const mid = lerp(B1, B0, 0.45);
      pts.push([mid[0] + 0.004, mid[1]], [B0[0] + 0.006, B0[1] - 0.012]);
      addMesh(parent, k.side(pts, width, { bevel: Math.min(0.006, width * 0.22) }), mat);
      addMesh(parent, new THREE.BoxGeometry(width + 0.002, 0.005, depth + 0.004), m.gunmetal,
        0, y - height - 0.0005, (F1[0] + B1[0]) / 2);
    },

    /** Curved trigger blade hanging from (z, yTop). */
    trigger(parent, z, yTop, mat = m.steel) {
      const prof = [
        [z - 0.004, yTop], [z + 0.003, yTop], [z + 0.002, yTop - 0.007], [z + 0.005, yTop - 0.015],
        [z + 0.009, yTop - 0.02], [z + 0.006, yTop - 0.022], [z, yTop - 0.016], [z - 0.004, yTop - 0.006],
      ];
      return addMesh(parent, k.side(prof, 0.0065, { bevel: 0.0012, bevelSegments: 1 }), mat);
    },

    marker(parent, name, x, y, z) {
      const o = new THREE.Object3D();
      o.name = name;
      o.position.set(x, y, z);
      parent.add(o);
      return o;
    },

    /** Bakes static/moving groups, attaches the energy group and tags the root. */
    finish(root, ...groups) {
      if (!energy.parent) root.add(energy);
      for (const g of groups) if (g) bakeGroup(g);
      bakeGroup(energy);
      root.userData.energyMaterial = energyMat;
      root.userData.detail = hi ? 'high' : 'low';
      return root;
    },
  };
  return k;
}

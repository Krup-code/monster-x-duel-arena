// Geometry helpers for building arenas: every solid box becomes a collider plus world-space
// UV geometry, batched per (material, zone) into a handful of merged meshes so the whole
// level renders in roughly a hundred draw calls while still frustum-culling by zone.
import * as THREE from 'three';
import { CollisionWorld } from './physics.js';

// Texture repeat size in meters per material key.
const UV_SIZE = {
  concrete: 4, concreteDark: 4, plate: 2, grate: 1.6, wall: 4, wallGreen: 4, hazard: 2,
  container: 3, containerGreen: 3, containerOrange: 3, containerWhite: 3, trim: 2, darkMetal: 2,
  gravel: 2.5, rubber: 2, pipe: 2, pipeGreen: 2, pipeWhite: 2, machine: 3, black: 2,
};

class Bucket {
  constructor(material) {
    this.material = material;
    this.pos = [];
    this.nrm = [];
    this.uv = [];
    this.idx = [];
  }
  get count() { return this.pos.length / 3; }
}

const FACE_DEFS = [
  // normal, u axis, v axis, corner selector
  { n: [1, 0, 0], u: 2, v: 1, flipU: true },
  { n: [-1, 0, 0], u: 2, v: 1, flipU: false },
  { n: [0, 1, 0], u: 0, v: 2, flipU: false },
  { n: [0, -1, 0], u: 0, v: 2, flipU: true },
  { n: [0, 0, 1], u: 0, v: 1, flipU: false },
  { n: [0, 0, -1], u: 0, v: 1, flipU: true },
];
for (const fd of FACE_DEFS) {
  const eu = [0, 0, 0], ev = [0, 0, 0];
  eu[fd.u] = 1; ev[fd.v] = 1;
  const cr = [eu[1] * ev[2] - eu[2] * ev[1], eu[2] * ev[0] - eu[0] * ev[2], eu[0] * ev[1] - eu[1] * ev[0]];
  fd.cross = cr[0] * fd.n[0] + cr[1] * fd.n[1] + cr[2] * fd.n[2];
}

export class ArenaBuilder {
  constructor(lib, detail = 'high') {
    this.lib = lib;
    this.M = lib.M;
    this.detail = detail;
    this.world = new CollisionWorld(4);
    this.group = new THREE.Group();
    this.group.name = 'arena';
    this.buckets = new Map();
    this.zoneSize = 20;
    this.segs = detail === 'low' ? 10 : detail === 'medium' ? 16 : 24;
  }

  _bucket(matKey, x, y, z) {
    const zx = Math.floor(x / this.zoneSize), zz = Math.floor(z / this.zoneSize), zy = y < -0.5 ? 0 : 1;
    const key = `${matKey}|${zx},${zy},${zz}`;
    let b = this.buckets.get(key);
    if (!b) {
      const mat = typeof matKey === 'string' ? this.M[matKey] : matKey;
      b = new Bucket(mat);
      b.matKey = matKey;
      this.buckets.set(key, b);
    }
    return b;
  }

  /** Visual box with world-space UVs (no collider). faces: optional set of face indices to skip. */
  visualBox(x0, y0, z0, x1, y1, z1, matKey, opts = {}) {
    const min = [Math.min(x0, x1), Math.min(y0, y1), Math.min(z0, z1)];
    const max = [Math.max(x0, x1), Math.max(y0, y1), Math.max(z0, z1)];
    const b = this._bucket(matKey, (min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2);
    const s = 1 / (opts.uvSize || UV_SIZE[matKey] || 3);
    const skip = opts.skip || 0;
    for (let f = 0; f < 6; f++) {
      if (skip & (1 << f)) continue;
      const fd = FACE_DEFS[f];
      const axis = fd.n[0] ? 0 : fd.n[1] ? 1 : 2;
      const side = fd.n[axis] > 0 ? max[axis] : min[axis];
      const base = b.count;
      const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
      for (const [cu, cv] of corners) {
        const p = [0, 0, 0];
        p[axis] = side;
        p[fd.u] = cu ? max[fd.u] : min[fd.u];
        p[fd.v] = cv ? max[fd.v] : min[fd.v];
        b.pos.push(p[0], p[1], p[2]);
        b.nrm.push(fd.n[0], fd.n[1], fd.n[2]);
        let u = p[fd.u] * s, v = p[fd.v] * s;
        if (fd.flipU) u = -u;
        if (opts.rotateUV) { const t = u; u = v; v = t; }
        b.uv.push(u + (opts.uvOffset || 0), v);
      }
      // Winding: (u x v) must point along the face normal.
      if (fd.cross > 0) b.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      else b.idx.push(base, base + 2, base + 1, base, base + 3, base + 2);
    }
  }

  /** Solid box: collider + visual. */
  box(x0, y0, z0, x1, y1, z1, matKey, opts = {}) {
    let c = null;
    if (!opts.noCollide) {
      c = this.world.addBox([x0, y0, z0], [x1, y1, z1], {
        surface: opts.surface || surfaceFor(matKey),
        blocksBullets: opts.blocksBullets ?? true,
        blocksMove: opts.blocksMove ?? true,
      });
    }
    if (!opts.invisible) this.visualBox(x0, y0, z0, x1, y1, z1, matKey, opts);
    return c;
  }

  /** Box mirrored across x = 0 (x -> -x). Symmetric boxes are only added once. */
  mbox(x0, y0, z0, x1, y1, z1, matKey, opts = {}) {
    this.box(x0, y0, z0, x1, y1, z1, matKey, opts);
    if (Math.abs(x0 + x1) > 1e-6) this.box(-x1, y0, z0, -x0, y1, z1, matKey, opts);
  }

  /** Add arbitrary geometry (already in world space) to a merged bucket. */
  geo(geometry, matKey, uvScale = 1) {
    geometry.computeBoundingBox();
    const c = geometry.boundingBox.getCenter(new THREE.Vector3());
    const b = this._bucket(matKey, c.x, c.y, c.z);
    const g = geometry.index ? geometry : geometry; // keep indexed
    const p = g.attributes.position, n = g.attributes.normal, uv = g.attributes.uv;
    const base = b.count;
    for (let i = 0; i < p.count; i++) {
      b.pos.push(p.getX(i), p.getY(i), p.getZ(i));
      b.nrm.push(n.getX(i), n.getY(i), n.getZ(i));
      if (uv) b.uv.push(uv.getX(i) * uvScale, uv.getY(i) * uvScale);
      else b.uv.push(0, 0);
    }
    if (g.index) for (let i = 0; i < g.index.count; i++) b.idx.push(base + g.index.getX(i));
    else for (let i = 0; i < p.count; i++) b.idx.push(base + i);
    geometry.dispose();
  }

  mgeo(makeGeo, matKey, uvScale = 1) {
    const g = makeGeo(1);
    this.geo(g, matKey, uvScale);
    this.geo(makeGeo(-1), matKey, uvScale);
  }

  cylinder(x, z, r, y0, y1, matKey, opts = {}) {
    const segs = opts.segs || this.segs;
    const g = new THREE.CylinderGeometry(opts.rTop ?? r, r, y1 - y0, segs, 1, opts.open ?? false);
    g.translate(x, (y0 + y1) / 2, z);
    if (opts.uvScale) scaleUV(g, opts.uvScale);
    this.geo(g, matKey);
    if (!opts.noCollide) {
      return this.world.addCylinder(x, z, r, y0, y1, { surface: opts.surface || surfaceFor(matKey), blocksBullets: opts.blocksBullets ?? true });
    }
    return null;
  }

  /** Horizontal pipe along an axis. Decorative unless collide. */
  pipe(axis, a0, a1, c1, c2, r, matKey, opts = {}) {
    const len = Math.abs(a1 - a0);
    const g = new THREE.CylinderGeometry(r, r, len, opts.segs || Math.max(8, this.segs / 2), 1, true);
    const mid = (a0 + a1) / 2;
    if (axis === 'x') { g.rotateZ(Math.PI / 2); g.translate(mid, c1, c2); }
    else if (axis === 'z') { g.rotateX(Math.PI / 2); g.translate(c1, c2, mid); }
    else { g.translate(c1, mid, c2); }
    scaleUV(g, [len / 2, 1]);
    this.geo(g, matKey);
    // flanges
    if (opts.flanges && this.detail !== 'low') {
      const n = Math.max(2, Math.floor(len / opts.flanges));
      for (let i = 0; i <= n; i++) {
        const t = a0 + (a1 - a0) * (i / n);
        const f = new THREE.CylinderGeometry(r * 1.25, r * 1.25, 0.12, Math.max(8, this.segs / 2));
        if (axis === 'x') { f.rotateZ(Math.PI / 2); f.translate(t, c1, c2); }
        else if (axis === 'z') { f.rotateX(Math.PI / 2); f.translate(c1, c2, t); }
        else f.translate(c1, t, c2);
        this.geo(f, 'trim');
      }
    }
    if (opts.collide) {
      if (axis === 'x') this.world.addBox([Math.min(a0, a1), c1 - r, c2 - r], [Math.max(a0, a1), c1 + r, c2 + r], { surface: 'metal' });
      else if (axis === 'z') this.world.addBox([c1 - r, c2 - r, Math.min(a0, a1)], [c1 + r, c2 + r, Math.max(a0, a1)], { surface: 'metal' });
    }
  }

  ramp(min, max, axis, dir, matKey, opts = {}) {
    const c = this.world.addRamp(min, max, axis, dir, { surface: opts.surface || surfaceFor(matKey) });
    // Visual wedge: slope top + two side triangles + back face
    const g = wedgeGeometry(min, max, axis, dir, UV_SIZE[matKey] || 3);
    this.geo(g, matKey);
    return c;
  }

  /** Straight stairs: steps from (a0 at y0) to (a1 at y1) along axis, across c0..c1. */
  stairs(axis, a0, a1, c0, c1, y0, y1, matKey, opts = {}) {
    const rise = y1 - y0;
    const steps = opts.steps || Math.max(2, Math.ceil(rise / 0.3));
    const dh = rise / steps;
    const run = (a1 - a0) / steps;
    const base = opts.base ?? y0;
    for (let i = 0; i < steps; i++) {
      const sa = a0 + run * i, sb = a0 + run * (i + 1);
      const top = y0 + dh * (i + 1);
      const fn = opts.mirror ? this.mbox.bind(this) : this.box.bind(this);
      if (axis === 'x') fn(Math.min(sa, sb), base, c0, Math.max(sa, sb), top, c1, matKey, { surface: 'metal' });
      else fn(c0, base, Math.min(sa, sb), c1, top, Math.max(sa, sb), matKey, { surface: 'metal' });
    }
  }

  /** Railing between two points at height y (posts + rails). Blocks movement, not bullets. */
  railing(x0, z0, x1, z1, y, opts = {}) {
    const h = opts.height ?? 1.05;
    const len = Math.hypot(x1 - x0, z1 - z0);
    const posts = Math.max(1, Math.round(len / 1.6));
    const mat = opts.mat || 'trim';
    const t = 0.05;
    for (let i = 0; i <= posts; i++) {
      const k = i / posts;
      const px = x0 + (x1 - x0) * k, pz = z0 + (z1 - z0) * k;
      this.visualBox(px - t, y, pz - t, px + t, y + h, pz + t, mat);
    }
    const minx = Math.min(x0, x1), maxx = Math.max(x0, x1), minz = Math.min(z0, z1), maxz = Math.max(z0, z1);
    const ex = maxx - minx < 0.01 ? t : 0, ez = maxz - minz < 0.01 ? t : 0;
    this.visualBox(minx - ex, y + h - 0.06, minz - ez, maxx + ex, y + h, maxz + ez, mat);
    this.visualBox(minx - ex * 0.6, y + h * 0.5 - 0.03, minz - ez * 0.6, maxx + ex * 0.6, y + h * 0.5 + 0.03, maxz + ez * 0.6, mat);
    if (opts.glow !== false && this.detail !== 'low') {
      this.visualBox(minx - ex * 1.1, y + h - 0.075, minz - ez * 1.1, maxx + ex * 1.1, y + h - 0.055, maxz + ez * 1.1, opts.glowMat || 'neonGreenSoft');
    }
    this.world.addBox([minx - Math.max(ex, 0.06), y, minz - Math.max(ez, 0.06)], [maxx + Math.max(ex, 0.06), y + h, maxz + Math.max(ez, 0.06)], { surface: 'metal', blocksBullets: false });
  }

  mrailing(x0, z0, x1, z1, y, opts) {
    this.railing(x0, z0, x1, z1, y, opts);
    if (Math.abs(x0 + x1) > 1e-6 || Math.abs(x0 - x1) > 1e-6) this.railing(-x0, z0, -x1, z1, y, opts);
  }

  /**
   * Wall along an axis with rectangular openings.
   * axis 'x': wall runs along x at z in [c0,c1]; 'z': runs along z at x in [c0,c1].
   * openings: [{ a0, a1, y0, y1, glass? }]
   */
  wall(axis, a0, a1, c0, c1, y0, y1, matKey, openings = [], opts = {}) {
    const ops = openings.slice().sort((p, q) => p.a0 - q.a0);
    const seg = (s0, s1, sy0, sy1) => {
      if (s1 - s0 < 1e-3 || sy1 - sy0 < 1e-3) return;
      if (axis === 'x') this.box(s0, sy0, c0, s1, sy1, c1, matKey, opts);
      else this.box(c0, sy0, s0, c1, sy1, s1, matKey, opts);
    };
    let cur = a0;
    for (const o of ops) {
      seg(cur, o.a0, y0, y1);
      seg(o.a0, o.a1, y0, o.y0); // below opening (sill)
      seg(o.a0, o.a1, o.y1, y1); // above opening (lintel)
      // Trim frame around the opening
      if (this.detail !== 'low') {
        const ft = 0.06;
        const fr = (s0, s1, sy0, sy1) => {
          if (axis === 'x') this.visualBox(s0, sy0, c0 - ft, s1, sy1, c1 + ft, 'darkMetal');
          else this.visualBox(c0 - ft, sy0, s0, c1 + ft, sy1, s1, 'darkMetal');
        };
        fr(o.a0 - 0.12, o.a0, o.y0, o.y1);
        fr(o.a1, o.a1 + 0.12, o.y0, o.y1);
        if (o.y1 < y1) fr(o.a0 - 0.12, o.a1 + 0.12, o.y1, o.y1 + 0.12);
        if (o.y0 > y0 + 0.01) fr(o.a0 - 0.12, o.a1 + 0.12, o.y0 - 0.1, o.y0);
      }
      cur = o.a1;
    }
    seg(cur, a1, y0, y1);
  }

  mwall(axis, a0, a1, c0, c1, y0, y1, matKey, openings = [], opts = {}) {
    if (axis === 'x') {
      this.wall('x', a0, a1, c0, c1, y0, y1, matKey, openings, opts);
      if (Math.abs(a0 + a1) > 1e-6) {
        this.wall('x', -a1, -a0, c0, c1, y0, y1, matKey, openings.map((o) => ({ ...o, a0: -o.a1, a1: -o.a0 })), opts);
      }
    } else {
      this.wall('z', a0, a1, c0, c1, y0, y1, matKey, openings, opts);
      if (Math.abs(c0 + c1) > 1e-6) this.wall('z', a0, a1, -c1, -c0, y0, y1, matKey, openings, opts);
    }
  }

  /** Floor rectangle with rectangular holes, split into boxes. */
  floor(x0, z0, x1, z1, y0, y1, matKey, holes = [], opts = {}) {
    const xs = new Set([x0, x1]);
    for (const h of holes) { xs.add(Math.max(x0, Math.min(x1, h[0]))); xs.add(Math.max(x0, Math.min(x1, h[2]))); }
    const xa = [...xs].sort((a, b) => a - b);
    for (let i = 0; i < xa.length - 1; i++) {
      const sx0 = xa[i], sx1 = xa[i + 1];
      if (sx1 - sx0 < 1e-4) continue;
      const cx = (sx0 + sx1) / 2;
      // z intervals blocked by holes covering this x strip
      const blocked = holes.filter((h) => h[0] < cx && h[2] > cx).map((h) => [Math.max(z0, h[1]), Math.min(z1, h[3])]).sort((a, b) => a[0] - b[0]);
      let cz = z0;
      for (const [b0, b1] of blocked) {
        if (b0 > cz) this.box(sx0, y0, cz, sx1, y1, b0, matKey, opts);
        cz = Math.max(cz, b1);
      }
      if (z1 > cz) this.box(sx0, y0, cz, sx1, y1, z1, matKey, opts);
    }
  }

  /** Add a standalone mesh (not merged). */
  mesh(m) {
    this.group.add(m);
    return m;
  }

  finalize(shadows = true) {
    for (const b of this.buckets.values()) {
      if (!b.idx.length) continue;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(b.pos, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(b.nrm, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(b.uv, 2));
      g.setIndex(b.idx);
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const m = new THREE.Mesh(g, b.material);
      const emissive = b.material.isMeshBasicMaterial;
      m.castShadow = shadows && !emissive && !b.material.transparent;
      m.receiveShadow = shadows && !emissive;
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      this.group.add(m);
    }
    this.buckets.clear();
  }
}

function surfaceFor(matKey) {
  if (typeof matKey !== 'string') return 'metal';
  if (matKey.startsWith('grate')) return 'grate';
  if (matKey.startsWith('gravel')) return 'gravel';
  if (matKey.startsWith('concrete')) return 'concrete';
  if (matKey === 'glass') return 'glass';
  if (matKey === 'rubber') return 'concrete';
  return 'metal';
}

export function scaleUV(g, s) {
  const uv = g.attributes.uv;
  if (!uv) return;
  const sx = Array.isArray(s) ? s[0] : s, sy = Array.isArray(s) ? s[1] : s;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * sx, uv.getY(i) * sy);
}

function wedgeGeometry(min, max, axis, dir, uvSize) {
  const [x0, y0, z0] = min, [x1, y1, z1] = max;
  const pos = [], uv = [];
  const s = 1 / uvSize;
  const P = (a, h, c) => (axis === 'x' ? [a, h, c] : [c, h, a]);
  const lo = axis === 'x' ? x0 : z0, hi = axis === 'x' ? x1 : z1;
  const c0 = axis === 'x' ? z0 : x0, c1 = axis === 'x' ? z1 : x1;
  const aLow = dir > 0 ? lo : hi, aHigh = dir > 0 ? hi : lo;
  const quad = (a, b, c, d, uvs) => {
    pos.push(...a, ...b, ...c, ...a, ...c, ...d);
    uv.push(...uvs[0], ...uvs[1], ...uvs[2], ...uvs[0], ...uvs[2], ...uvs[3]);
  };
  const slopeLen = Math.hypot(hi - lo, y1 - y0);
  // Slope surface
  quad(P(aLow, y0, c0), P(aLow, y0, c1), P(aHigh, y1, c1), P(aHigh, y1, c0),
    [[0, c0 * s], [0, c1 * s], [slopeLen * s, c1 * s], [slopeLen * s, c0 * s]]);
  // Back (vertical high end)
  quad(P(aHigh, y0, c0), P(aHigh, y1, c0), P(aHigh, y1, c1), P(aHigh, y0, c1),
    [[c0 * s, y0 * s], [c0 * s, y1 * s], [c1 * s, y1 * s], [c1 * s, y0 * s]]);
  // Side triangles
  for (const c of [c0, c1]) {
    pos.push(...P(aLow, y0, c), ...P(aHigh, y0, c), ...P(aHigh, y1, c));
    uv.push(aLow * s, y0 * s, aHigh * s, y0 * s, aHigh * s, y1 * s);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.computeVertexNormals();
  // Ensure normals face outward: flip triangles whose normal points into the wedge center.
  const center = new THREE.Vector3((x0 + x1) / 2, y0 + (y1 - y0) * 0.33, (z0 + z1) / 2);
  const p = g.attributes.position, n = g.attributes.normal;
  const tri = new THREE.Vector3(), nv = new THREE.Vector3();
  for (let i = 0; i < p.count; i += 3) {
    tri.set((p.getX(i) + p.getX(i + 1) + p.getX(i + 2)) / 3, (p.getY(i) + p.getY(i + 1) + p.getY(i + 2)) / 3, (p.getZ(i) + p.getZ(i + 1) + p.getZ(i + 2)) / 3);
    nv.set(n.getX(i), n.getY(i), n.getZ(i));
    if (nv.dot(tri.sub(center)) < 0) {
      // swap vertices 1 and 2
      for (const attr of [p, g.attributes.uv]) {
        const sz = attr.itemSize;
        for (let k = 0; k < sz; k++) {
          const a = attr.array[(i + 1) * sz + k];
          attr.array[(i + 1) * sz + k] = attr.array[(i + 2) * sz + k];
          attr.array[(i + 2) * sz + k] = a;
        }
      }
    }
  }
  g.computeVertexNormals();
  return g;
}

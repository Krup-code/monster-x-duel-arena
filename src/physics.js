// Static collision world: axis-aligned boxes, vertical cylinders and ramps (solid wedges),
// bucketed into a uniform XZ grid. Used for player movement, raycasts (hitscan, rockets,
// line of sight), ragdolls and the bot navigation graph. Everything here is deterministic
// so host and client agree on world hits.
import * as THREE from 'three';

const EPS = 1e-4;
let rayStamp = 1;
let queryStamp = 1;

export class CollisionWorld {
  constructor(cellSize = 4) {
    this.cellSize = cellSize;
    this.colliders = [];
    this.cells = new Map();
    this.jumpPads = [];
    this.triggers = [];
    this.bounds = { min: new THREE.Vector3(-1e3, -1e3, -1e3), max: new THREE.Vector3(1e3, 1e3, 1e3) };
    this._tmp = [];
  }

  _add(c) {
    c.id = this.colliders.length;
    c.enabled = c.enabled ?? true;
    c.surface = c.surface || 'concrete';
    c.blocksBullets = c.blocksBullets ?? true;
    c.blocksMove = c.blocksMove ?? true;
    c._q = 0;
    c._r = 0;
    this.colliders.push(c);
    this._insert(c);
    return c;
  }

  _cellRange(c) {
    const s = this.cellSize;
    let minX, maxX, minZ, maxZ;
    if (c.type === 'cyl') {
      minX = c.x - c.r; maxX = c.x + c.r; minZ = c.z - c.r; maxZ = c.z + c.r;
    } else {
      minX = c.min.x; maxX = c.max.x; minZ = c.min.z; maxZ = c.max.z;
    }
    return [Math.floor(minX / s), Math.floor(maxX / s), Math.floor(minZ / s), Math.floor(maxZ / s)];
  }

  _insert(c) {
    const [x0, x1, z0, z1] = this._cellRange(c);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const k = x * 73856093 ^ z * 19349663;
        let cell = this.cells.get(k);
        if (!cell) { cell = []; this.cells.set(k, cell); }
        cell.push(c);
      }
    }
  }

  _cell(x, z) {
    return this.cells.get(x * 73856093 ^ z * 19349663);
  }

  addBox(min, max, opts = {}) {
    const c = {
      type: 'box',
      min: new THREE.Vector3(Math.min(min[0], max[0]), Math.min(min[1], max[1]), Math.min(min[2], max[2])),
      max: new THREE.Vector3(Math.max(min[0], max[0]), Math.max(min[1], max[1]), Math.max(min[2], max[2])),
      ...opts,
    };
    return this._add(c);
  }

  addCylinder(x, z, r, y0, y1, opts = {}) {
    return this._add({ type: 'cyl', x, z, r, y0, y1, ...opts });
  }

  // Ramp: solid wedge spanning min..max; surface rises along `axis` ('x'|'z') in direction `dir` (+1|-1).
  addRamp(min, max, axis, dir, opts = {}) {
    const c = {
      type: 'ramp',
      min: new THREE.Vector3(...min),
      max: new THREE.Vector3(...max),
      axis, dir, ...opts,
    };
    const len = c.max[axis] - c.min[axis];
    const rise = c.max.y - c.min.y;
    // Slope plane: n . p = d (normal points up/out of the slope)
    const slope = rise / len;
    const n = new THREE.Vector3(0, 1, 0);
    n[axis] = -slope * dir;
    n.normalize();
    // A point on the plane: the high edge
    const p = new THREE.Vector3(c.min.x, c.max.y, c.min.z);
    p[axis] = dir > 0 ? c.max[axis] : c.min[axis];
    c.planeN = n;
    c.planeD = n.dot(p);
    return this._add(c);
  }

  addJumpPad(min, max, velocity, opts = {}) {
    const pad = { min: new THREE.Vector3(...min), max: new THREE.Vector3(...max), velocity: new THREE.Vector3(...velocity), ...opts };
    this.jumpPads.push(pad);
    return pad;
  }

  rampHeight(c, x, z) {
    const a = c.axis === 'x' ? x : z;
    const lo = c.min[c.axis], hi = c.max[c.axis];
    let t = (a - lo) / (hi - lo);
    t = Math.min(1, Math.max(0, t));
    if (c.dir < 0) t = 1 - t;
    return c.min.y + (c.max.y - c.min.y) * t;
  }

  // Collect enabled colliders overlapping an AABB (x/z from grid, y tested by caller or here).
  query(minX, minY, minZ, maxX, maxY, maxZ, out = this._tmp, movers = true) {
    out.length = 0;
    const s = this.cellSize;
    const stamp = ++queryStamp;
    const x0 = Math.floor(minX / s), x1 = Math.floor(maxX / s);
    const z0 = Math.floor(minZ / s), z1 = Math.floor(maxZ / s);
    for (let x = x0; x <= x1; x++) {
      for (let z = z0; z <= z1; z++) {
        const cell = this._cell(x, z);
        if (!cell) continue;
        for (let i = 0; i < cell.length; i++) {
          const c = cell[i];
          if (c._q === stamp || !c.enabled) continue;
          c._q = stamp;
          if (movers && !c.blocksMove) continue;
          if (c.type === 'cyl') {
            if (maxY <= c.y0 || minY >= c.y1) continue;
            const cx = Math.max(minX, Math.min(c.x, maxX)) - c.x;
            const cz = Math.max(minZ, Math.min(c.z, maxZ)) - c.z;
            if (cx * cx + cz * cz >= c.r * c.r) continue;
          } else {
            if (maxX <= c.min.x || minX >= c.max.x || maxZ <= c.min.z || minZ >= c.max.z) continue;
            if (maxY <= c.min.y || minY >= c.max.y) continue;
          }
          out.push(c);
        }
      }
    }
    return out;
  }

  // Is a character AABB (feet center pos) free of solid geometry?
  isFree(x, y, z, half, height) {
    const list = this.query(x - half, y + EPS, z - half, x + half, y + height, z + half, []);
    for (const c of list) {
      if (c.type === 'ramp') {
        if (y < this.rampHeight(c, x, z) - 0.05 && y + height > c.min.y) return false;
        continue;
      }
      return false;
    }
    return true;
  }

  // Highest walkable surface under (x,z) at or below `y + up`, scanning down at most `down`.
  groundHeight(x, y, z, half = 0.3, up = 0.5, down = 50) {
    const top = y + up;
    const list = this.query(x - half, top - down, z - half, x + half, top, z + half, []);
    let best = -Infinity, bestC = null;
    for (const c of list) {
      let h;
      if (c.type === 'box') h = c.max.y;
      else if (c.type === 'cyl') h = c.y1;
      else h = this.rampHeight(c, x, z);
      if (h <= top + EPS && h > best) { best = h; bestC = c; }
    }
    return bestC ? { y: best, collider: bestC } : null;
  }

  /**
   * Move an upright character box through the world with sliding, step-up and ramp support.
   * state: { pos: Vector3 feet, vel: Vector3, onGround }
   * Returns { onGround, ground, hitWall, hitCeiling, stepped, wallNormal }
   */
  moveCharacter(pos, delta, half, height, opts = {}) {
    const res = this._res || (this._res = { onGround: false, ground: null, hitWall: false, hitCeiling: false, stepped: 0, wallNormal: new THREE.Vector3() });
    res.onGround = false; res.ground = null; res.hitWall = false; res.hitCeiling = false; res.stepped = 0;
    res.wallNormal.set(0, 0, 0);
    const stepH = opts.stepHeight ?? 0.45;
    const canStep = opts.canStep ?? true;

    // Substep long moves to avoid tunnelling (rockets jumps, jump pads).
    const len = Math.hypot(delta.x, delta.y, delta.z);
    const steps = Math.max(1, Math.ceil(len / (half * 0.9)));
    const dx = delta.x / steps, dy = delta.y / steps, dz = delta.z / steps;
    for (let i = 0; i < steps; i++) {
      this._moveAxis(pos, 'x', dx, half, height, stepH, canStep, res);
      this._moveAxis(pos, 'z', dz, half, height, stepH, canStep, res);
      this._moveAxis(pos, 'y', dy, half, height, stepH, canStep, res);
    }
    // Ramps act as ground: lift feet onto slope surface.
    const ramps = this.query(pos.x - half, pos.y - stepH, pos.z - half, pos.x + half, pos.y + height, pos.z + half, []);
    for (const c of ramps) {
      if (c.type !== 'ramp') continue;
      const h = this.rampHeight(c, pos.x, pos.z);
      if (pos.y < h + 0.02 && pos.y > h - stepH - Math.max(0, -delta.y) - 0.05 && delta.y <= 0.001) {
        pos.y = h;
        res.onGround = true;
        res.ground = c;
      }
    }
    return res;
  }

  _moveAxis(pos, axis, amount, half, height, stepH, canStep, res) {
    if (amount === 0) return;
    pos[axis] += amount;
    const list = this.query(pos.x - half, pos.y + EPS, pos.z - half, pos.x + half, pos.y + height - EPS, pos.z + half, []);
    for (const c of list) {
      if (c.type === 'ramp') {
        if (axis === 'y') continue;
        // Wedge side walls: block only if the slope at this point is well above the feet.
        const h = this.rampHeight(c, pos.x, pos.z);
        if (h - pos.y > stepH + 0.05 && pos.y + height > c.min.y) {
          pos[axis] -= amount;
          res.hitWall = true;
          res.wallNormal[axis] = -Math.sign(amount);
          return;
        }
        continue;
      }
      if (c.type === 'cyl') {
        if (axis === 'y') {
          if (amount < 0) { pos.y = c.y1; res.onGround = true; res.ground = c; }
          else { pos.y = c.y0 - height - EPS; res.hitCeiling = true; }
          continue;
        }
        // Radial push out (handled on both axes at once)
        let ox = pos.x - c.x, oz = pos.z - c.z;
        let d = Math.hypot(ox, oz);
        const top = c.y1 - pos.y;
        if (canStep && top > 0 && top <= stepH && this.isFree(pos.x, c.y1 + EPS, pos.z, half, height)) {
          pos.y = c.y1 + EPS; res.stepped = Math.max(res.stepped, top); continue;
        }
        if (d < 1e-5) { ox = 1; oz = 0; d = 1; }
        const push = c.r + half - d;
        if (push > 0) {
          pos.x += (ox / d) * push;
          pos.z += (oz / d) * push;
          res.hitWall = true;
          res.wallNormal.set(ox / d, 0, oz / d);
        }
        continue;
      }
      // Box
      if (axis === 'y') {
        if (amount < 0) {
          pos.y = c.max.y;
          res.onGround = true;
          res.ground = c;
        } else {
          pos.y = c.min.y - height - EPS;
          res.hitCeiling = true;
        }
        continue;
      }
      // Horizontal: try step-up first
      const top = c.max.y - pos.y;
      if (canStep && top > 0 && top <= stepH && this.isFree(pos.x, c.max.y + EPS, pos.z, half, height)) {
        pos.y = c.max.y + EPS;
        res.stepped = Math.max(res.stepped, top);
        continue;
      }
      if (amount > 0) pos[axis] = c.min[axis] - half - EPS;
      else pos[axis] = c.max[axis] + half + EPS;
      res.hitWall = true;
      res.wallNormal[axis] = -Math.sign(amount);
    }
  }

  /** Push a sphere out of solid geometry (ragdolls, casings). Returns true if it collided. */
  resolveSphere(p, r) {
    const list = this.query(p.x - r, p.y - r, p.z - r, p.x + r, p.y + r, p.z + r, []);
    let hit = false;
    for (const c of list) {
      if (c.type === 'box') {
        const cx = Math.max(c.min.x, Math.min(p.x, c.max.x));
        const cy = Math.max(c.min.y, Math.min(p.y, c.max.y));
        const cz = Math.max(c.min.z, Math.min(p.z, c.max.z));
        let dx = p.x - cx, dy = p.y - cy, dz = p.z - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 >= r * r) continue;
        hit = true;
        if (d2 > 1e-10) {
          const d = Math.sqrt(d2);
          const k = (r - d) / d;
          p.x += dx * k; p.y += dy * k; p.z += dz * k;
        } else {
          // Center inside box: exit through the nearest face
          const exits = [
            [p.x - c.min.x, -1, 'x'], [c.max.x - p.x, 1, 'x'],
            [p.y - c.min.y, -1, 'y'], [c.max.y - p.y, 1, 'y'],
            [p.z - c.min.z, -1, 'z'], [c.max.z - p.z, 1, 'z'],
          ].sort((a, b) => a[0] - b[0])[0];
          p[exits[2]] += exits[1] * (exits[0] + r);
        }
      } else if (c.type === 'cyl') {
        const ox = p.x - c.x, oz = p.z - c.z;
        const d = Math.hypot(ox, oz);
        if (p.y > c.y1 - 0.05 && p.y - r < c.y1 && d < c.r) { p.y = c.y1 + r; hit = true; continue; }
        if (d < c.r + r && p.y > c.y0 && p.y < c.y1) {
          const k = (c.r + r - d) / Math.max(d, 1e-5);
          p.x += ox * k; p.z += oz * k; hit = true;
        }
      } else {
        if (p.x < c.min.x || p.x > c.max.x || p.z < c.min.z || p.z > c.max.z) continue;
        const h = this.rampHeight(c, p.x, p.z);
        if (p.y - r < h && p.y > c.min.y - r) { p.y = h + r; hit = true; }
      }
    }
    return hit;
  }

  /**
   * Raycast against the static world. Returns the nearest hit or null.
   * Glass panes that don't block bullets are reported in hit.passed (array) if opts.collect.
   */
  raycast(origin, dir, maxDist, opts = {}) {
    const stamp = ++rayStamp;
    const s = this.cellSize;
    let best = maxDist;
    let bestC = null;
    const bestN = new THREE.Vector3();
    const n = new THREE.Vector3();
    const passed = opts.collect ? [] : null;
    const ignoreGlass = opts.ignoreGlass ?? false;
    const moveOnly = opts.moveOnly ?? false;

    let cx = Math.floor(origin.x / s), cz = Math.floor(origin.z / s);
    const stepX = dir.x > 0 ? 1 : -1, stepZ = dir.z > 0 ? 1 : -1;
    const tDeltaX = Math.abs(dir.x) > 1e-9 ? s / Math.abs(dir.x) : Infinity;
    const tDeltaZ = Math.abs(dir.z) > 1e-9 ? s / Math.abs(dir.z) : Infinity;
    let tMaxX = Math.abs(dir.x) > 1e-9 ? ((stepX > 0 ? (cx + 1) * s - origin.x : origin.x - cx * s) / Math.abs(dir.x)) : Infinity;
    let tMaxZ = Math.abs(dir.z) > 1e-9 ? ((stepZ > 0 ? (cz + 1) * s - origin.z : origin.z - cz * s) / Math.abs(dir.z)) : Infinity;
    let tCell = 0;
    for (let guard = 0; guard < 512; guard++) {
      const cell = this._cell(cx, cz);
      if (cell) {
        for (let i = 0; i < cell.length; i++) {
          const c = cell[i];
          if (c._r === stamp || !c.enabled) continue;
          c._r = stamp;
          if (moveOnly ? !c.blocksMove : (!c.blocksBullets && !c.glass)) continue;
          if (opts.filter && !opts.filter(c)) continue;
          const t = this._rayCollider(origin, dir, c, best, n);
          if (t < 0) continue;
          if (c.glass && !c.blocksBullets) {
            if (ignoreGlass) continue;
            if (passed) passed.push({ t, collider: c });
            continue;
          }
          best = t; bestC = c; bestN.copy(n);
        }
      }
      if (best <= tCell) break;
      if (tMaxX < tMaxZ) { tCell = tMaxX; tMaxX += tDeltaX; cx += stepX; }
      else { tCell = tMaxZ; tMaxZ += tDeltaZ; cz += stepZ; }
      if (tCell > best) break;
    }
    if (!bestC) {
      if (passed && passed.length) return { t: maxDist, point: null, normal: null, collider: null, passed: passed.filter((p) => p.t < maxDist) };
      return null;
    }
    const point = new THREE.Vector3().copy(dir).multiplyScalar(best).add(origin);
    return { t: best, point, normal: bestN, collider: bestC, passed: passed ? passed.filter((p) => p.t < best) : null };
  }

  /** Clear line between two points (bullet-blocking geometry only). */
  lineOfSight(a, b) {
    const d = new THREE.Vector3().subVectors(b, a);
    const len = d.length();
    if (len < 1e-4) return true;
    d.divideScalar(len);
    return !this.raycast(a, d, len - 0.02, { ignoreGlass: true })?.collider;
  }

  _rayCollider(o, d, c, maxT, outN) {
    if (c.type === 'box') return rayBox(o, d, c.min, c.max, maxT, outN);
    if (c.type === 'cyl') return rayCylinder(o, d, c, maxT, outN);
    return rayRamp(o, d, c, maxT, outN);
  }
}

// ----- ray primitives -----

export function rayBox(o, d, min, max, maxT, outN) {
  let tmin = -Infinity, tmax = Infinity;
  let axis = -1, sign = 0;
  for (let a = 0; a < 3; a++) {
    const k = a === 0 ? 'x' : a === 1 ? 'y' : 'z';
    const od = d[k], oo = o[k];
    if (Math.abs(od) < 1e-12) {
      if (oo < min[k] || oo > max[k]) return -1;
      continue;
    }
    let t1 = (min[k] - oo) / od, t2 = (max[k] - oo) / od;
    let s = -1;
    if (t1 > t2) { const tt = t1; t1 = t2; t2 = tt; s = 1; }
    if (t1 > tmin) { tmin = t1; axis = a; sign = s; }
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax || tmax < 0) return -1;
  }
  if (tmin < 0) {
    // Origin inside the box: treat as an immediate hit facing back along the ray.
    if (outN) outN.set(-d.x, -d.y, -d.z);
    return 0;
  }
  if (tmin > maxT) return -1;
  if (outN) {
    outN.set(0, 0, 0);
    const k = axis === 0 ? 'x' : axis === 1 ? 'y' : 'z';
    outN[k] = sign;
  }
  return tmin;
}

function rayCylinder(o, d, c, maxT, outN) {
  let best = Infinity;
  const ox = o.x - c.x, oz = o.z - c.z;
  const a = d.x * d.x + d.z * d.z;
  if (a > 1e-12) {
    const b = 2 * (ox * d.x + oz * d.z);
    const cc = ox * ox + oz * oz - c.r * c.r;
    const disc = b * b - 4 * a * cc;
    if (disc >= 0) {
      const sq = Math.sqrt(disc);
      const t = (-b - sq) / (2 * a);
      if (t >= 0) {
        const y = o.y + d.y * t;
        if (y >= c.y0 && y <= c.y1 && t < best) {
          best = t;
          if (outN) outN.set((ox + d.x * t) / c.r, 0, (oz + d.z * t) / c.r);
        }
      }
    }
  }
  // Caps
  if (Math.abs(d.y) > 1e-12) {
    for (const y of [c.y1, c.y0]) {
      const t = (y - o.y) / d.y;
      if (t < 0 || t >= best) continue;
      const px = ox + d.x * t, pz = oz + d.z * t;
      if (px * px + pz * pz <= c.r * c.r) {
        best = t;
        if (outN) outN.set(0, y === c.y1 ? 1 : -1, 0);
      }
    }
  }
  return best <= maxT ? best : -1;
}

const _planes = [];
function rayRamp(o, d, c, maxT, outN) {
  // Convex clip against 5 box planes + slope plane.
  let tEnter = -Infinity, tExit = Infinity;
  let enterN = null;
  _planes.length = 0;
  _planes.push([-1, 0, 0, -c.min.x], [1, 0, 0, c.max.x], [0, 0, -1, -c.min.z], [0, 0, 1, c.max.z], [0, -1, 0, -c.min.y]);
  _planes.push([c.planeN.x, c.planeN.y, c.planeN.z, c.planeD]);
  for (const p of _planes) {
    const denom = p[0] * d.x + p[1] * d.y + p[2] * d.z;
    const dist = p[3] - (p[0] * o.x + p[1] * o.y + p[2] * o.z);
    if (Math.abs(denom) < 1e-12) {
      if (dist < 0) return -1;
      continue;
    }
    const t = dist / denom;
    if (denom < 0) {
      if (t > tEnter) { tEnter = t; enterN = p; }
    } else if (t < tExit) tExit = t;
    if (tEnter > tExit) return -1;
  }
  if (tExit < 0) return -1;
  const t = Math.max(0, tEnter);
  if (t > maxT) return -1;
  if (outN && enterN) outN.set(enterN[0], enterN[1], enterN[2]);
  return t;
}

// ----- player hitboxes -----

const HEAD_R = 0.2;
export function headCenter(pos, height, out) {
  return out.set(pos.x, pos.y + height - HEAD_R - 0.02, pos.z);
}

/**
 * Ray vs a player's hitboxes (head sphere + body box). Returns { t, head } or null.
 */
export function rayPlayer(o, d, pos, height, maxT, inflate = 0) {
  // Head sphere
  const hr = HEAD_R + inflate;
  const hx = pos.x, hy = pos.y + height - HEAD_R - 0.02, hz = pos.z;
  const lx = o.x - hx, ly = o.y - hy, lz = o.z - hz;
  const b = lx * d.x + ly * d.y + lz * d.z;
  const cc = lx * lx + ly * ly + lz * lz - hr * hr;
  let headT = -1;
  const disc = b * b - cc;
  if (disc >= 0) {
    const t = -b - Math.sqrt(disc);
    if (t >= 0 && t <= maxT) headT = t;
  }
  // Body box (feet to neck)
  const w = 0.3 + inflate;
  const bodyMin = _bmin.set(pos.x - w, pos.y - inflate, pos.z - w);
  const bodyMax = _bmax.set(pos.x + w, pos.y + height - HEAD_R * 2 + 0.04, pos.z + w);
  const bodyT = rayBox(o, d, bodyMin, bodyMax, maxT, null);
  if (headT >= 0 && (bodyT < 0 || headT <= bodyT + 0.05)) return { t: headT, head: true };
  if (bodyT >= 0) return { t: bodyT, head: false };
  return null;
}
const _bmin = new THREE.Vector3();
const _bmax = new THREE.Vector3();

/** Closest distance from point to a player's body AABB (for splash damage). */
export function distToPlayer(p, pos, height) {
  const w = 0.3;
  const cx = Math.max(pos.x - w, Math.min(p.x, pos.x + w));
  const cy = Math.max(pos.y, Math.min(p.y, pos.y + height));
  const cz = Math.max(pos.z - w, Math.min(p.z, pos.z + w));
  return Math.hypot(p.x - cx, p.y - cy, p.z - cz);
}

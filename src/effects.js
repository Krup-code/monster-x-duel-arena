// Pooled visual effects. Everything is preallocated (object pooling) so combat never
// allocates meshes or materials: spark streaks, smoke, fireballs, tracers, rail beams,
// bullet-hole and scorch decals, shell casings, flashes and Energy Rush trails.
import * as THREE from 'three';
import { PALETTE } from './config.js';

const _v = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix4();
const _s = new THREE.Vector3();
const UP = new THREE.Vector3(0, 0, 1);

const QUALITY = {
  low: { sparks: 360, smoke: 90, fire: 60, decals: 60, casings: 10, trail: 12 },
  medium: { sparks: 800, smoke: 180, fire: 120, decals: 120, casings: 20, trail: 18 },
  high: { sparks: 1600, smoke: 320, fire: 220, decals: 200, casings: 30, trail: 26 },
};

// ---------- spark streaks (LineSegments) ----------
class SparkSystem {
  constructor(n) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.col = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.grav = new Float32Array(n);
    this.drag = new Float32Array(n);
    this.len = new Float32Array(n);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    this.gpos = new Float32Array(n * 6);
    this.gcol = new Float32Array(n * 6);
    g.setAttribute('position', new THREE.BufferAttribute(this.gpos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.gcol, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    this.mesh = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 6;
    this.alive = 0;
  }

  emit(p, v, color, life, opts = {}) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    const i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    this.vel[i3] = v.x; this.vel[i3 + 1] = v.y; this.vel[i3 + 2] = v.z;
    this.col[i3] = color.r; this.col[i3 + 1] = color.g; this.col[i3 + 2] = color.b;
    this.life[i] = life; this.max[i] = life;
    this.grav[i] = opts.gravity ?? 9;
    this.drag[i] = opts.drag ?? 1.5;
    this.len[i] = opts.length ?? 0.035;
  }

  update(dt) {
    const { pos, vel, col, life, max, grav, drag, len, gpos, gcol } = this;
    let any = 0;
    for (let i = 0; i < this.n; i++) {
      const i3 = i * 3, i6 = i * 6;
      if (life[i] <= 0) {
        if (gcol[i6] !== 0 || gcol[i6 + 1] !== 0) { for (let k = 0; k < 6; k++) gcol[i6 + k] = 0; }
        continue;
      }
      any++;
      life[i] -= dt;
      const d = Math.exp(-drag[i] * dt);
      vel[i3] *= d; vel[i3 + 1] = vel[i3 + 1] * d - grav[i] * dt; vel[i3 + 2] *= d;
      pos[i3] += vel[i3] * dt; pos[i3 + 1] += vel[i3 + 1] * dt; pos[i3 + 2] += vel[i3 + 2] * dt;
      const k = Math.max(0, life[i] / max[i]);
      const L = len[i];
      gpos[i6] = pos[i3]; gpos[i6 + 1] = pos[i3 + 1]; gpos[i6 + 2] = pos[i3 + 2];
      gpos[i6 + 3] = pos[i3] - vel[i3] * L; gpos[i6 + 4] = pos[i3 + 1] - vel[i3 + 1] * L; gpos[i6 + 5] = pos[i3 + 2] - vel[i3 + 2] * L;
      const b = k * k;
      gcol[i6] = col[i3] * b; gcol[i6 + 1] = col[i3 + 1] * b; gcol[i6 + 2] = col[i3 + 2] * b;
      gcol[i6 + 3] = col[i3] * b * 0.2; gcol[i6 + 4] = col[i3 + 1] * b * 0.2; gcol[i6 + 5] = col[i3 + 2] * b * 0.2;
    }
    if (any || this.alive) {
      this.geo.attributes.position.needsUpdate = true;
      this.geo.attributes.color.needsUpdate = true;
    }
    this.alive = any;
  }
}

// ---------- soft sprite particles (smoke / fire) ----------
class SpriteSystem {
  constructor(n, tex, additive) {
    this.n = n;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.max = new Float32Array(n);
    this.size0 = new Float32Array(n);
    this.size1 = new Float32Array(n);
    this.alpha0 = new Float32Array(n);
    this.col = new Float32Array(n * 3);
    this.grav = new Float32Array(n);
    this.next = 0;
    const g = new THREE.BufferGeometry();
    this.gpos = new Float32Array(n * 3);
    this.gsize = new Float32Array(n);
    this.galpha = new Float32Array(n);
    this.gcol = new Float32Array(n * 3);
    g.setAttribute('position', new THREE.BufferAttribute(this.gpos, 3).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('size', new THREE.BufferAttribute(this.gsize, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('alpha', new THREE.BufferAttribute(this.galpha, 1).setUsage(THREE.DynamicDrawUsage));
    g.setAttribute('color', new THREE.BufferAttribute(this.gcol, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo = g;
    const mat = new THREE.ShaderMaterial({
      transparent: true, depthWrite: false, blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
      uniforms: { uTex: { value: tex }, uScale: { value: 600 } },
      vertexShader: `attribute float size; attribute float alpha; attribute vec3 color; uniform float uScale; varying float vA; varying vec3 vC;
        void main(){ vA = alpha; vC = color; vec4 mv = modelViewMatrix*vec4(position,1.0); gl_PointSize = size * uScale / max(0.1, -mv.z); gl_Position = projectionMatrix*mv; }`,
      fragmentShader: `uniform sampler2D uTex; varying float vA; varying vec3 vC;
        void main(){ vec4 t = texture2D(uTex, gl_PointCoord); float a = t.a * vA; if (a < 0.003) discard; gl_FragColor = vec4(vC * t.rgb${additive ? ' * a' : ''}, a); }`,
    });
    this.mat = mat;
    this.mesh = new THREE.Points(g, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = additive ? 7 : 5;
    this.alive = 0;
  }

  emit(p, v, color, life, s0, s1, a0, gravity = 0) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    const i3 = i * 3;
    this.pos[i3] = p.x; this.pos[i3 + 1] = p.y; this.pos[i3 + 2] = p.z;
    this.vel[i3] = v.x; this.vel[i3 + 1] = v.y; this.vel[i3 + 2] = v.z;
    this.col[i3] = color.r; this.col[i3 + 1] = color.g; this.col[i3 + 2] = color.b;
    this.life[i] = life; this.max[i] = life;
    this.size0[i] = s0; this.size1[i] = s1; this.alpha0[i] = a0; this.grav[i] = gravity;
  }

  update(dt) {
    let any = 0;
    for (let i = 0; i < this.n; i++) {
      if (this.life[i] <= 0) { this.galpha[i] = 0; continue; }
      any++;
      this.life[i] -= dt;
      const i3 = i * 3;
      const d = Math.exp(-1.2 * dt);
      this.vel[i3] *= d; this.vel[i3 + 1] = this.vel[i3 + 1] * d - this.grav[i] * dt; this.vel[i3 + 2] *= d;
      this.pos[i3] += this.vel[i3] * dt; this.pos[i3 + 1] += this.vel[i3 + 1] * dt; this.pos[i3 + 2] += this.vel[i3 + 2] * dt;
      const t = 1 - Math.max(0, this.life[i] / this.max[i]);
      this.gpos[i3] = this.pos[i3]; this.gpos[i3 + 1] = this.pos[i3 + 1]; this.gpos[i3 + 2] = this.pos[i3 + 2];
      this.gsize[i] = this.size0[i] + (this.size1[i] - this.size0[i]) * Math.sqrt(t);
      this.galpha[i] = this.alpha0[i] * (1 - t) * Math.min(1, t * 12);
      this.gcol[i3] = this.col[i3]; this.gcol[i3 + 1] = this.col[i3 + 1]; this.gcol[i3 + 2] = this.col[i3 + 2];
    }
    if (any || this.alive) {
      for (const k of ['position', 'size', 'alpha', 'color']) this.geo.attributes[k].needsUpdate = true;
    }
    this.alive = any;
  }
}

// ---------- decals ----------
class DecalPool {
  constructor(n, tex, size, opts = {}) {
    const mat = new THREE.MeshStandardMaterial({
      map: tex, transparent: true, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4,
      roughness: 0.9, metalness: 0.2, color: opts.color ?? 0xffffff,
    });
    this.mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(1, 1), mat, n);
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.n = n;
    this.size = size;
    this.next = 0;
    this.mesh.count = 0;
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < n; i++) this.mesh.setMatrixAt(i, _m);
  }

  add(p, normal, scale = 1) {
    const i = this.next;
    this.next = (this.next + 1) % this.n;
    _q.setFromUnitVectors(UP, normal);
    const rot = new THREE.Quaternion().setFromAxisAngle(UP, Math.random() * Math.PI * 2);
    _q.multiply(rot);
    _v.copy(p).addScaledVector(normal, 0.006);
    const s = this.size * scale * (0.8 + Math.random() * 0.4);
    _s.set(s, s, s);
    _m.compose(_v, _q, _s);
    this.mesh.setMatrixAt(i, _m);
    this.mesh.count = Math.max(this.mesh.count, i + 1);
    this.mesh.instanceMatrix.needsUpdate = true;
  }

  clear() {
    _m.makeScale(0, 0, 0);
    for (let i = 0; i < this.n; i++) this.mesh.setMatrixAt(i, _m);
    this.mesh.count = 0;
    this.next = 0;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ---------- main ----------
export class Effects {
  constructor(scene, lib, quality = 'high', world = null) {
    this.scene = scene;
    this.lib = lib;
    this.world = world;
    this.q = QUALITY[quality] || QUALITY.high;
    this.quality = quality;
    this.group = new THREE.Group();
    this.group.name = 'effects';
    scene.add(this.group);

    this.sparks = new SparkSystem(this.q.sparks);
    this.smoke = new SpriteSystem(this.q.smoke, lib.sprites.smoke, false);
    this.fire = new SpriteSystem(this.q.fire, lib.sprites.flare, true);
    this.glow = new SpriteSystem(Math.max(60, this.q.fire), lib.sprites.dot, true);
    this.group.add(this.sparks.mesh, this.smoke.mesh, this.fire.mesh, this.glow.mesh);

    this.holes = new DecalPool(this.q.decals, lib.decals.hole, 0.13);
    this.scorch = new DecalPool(24, lib.decals.scorch, 2.6);
    this.group.add(this.holes.mesh, this.scorch.mesh);

    // tracers
    this.tracers = [];
    const tracerGeo = new THREE.BoxGeometry(1, 1, 1);
    tracerGeo.translate(0, 0, -0.5);
    for (let i = 0; i < 28; i++) {
      const mat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
      const m = new THREE.Mesh(tracerGeo, mat);
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 8;
      this.group.add(m);
      this.tracers.push({ mesh: m, from: new THREE.Vector3(), to: new THREE.Vector3(), dist: 0, t: 0, speed: 0, len: 0, active: false, color: new THREE.Color() });
    }
    this.nextTracer = 0;

    // rail beams
    this.beams = [];
    const coreGeo = new THREE.CylinderGeometry(1, 1, 1, 8, 1, true);
    coreGeo.rotateX(Math.PI / 2);
    coreGeo.translate(0, 0, -0.5);
    for (let i = 0; i < 4; i++) {
      const core = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      const glow = new THREE.Mesh(coreGeo, new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, opacity: 0.4 }));
      core.visible = glow.visible = false;
      core.frustumCulled = glow.frustumCulled = false;
      core.renderOrder = glow.renderOrder = 8;
      this.group.add(core, glow);
      this.beams.push({ core, glow, t: 0, life: 0, color: new THREE.Color() });
    }
    this.nextBeam = 0;

    // flash sprites (muzzle flashes for third person, explosion cores)
    this.flashes = [];
    for (let i = 0; i < 10; i++) {
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: lib.sprites.flare, color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false }));
      sp.visible = false;
      sp.renderOrder = 9;
      this.group.add(sp);
      this.flashes.push({ sp, t: 0, life: 0, size: 1 });
    }
    this.nextFlash = 0;

    // shockwave rings
    this.rings = [];
    for (let i = 0; i < 4; i++) {
      const m = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
      m.visible = false;
      m.renderOrder = 8;
      this.group.add(m);
      this.rings.push({ m, t: 0, life: 0, size: 1 });
    }

    // shell casings
    this.casings = [];
    const casingGeo = new THREE.CylinderGeometry(0.008, 0.008, 0.035, 6);
    casingGeo.rotateZ(Math.PI / 2);
    const brass = new THREE.MeshStandardMaterial({ color: 0xc9a14a, metalness: 1, roughness: 0.3, emissive: 0x1a1200 });
    const green = new THREE.MeshStandardMaterial({ color: 0x46a01a, metalness: 0.9, roughness: 0.3, emissive: 0x142a06 });
    const shell = new THREE.MeshStandardMaterial({ color: 0xa01a10, metalness: 0.4, roughness: 0.5 });
    this.casingMats = { brass, green, shell };
    for (let i = 0; i < this.q.casings; i++) {
      const m = new THREE.Mesh(casingGeo, brass);
      m.visible = false;
      this.group.add(m);
      this.casings.push({ m, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0, bounced: 0 });
    }
    this.nextCasing = 0;

    // pooled dynamic lights (constant count -> no shader recompiles)
    this.lights = [];
    for (let i = 0; i < 2; i++) {
      const l = new THREE.PointLight(0xffffff, 0, 10, 2);
      l.visible = true;
      this.group.add(l);
      this.lights.push({ l, t: 0, life: 0, peak: 0 });
    }
    this.nextLight = 0;

    // Energy Rush trails
    this.trails = new Map();
    this.onSound = null; // (name, pos) hook for casings
  }

  _light(pos, color, intensity, distance, life) {
    const L = this.lights[this.nextLight];
    this.nextLight = (this.nextLight + 1) % this.lights.length;
    L.l.position.copy(pos);
    L.l.color.set(color);
    L.l.distance = distance;
    L.peak = intensity;
    L.life = life;
    L.t = 0;
    L.l.intensity = intensity;
  }

  flash(pos, color, size, life = 0.05) {
    const f = this.flashes[this.nextFlash];
    this.nextFlash = (this.nextFlash + 1) % this.flashes.length;
    f.sp.position.copy(pos);
    f.sp.material.color.set(color).multiplyScalar(3);
    f.sp.material.rotation = Math.random() * Math.PI;
    f.size = size;
    f.sp.scale.setScalar(size);
    f.t = 0;
    f.life = life;
    f.sp.visible = true;
  }

  /** World-space muzzle flash for remote players (sprite + light). */
  muzzle(pos, color = 0xfff0c0, big = false) {
    this.flash(pos, color, big ? 1.1 : 0.6, 0.05);
    this._light(pos, color, big ? 30 : 16, 8, 0.06);
  }

  /** Local player's muzzle light at the camera so the world lights up when firing. */
  localMuzzleLight(pos, color, strength = 1) {
    this._light(pos, color, 14 * strength, 9, 0.055);
  }

  tracer(from, to, color = 0xfff2b0, opts = {}) {
    const tr = this.tracers[this.nextTracer];
    this.nextTracer = (this.nextTracer + 1) % this.tracers.length;
    tr.from.copy(from);
    tr.to.copy(to);
    tr.dist = from.distanceTo(to);
    if (tr.dist < 0.5) return;
    tr.speed = opts.speed ?? 320;
    tr.len = Math.min(opts.length ?? 3.5, tr.dist);
    tr.width = opts.width ?? 0.018;
    tr.t = 0;
    tr.active = true;
    tr.color.set(color).multiplyScalar(opts.intensity ?? 4);
    tr.mesh.material.color.copy(tr.color);
    tr.mesh.visible = true;
  }

  railBeam(from, to, color = PALETTE.acid) {
    const b = this.beams[this.nextBeam];
    this.nextBeam = (this.nextBeam + 1) % this.beams.length;
    const len = from.distanceTo(to);
    for (const m of [b.core, b.glow]) {
      m.position.copy(from);
      m.lookAt(to);
      m.visible = true;
    }
    b.core.scale.set(0.035, 0.035, len);
    b.glow.scale.set(0.16, 0.16, len);
    b.color.set(color);
    b.core.material.color.set(0xffffff).multiplyScalar(6);
    b.glow.material.color.copy(b.color).multiplyScalar(4);
    b.t = 0;
    b.life = 0.65;
    // spiral of sparks along the beam
    const dir = _v2.subVectors(to, from).normalize();
    const side = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0));
    if (side.lengthSq() < 1e-4) side.set(1, 0, 0);
    side.normalize();
    const up = new THREE.Vector3().crossVectors(side, dir);
    const steps = Math.min(140, Math.floor(len * (this.quality === 'low' ? 2 : 5)));
    const c = new THREE.Color(color).multiplyScalar(2.2);
    for (let i = 0; i < steps; i++) {
      const t = i / steps;
      const a = t * len * 2.2;
      _v.copy(from).addScaledVector(dir, t * len);
      const off = new THREE.Vector3().addScaledVector(side, Math.cos(a) * 0.12).addScaledVector(up, Math.sin(a) * 0.12);
      _v.add(off);
      this.glow.emit(_v, off.multiplyScalar(2.5), c, 0.35 + Math.random() * 0.4, 0.05, 0.12, 0.9, -0.3);
    }
    this._light(from, color, 25, 14, 0.18);
  }

  impact(point, normal, surface = 'concrete', opts = {}) {
    const n = normal || _v2.set(0, 1, 0);
    const count = this.quality === 'low' ? 4 : this.quality === 'medium' ? 7 : 11;
    const metal = surface === 'metal' || surface === 'grate';
    const col = opts.color ? new THREE.Color(opts.color) : metal ? new THREE.Color(3.2, 2.6, 1.2) : new THREE.Color(1.6, 1.4, 1.1);
    for (let i = 0; i < count; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.5, Math.random() - 0.5).multiplyScalar(1.4).add(n).normalize().multiplyScalar(3 + Math.random() * (metal ? 9 : 5));
      this.sparks.emit(point, _v, col, 0.15 + Math.random() * 0.3, { gravity: 12, length: 0.02 });
    }
    if (!opts.noSmoke) {
      const dust = surface === 'gravel' || surface === 'concrete' ? new THREE.Color(0.55, 0.55, 0.5) : new THREE.Color(0.35, 0.37, 0.36);
      _v.copy(n).multiplyScalar(0.9);
      this.smoke.emit(point, _v, dust, 0.7 + Math.random() * 0.3, 0.12, 0.55, 0.45);
    }
    if (!opts.noDecal && surface !== 'glass') this.holes.add(point, n, opts.decalScale ?? 1);
    this.flash(_v.copy(point).addScaledVector(n, 0.03), metal ? 0xfff0b0 : 0xffffff, 0.22, 0.04);
  }

  /** Player hit: energy sparks in the victim's accent color (no gore). */
  playerHit(point, dir, color, head = false) {
    const c = new THREE.Color(color).multiplyScalar(head ? 4 : 2.6);
    const count = head ? 16 : 9;
    for (let i = 0; i < count; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.3, Math.random() - 0.5).multiplyScalar(2).addScaledVector(dir, 1.2).normalize().multiplyScalar(2 + Math.random() * 5);
      this.sparks.emit(point, _v, c, 0.18 + Math.random() * 0.25, { gravity: 6, length: 0.025 });
    }
    this.glow.emit(point, _v.set(0, 0.3, 0), c, 0.2, 0.15, 0.5, 0.9);
  }

  explosion(pos, radius = 4.5, color = 0xff7a1a) {
    const n = this.quality === 'low' ? 18 : this.quality === 'medium' ? 30 : 46;
    const hot = new THREE.Color(color).multiplyScalar(2.4);
    const core = new THREE.Color(2.4, 2.2, 1.6);
    for (let i = 0; i < n; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.35, Math.random() - 0.5).normalize().multiplyScalar(radius * (0.6 + Math.random() * 1.4));
      this.fire.emit(pos, _v, i % 3 === 0 ? core : hot, 0.35 + Math.random() * 0.35, 0.5 + Math.random() * 0.6, 1.4 + Math.random() * 1.6, 1, -1);
    }
    for (let i = 0; i < n; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).normalize().multiplyScalar(8 + Math.random() * 18);
      this.sparks.emit(pos, _v, new THREE.Color(3, 2, 0.8), 0.4 + Math.random() * 0.6, { gravity: 14, drag: 1.2, length: 0.03 });
    }
    for (let i = 0; i < n / 2; i++) {
      _v.set(Math.random() - 0.5, Math.random() * 0.5, Math.random() - 0.5).normalize().multiplyScalar(1.5 + Math.random() * 2.5);
      const g = 0.12 + Math.random() * 0.1;
      this.smoke.emit(_v2.copy(pos).addScaledVector(_v, 0.3), _v, new THREE.Color(g, g, g * 0.95), 1.6 + Math.random() * 1.2, 1.0, 3.6, 0.65, -0.6);
    }
    this.flash(pos, color, radius * 1.6, 0.12);
    this.flash(pos, 0xffffff, radius * 0.8, 0.07);
    const r = this.rings.find((x) => x.life <= 0) || this.rings[0];
    r.m.position.copy(pos);
    r.m.lookAt(_v.copy(pos).add(new THREE.Vector3(0, 1, 0)));
    r.m.material.color.set(color).multiplyScalar(2.5);
    r.size = radius * 1.4;
    r.t = 0;
    r.life = 0.35;
    r.m.visible = true;
    this._light(pos, color, 120, radius * 5, 0.35);
    // scorch on the ground if close
    if (this.world) {
      const hit = this.world.raycast(pos, _v.set(0, -1, 0), 2.5, { ignoreGlass: true });
      if (hit?.normal) this.scorch.add(hit.point, hit.normal, radius / 4.5);
    }
  }

  energyBurst(pos, color = PALETTE.acid, power = 1) {
    const c = new THREE.Color(color).multiplyScalar(3);
    const n = Math.floor((this.quality === 'low' ? 14 : 30) * power);
    for (let i = 0; i < n; i++) {
      _v.set(Math.random() - 0.5, Math.random() - 0.2, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 6 * power);
      this.sparks.emit(pos, _v, c, 0.4 + Math.random() * 0.5, { gravity: 3, drag: 2.2, length: 0.04 });
      if (i % 2 === 0) this.glow.emit(pos, _v.multiplyScalar(0.4), c, 0.5 + Math.random() * 0.4, 0.08, 0.2, 0.9, -1);
    }
    this.flash(pos, color, 1.4 * power, 0.12);
  }

  spawnBeam(pos, color) {
    const c = new THREE.Color(color).multiplyScalar(2.5);
    for (let i = 0; i < 40; i++) {
      const a = Math.random() * Math.PI * 2, r = 0.5 + Math.random() * 0.2;
      _v.set(pos.x + Math.cos(a) * r, pos.y + Math.random() * 0.2, pos.z + Math.sin(a) * r);
      this.glow.emit(_v, _v2.set(0, 3 + Math.random() * 4, 0), c, 0.6 + Math.random() * 0.4, 0.06, 0.14, 0.9, 0);
    }
    this._light(_v.copy(pos).setY(pos.y + 1), color, 20, 8, 0.4);
  }

  sparkBurst(pos, count = 14, color = null) {
    const c = color ? new THREE.Color(color) : new THREE.Color(3.2, 2.8, 1.6);
    for (let i = 0; i < count; i++) {
      _v.set(Math.random() - 0.5, Math.random() * 0.8, Math.random() - 0.5).normalize().multiplyScalar(2 + Math.random() * 5);
      this.sparks.emit(pos, _v, c, 0.3 + Math.random() * 0.6, { gravity: 14, drag: 0.8, length: 0.03 });
    }
    this.flash(pos, 0xfff4c0, 0.45, 0.05);
  }

  steam(pos) {
    _v.set((Math.random() - 0.5) * 0.4, 2.4 + Math.random() * 1.6, (Math.random() - 0.5) * 0.4);
    const g = 0.7 + Math.random() * 0.2;
    this.smoke.emit(pos, _v, new THREE.Color(g, g, g), 1.6 + Math.random() * 0.8, 0.3, 1.8, 0.16, -0.4);
  }

  glassShatter(center, size) {
    const n = this.quality === 'low' ? 20 : 50;
    const c = new THREE.Color(1.6, 2.4, 1.8);
    for (let i = 0; i < n; i++) {
      _v.set(center.x + (Math.random() - 0.5) * size.x, center.y + (Math.random() - 0.5) * size.y, center.z + (Math.random() - 0.5) * size.z);
      _v2.set((Math.random() - 0.5) * 4, Math.random() * 2, (Math.random() - 0.5) * 4);
      this.sparks.emit(_v, _v2, c, 0.6 + Math.random() * 0.5, { gravity: 14, drag: 0.4, length: 0.05 });
    }
  }

  casing(pos, vel, kind = 'brass') {
    if (!this.casings.length) return;
    const c = this.casings[this.nextCasing];
    this.nextCasing = (this.nextCasing + 1) % this.casings.length;
    c.m.material = this.casingMats[kind] || this.casingMats.brass;
    c.m.scale.setScalar(kind === 'shell' ? 2.2 : 1);
    c.m.position.copy(pos);
    c.vel.copy(vel);
    c.spin.set(Math.random() * 20, Math.random() * 20, Math.random() * 20);
    c.life = 1.6;
    c.bounced = 0;
    c.m.visible = true;
  }

  /** Energy Rush ghost trail following an entity. */
  trail(id, pos, active, color = PALETTE.acid) {
    let tr = this.trails.get(id);
    if (!tr) {
      const n = this.q.trail;
      const geo = new THREE.BufferGeometry();
      const p = new Float32Array(n * 2 * 3);
      const a = new Float32Array(n * 2);
      geo.setAttribute('position', new THREE.BufferAttribute(p, 3).setUsage(THREE.DynamicDrawUsage));
      geo.setAttribute('alpha', new THREE.BufferAttribute(a, 1).setUsage(THREE.DynamicDrawUsage));
      const idx = [];
      for (let i = 0; i < n - 1; i++) { const k = i * 2; idx.push(k, k + 1, k + 2, k + 1, k + 3, k + 2); }
      geo.setIndex(idx);
      const mat = new THREE.ShaderMaterial({
        transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
        uniforms: { uColor: { value: new THREE.Color(color) } },
        vertexShader: 'attribute float alpha; varying float vA; void main(){ vA = alpha; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
        fragmentShader: 'uniform vec3 uColor; varying float vA; void main(){ gl_FragColor = vec4(uColor*2.5*vA, vA); }',
      });
      const mesh = new THREE.Mesh(geo, mat);
      mesh.frustumCulled = false;
      mesh.renderOrder = 6;
      this.group.add(mesh);
      tr = { mesh, geo, pts: [], n, timer: 0, fade: 0 };
      this.trails.set(id, tr);
    }
    tr.active = active;
    tr.mesh.material.uniforms.uColor.value.set(color);
    tr.pos = tr.pos || new THREE.Vector3();
    tr.pos.copy(pos);
  }

  _updateTrails(dt) {
    for (const tr of this.trails.values()) {
      tr.fade = THREE.MathUtils.clamp(tr.fade + (tr.active ? dt * 4 : -dt * 2), 0, 1);
      tr.timer -= dt;
      if (tr.pos && tr.timer <= 0) {
        tr.timer = 0.025;
        tr.pts.unshift(tr.pos.clone());
        if (tr.pts.length > tr.n) tr.pts.length = tr.n;
      }
      const p = tr.geo.attributes.position.array, a = tr.geo.attributes.alpha.array;
      for (let i = 0; i < tr.n; i++) {
        const q = tr.pts[Math.min(i, tr.pts.length - 1)] || tr.pos || _v.set(0, -100, 0);
        const k = 1 - i / tr.n;
        p[i * 6] = q.x; p[i * 6 + 1] = q.y + 0.25; p[i * 6 + 2] = q.z;
        p[i * 6 + 3] = q.x; p[i * 6 + 4] = q.y + 1.55; p[i * 6 + 5] = q.z;
        const al = k * k * 0.35 * tr.fade * (i < tr.pts.length ? 1 : 0);
        a[i * 2] = al * 0.4; a[i * 2 + 1] = al;
      }
      tr.geo.attributes.position.needsUpdate = true;
      tr.geo.attributes.alpha.needsUpdate = true;
      tr.mesh.visible = tr.fade > 0.001;
    }
  }

  clearDecals() {
    this.holes.clear();
    this.scorch.clear();
  }

  update(dt, camera) {
    this.sparks.update(dt);
    this.smoke.update(dt);
    this.fire.update(dt);
    this.glow.update(dt);
    for (const tr of this.tracers) {
      if (!tr.active) continue;
      tr.t += dt;
      const head = Math.min(tr.dist, tr.t * tr.speed);
      const tail = Math.max(0, head - tr.len);
      if (tail >= tr.dist - 0.01) { tr.active = false; tr.mesh.visible = false; continue; }
      _v.subVectors(tr.to, tr.from).normalize();
      tr.mesh.position.copy(tr.from).addScaledVector(_v, head);
      tr.mesh.lookAt(_v2.copy(tr.from).addScaledVector(_v, head + 1));
      // keep tracers thin but visible at distance
      const w = tr.width * (1 + (camera ? tr.mesh.position.distanceTo(camera.position) * 0.02 : 0));
      tr.mesh.scale.set(w, w, Math.max(0.01, head - tail));
    }
    for (const b of this.beams) {
      if (b.life <= 0) continue;
      b.t += dt;
      const k = Math.max(0, 1 - b.t / b.life);
      b.core.material.opacity = k * k;
      b.glow.material.opacity = k * 0.6;
      const w = 0.16 * (1 + (1 - k) * 1.5);
      b.glow.scale.x = b.glow.scale.y = w;
      b.core.scale.x = b.core.scale.y = 0.035 * (0.4 + k);
      if (b.t >= b.life) { b.life = 0; b.core.visible = b.glow.visible = false; }
    }
    for (const f of this.flashes) {
      if (!f.sp.visible) continue;
      f.t += dt;
      const k = 1 - f.t / f.life;
      if (k <= 0) { f.sp.visible = false; continue; }
      f.sp.material.opacity = k;
      f.sp.scale.setScalar(f.size * (0.8 + (1 - k) * 0.5));
    }
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.t += dt;
      const k = r.t / r.life;
      if (k >= 1) { r.life = 0; r.m.visible = false; continue; }
      r.m.scale.setScalar(0.2 + k * r.size);
      r.m.material.opacity = (1 - k) * 0.8;
    }
    for (const L of this.lights) {
      if (L.life <= 0) { L.l.intensity = 0; continue; }
      L.t += dt;
      const k = 1 - L.t / L.life;
      L.l.intensity = k > 0 ? L.peak * k * k : 0;
      if (k <= 0) L.life = 0;
    }
    for (const c of this.casings) {
      if (c.life <= 0) continue;
      c.life -= dt;
      c.vel.y -= 15 * dt;
      c.m.position.addScaledVector(c.vel, dt);
      c.m.rotation.x += c.spin.x * dt; c.m.rotation.y += c.spin.y * dt; c.m.rotation.z += c.spin.z * dt;
      if (this.world && this.world.resolveSphere(c.m.position, 0.02)) {
        if (c.vel.y < 0) c.vel.y *= -0.35;
        c.vel.x *= 0.5; c.vel.z *= 0.5;
        c.spin.multiplyScalar(0.5);
        if (c.bounced++ === 0 && this.onSound) this.onSound('casing', c.m.position);
      }
      if (c.life <= 0) c.m.visible = false;
    }
    this._updateTrails(dt);
  }
}

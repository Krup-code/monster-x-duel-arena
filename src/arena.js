// THE BLACKOUT FACILITY — an abandoned underground extreme-sports research facility turned
// illegal combat arena. Layout is mirror-symmetric across x = 0 so neither spawn side has
// an advantage. Unique power positions (Chaos Launcher, Energy Rail, Mega Energy, north
// armor) sit on the mirror plane, equidistant from both bases.
//
//   z=+26  NORTH YARD (gravel, containers, jump pads, tunnel ramp)  + north catwalk y=4.5
//   z=+12  ───────── divider with 4 gaps ─────────
//          WEST BASE | CENTRAL ATRIUM: X-CORE REACTOR, catwalk ring y=4.5, top y=9.5 | EAST BASE
//          (tunnels + core chamber below at y=-4)
//   z=-12  ───────── divider with doors + breakable windows ─── gallery walkway y=4.5
//   z=-26  SOUTH GALLERY (control rooms, machinery, sniper platform y=8)
import * as THREE from 'three';
import { ArenaBuilder } from './arenaBuilder.js';
import { PALETTE } from './config.js';
import { PickupVisual } from './pickups.js';
import { drawXEmblem, neon } from './textures.js';
import { buildTraining } from './training.js';

export const MAPS = {
  blackout: { id: 'blackout', name: 'THE BLACKOUT FACILITY', desc: 'Neon-lit reactor arena. Fight around, above and below the X-Core.' },
  lockdown: { id: 'lockdown', name: 'BLACKOUT: LOCKDOWN', desc: 'Same facility on emergency power. Red alert, heavy fog, short sightlines.' },
  training: { id: 'training', name: 'TRAINING GROUNDS', desc: 'Targets, weapon racks and a movement course.' },
};

// ---------------------------------------------------------------------------
// Shaders
// ---------------------------------------------------------------------------
const NOISE_GLSL = `
float hash(vec2 p){ p = fract(p*vec2(123.34, 456.21)); p += dot(p, p+45.32); return fract(p.x*p.y); }
float noise(vec2 p){ vec2 i=floor(p), f=fract(p); vec2 u=f*f*(3.0-2.0*f);
  return mix(mix(hash(i), hash(i+vec2(1,0)), u.x), mix(hash(i+vec2(0,1)), hash(i+vec2(1,1)), u.x), u.y); }
float fbm(vec2 p){ float v=0.0, a=0.5; for(int i=0;i<4;i++){ v+=a*noise(p); p*=2.03; a*=0.5; } return v; }
`;

function reactorCoreMaterial(color) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uPulse: { value: 0 } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv = uv; vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform float uPulse; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      ${NOISE_GLSL}
      void main(){
        vec2 p = vec2(vUv.x*10.0, vUv.y*6.0);
        float f = fbm(p + vec2(0.0, -uTime*0.9)) * 0.65 + fbm(p*2.3 + vec2(uTime*0.2, -uTime*1.7)) * 0.35;
        float streak = pow(fbm(vec2(vUv.x*24.0, vUv.y*1.5 - uTime*0.5)), 3.0) * 2.5;
        vec2 bp = vec2(vUv.x*48.0, vUv.y*90.0 - uTime*14.0);
        float bubble = step(0.985, hash(floor(bp))) * smoothstep(0.5, 0.0, length(fract(bp)-0.5));
        float fres = pow(1.0 - abs(dot(vN, vV)), 2.0);
        float band = 0.5 + 0.5*sin(vUv.y*60.0 - uTime*5.0);
        vec3 col = uColor * (0.35 + f*1.25 + streak*0.6 + band*0.12 + uPulse*0.6) + vec3(0.9,1.0,0.8) * (bubble*2.0 + pow(f,6.0)*2.0);
        col += uColor * fres * 0.8;
        gl_FragColor = vec4(col, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }`,
  });
}

function hologramMaterial(tex, color = PALETTE.acid) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uTex: { value: tex }, uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uSeed: { value: Math.random() * 10 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `uniform sampler2D uTex; uniform float uTime; uniform vec3 uColor; uniform float uSeed; varying vec2 vUv;
      ${NOISE_GLSL}
      void main(){
        vec2 uv = vUv;
        float g = step(0.96, hash(vec2(floor(uTime*8.0 + uSeed), floor(uv.y*20.0))));
        uv.x += g * (hash(vec2(uTime, uv.y)) - 0.5) * 0.08;
        vec4 t = texture2D(uTex, uv);
        float scan = 0.65 + 0.35*sin(uv.y*420.0 - uTime*8.0);
        float flick = 0.8 + 0.2*step(0.3, noise(vec2(uTime*6.0 + uSeed, 0.0)));
        float edge = smoothstep(0.0, 0.06, vUv.x) * smoothstep(1.0, 0.94, vUv.x) * smoothstep(0.0, 0.05, vUv.y) * smoothstep(1.0, 0.95, vUv.y);
        float a = max(t.a, 0.0) * scan * flick * edge;
        vec3 col = mix(uColor, t.rgb, 0.55) * 2.2;
        gl_FragColor = vec4(col * a + uColor * 0.04 * edge * scan, a);
      }`,
  });
}

function jumpPadMaterial(color) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uKick: { value: 0 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `uniform float uTime; uniform vec3 uColor; uniform float uKick; varying vec2 vUv;
      void main(){
        vec2 p = vUv*2.0-1.0; float r = length(p);
        if (r > 1.0) discard;
        float rings = smoothstep(0.75, 1.0, sin((r*6.0 - uTime*3.0)*3.14159));
        float rim = smoothstep(0.86, 0.92, r) * smoothstep(1.0, 0.95, r);
        float core = smoothstep(0.35, 0.0, r);
        float a = (rings*0.6 + rim*1.6 + core*0.5) * (1.0 + uKick*2.0);
        gl_FragColor = vec4(uColor * 3.0 * a, a);
      }`,
  });
}

function shaftMaterial(color, strength = 0.07) {
  return new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(color) }, uTime: { value: 0 }, uStrength: { value: strength } },
    vertexShader: `varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      void main(){ vUv=uv; vec4 mv = modelViewMatrix*vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position=projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uStrength; varying vec2 vUv; varying vec3 vN; varying vec3 vV;
      ${NOISE_GLSL}
      void main(){
        float facing = pow(abs(dot(normalize(vN), normalize(vV))), 1.6);
        float fall = pow(vUv.y, 1.4);
        float n = 0.7 + 0.3*noise(vec2(vUv.x*12.0, vUv.y*3.0 + uTime*0.15));
        float a = facing * fall * n * uStrength;
        gl_FragColor = vec4(uColor * a, a);
      }`,
  });
}

function dustSystem(count, min, max, color) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    pos[i * 3] = min.x + Math.random() * (max.x - min.x);
    pos[i * 3 + 1] = min.y + Math.random() * (max.y - min.y);
    pos[i * 3 + 2] = min.z + Math.random() * (max.z - min.z);
    seed[i] = Math.random() * 100;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  g.boundingSphere = new THREE.Sphere(new THREE.Vector3().addVectors(min, max).multiplyScalar(0.5), min.distanceTo(max));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uMin: { value: min }, uMax: { value: max }, uScale: { value: 300 } },
    vertexShader: `attribute float seed; uniform float uTime; uniform vec3 uMin; uniform vec3 uMax; uniform float uScale; varying float vA;
      void main(){
        vec3 p = position;
        p.x += sin(uTime*0.13 + seed)*0.8; p.z += cos(uTime*0.11 + seed*1.3)*0.8;
        p.y = uMin.y + mod(p.y - uMin.y + uTime*(0.05 + fract(seed)*0.12), uMax.y - uMin.y);
        vec4 mv = modelViewMatrix*vec4(p,1.0);
        gl_PointSize = uScale * (0.02 + fract(seed*7.0)*0.025) / -mv.z;
        vA = 0.35 + 0.65*fract(seed*3.0);
        gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; varying float vA;
      void main(){ vec2 c = gl_PointCoord-0.5; float d = dot(c,c); if (d>0.25) discard; float a = (1.0 - d*4.0)*vA*0.5; gl_FragColor = vec4(uColor*a, a); }`,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  return pts;
}

function reactorParticles(count, radius, y0, y1, color) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(count * 3);
  const seed = new Float32Array(count);
  for (let i = 0; i < count; i++) {
    const a = Math.random() * Math.PI * 2, r = Math.sqrt(Math.random()) * radius;
    pos[i * 3] = Math.cos(a) * r; pos[i * 3 + 1] = y0 + Math.random() * (y1 - y0); pos[i * 3 + 2] = Math.sin(a) * r;
    seed[i] = Math.random() * 100;
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const m = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uColor: { value: new THREE.Color(color) }, uY0: { value: y0 }, uY1: { value: y1 } },
    vertexShader: `attribute float seed; uniform float uTime; uniform float uY0; uniform float uY1; varying float vA;
      void main(){ vec3 p = position; float h = uY1-uY0; float t = mod(p.y - uY0 + uTime*(0.8+fract(seed)*1.6), h);
        p.y = uY0 + t; float ang = uTime*0.4 + seed; p.xz = mat2(cos(ang*0.1), -sin(ang*0.1), sin(ang*0.1), cos(ang*0.1)) * p.xz;
        vA = sin(t/h*3.14159);
        vec4 mv = modelViewMatrix*vec4(p,1.0); gl_PointSize = (14.0 + fract(seed*9.0)*18.0) / -mv.z * 6.0; gl_Position = projectionMatrix*mv; }`,
    fragmentShader: `uniform vec3 uColor; varying float vA;
      void main(){ vec2 c = gl_PointCoord-0.5; float d = dot(c,c); if (d>0.25) discard; float a = (1.0-d*4.0)*vA; gl_FragColor = vec4(uColor*3.0*a, a); }`,
  });
  const p = new THREE.Points(g, m);
  p.frustumCulled = false;
  return p;
}

// ---------------------------------------------------------------------------
// Arena runtime
// ---------------------------------------------------------------------------
export class Arena {
  constructor(def) {
    this.id = def.id;
    this.name = def.name;
    this.group = null;
    this.world = null;
    this.spawns = [];
    this.pickups = [];
    this.pickupVisuals = new Map();
    this.barrels = [];
    this.glass = [];
    this.lamps = [];
    this.sparkBoxes = [];
    this.steamVents = [];
    this.interactables = [];
    this.animated = [];
    this.lights = [];
    this.flickerLights = [];
    this.scoreboards = [];
    this.jumpPadVisuals = [];
    this.shaderMats = [];
    this.time = 0;
    this.flyover = null;
    this.menuPath = null;
    this.targets = [];
    this.fog = null;
    this.clearColor = 0x020302;
  }

  addPickup(def, lib, detail) {
    def.id = this.pickups.length;
    def.pos = def.pos.clone ? def.pos : new THREE.Vector3(...def.pos);
    this.pickups.push(def);
    const v = new PickupVisual(def, lib, detail);
    this.group.add(v.root);
    this.pickupVisuals.set(def.id, v);
    return def;
  }

  setPickupAvailable(id, avail) {
    this.pickupVisuals.get(id)?.setAvailable(avail);
  }

  breakGlass(id) {
    const g = this.glass[id];
    if (!g || g.broken) return null;
    g.broken = true;
    g.collider.enabled = false;
    g.mesh.visible = false;
    return g;
  }

  setBarrel(id, alive) {
    const b = this.barrels[id];
    if (!b) return;
    b.alive = alive;
    b.collider.enabled = alive;
    b.mesh.visible = alive;
  }

  breakLamp(id) {
    const l = this.lamps[id];
    if (!l || l.broken) return null;
    l.broken = true;
    l.collider.enabled = false;
    l.mesh.material = l.offMat;
    return l;
  }

  resetProps() {
    for (const g of this.glass) { g.broken = false; g.collider.enabled = true; g.mesh.visible = true; }
    for (const b of this.barrels) this.setBarrel(b.id, true);
    for (const l of this.lamps) { l.broken = false; l.collider.enabled = true; l.mesh.material = l.onMat; }
    for (const p of this.pickups) this.setPickupAvailable(p.id, true);
  }

  setScore(a, b, timeText, names = ['PLAYER 1', 'PLAYER 2']) {
    const key = `${a}|${b}|${timeText}|${names.join()}`;
    if (key === this._scoreKey) return;
    this._scoreKey = key;
    for (const sb of this.scoreboards) drawScoreboard(sb, a, b, timeText, names);
  }

  /** Approximate incoming light at a point (for viewmodel tinting). */
  sampleLight(p, out) {
    out.setRGB(0.05, 0.06, 0.055);
    for (const l of this.lights) {
      if (!l.isPointLight || l.intensity <= 0) continue;
      const d2 = Math.max(1, l.position.distanceToSquared(p));
      const k = Math.min(1.2, (l.intensity * 0.6) / d2);
      out.r += l.color.r * k; out.g += l.color.g * k; out.b += l.color.b * k;
    }
    return out;
  }

  update(dt, t) {
    this.time = t;
    for (const m of this.shaderMats) if (m.uniforms.uTime) m.uniforms.uTime.value = t;
    for (const a of this.animated) a(dt, t);
    for (const v of this.pickupVisuals.values()) v.update(dt, t);
    for (const fl of this.flickerLights) {
      fl.timer -= dt;
      if (fl.timer <= 0) {
        fl.on = !fl.on || Math.random() < 0.3;
        fl.timer = fl.on ? 0.05 + Math.random() * (Math.random() < 0.15 ? 3 : 0.4) : 0.03 + Math.random() * 0.12;
        fl.light.intensity = fl.on ? fl.base : fl.base * 0.08;
        if (fl.mesh) fl.mesh.material = fl.on ? fl.onMat : fl.offMat;
      }
    }
    for (const jp of this.jumpPadVisuals) jp.mat.uniforms.uKick.value = Math.max(0, jp.mat.uniforms.uKick.value - dt * 3);
  }

  kickJumpPad(pad) {
    const v = this.jumpPadVisuals.find((j) => j.pad === pad);
    if (v) v.mat.uniforms.uKick.value = 1;
  }

  dispose() {
    this.group.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material && o.material.isShaderMaterial) o.material.dispose();
    });
  }
}

function drawScoreboard(sb, a, b, timeText, names) {
  const { ctx, canvas, tex } = sb;
  const w = canvas.width, h = canvas.height;
  ctx.fillStyle = '#030403';
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(125,255,26,0.5)';
  ctx.lineWidth = 4;
  ctx.strokeRect(8, 8, w - 16, h - 16);
  // LED grid texture
  ctx.fillStyle = 'rgba(255,255,255,0.025)';
  for (let y = 0; y < h; y += 6) ctx.fillRect(0, y, w, 2);
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${h * 0.13}px Teko, Rajdhani, Impact, sans-serif`;
  ctx.fillStyle = '#7dff1a';
  ctx.fillText(names[0].toUpperCase().slice(0, 14), w * 0.2, h * 0.24);
  ctx.fillStyle = '#ff8a1f';
  ctx.fillText(names[1].toUpperCase().slice(0, 14), w * 0.8, h * 0.24);
  ctx.font = `700 ${h * 0.5}px Teko, Rajdhani, Impact, sans-serif`;
  ctx.shadowBlur = 20;
  ctx.shadowColor = '#7dff1a';
  ctx.fillStyle = '#7dff1a';
  ctx.fillText(String(a).padStart(2, '0'), w * 0.2, h * 0.62);
  ctx.shadowColor = '#ff8a1f';
  ctx.fillStyle = '#ff8a1f';
  ctx.fillText(String(b).padStart(2, '0'), w * 0.8, h * 0.62);
  ctx.shadowBlur = 10;
  ctx.shadowColor = '#ffffff';
  ctx.fillStyle = '#f2f5f0';
  ctx.font = `600 ${h * 0.32}px Teko, Rajdhani, Impact, sans-serif`;
  ctx.fillText(timeText, w * 0.5, h * 0.5);
  ctx.shadowBlur = 0;
  drawXEmblem(ctx, w * 0.5, h * 0.82, h * 0.09, '#7dff1a', false);
  tex.needsUpdate = true;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------
export async function buildArena(mapId, lib, opts = {}) {
  if (mapId === 'training') return buildTraining(lib, opts);
  return buildBlackout(mapId, lib, opts);
}

function signPlane(tex, w, h, opts = {}) {
  const mat = opts.lit
    ? new THREE.MeshStandardMaterial({ map: tex, transparent: true, roughness: 0.8, metalness: 0, polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false })
    : new THREE.MeshBasicMaterial({ map: tex, transparent: true, color: new THREE.Color(0xffffff).multiplyScalar(opts.glow ?? 1.6), polygonOffset: true, polygonOffsetFactor: -2, depthWrite: false });
  const m = new THREE.Mesh(new THREE.PlaneGeometry(w, h), mat);
  if (opts.pos) m.position.set(...opts.pos);
  if (opts.rotY !== undefined) m.rotation.y = opts.rotY;
  m.renderOrder = 2;
  return m;
}

async function buildBlackout(mapId, lib, opts) {
  const lockdown = mapId === 'lockdown';
  const detail = opts.geometry || 'high';
  const lighting = opts.lighting || 'high';
  const effects = opts.effects || 'high';
  const B = new ArenaBuilder(lib, detail);
  const W = B.world;
  const M = lib.M;
  const arena = new Arena(MAPS[mapId] || MAPS.blackout);
  arena.group = B.group;
  arena.world = W;
  arena.fog = new THREE.FogExp2(lockdown ? 0x0c0303 : 0x030604, lockdown ? 0.03 : 0.0105);
  arena.clearColor = lockdown ? 0x050101 : 0x020302;
  const progress = opts.onProgress || (() => {});
  const yieldFrame = () => new Promise((r) => setTimeout(r, 0));

  M.neonP1 = M.neonP1 || neon(PALETTE.p1, 3.6);
  M.neonP2 = M.neonP2 || neon(PALETTE.p2, 3.4);
  const accentNeon = lockdown ? 'neonRed' : 'neonGreen';

  const X = 34, Z = 26, CEIL = 15;

  // ---------------- shell ----------------
  B.box(-X - 1, -0.6, -Z - 1, X + 1, CEIL + 1, -Z, 'wall');
  B.box(-X - 1, -0.6, Z, X + 1, CEIL + 1, Z + 1, 'wall');
  B.mbox(-X - 1, -0.6, -Z, -X, CEIL + 1, Z, 'wall');
  B.box(-X, CEIL, -Z, X, CEIL + 0.6, Z, 'darkMetal');
  // Kick plates + upper trim along the perimeter
  for (const s of [-1, 1]) {
    B.visualBox(-X, 0, s * Z - s * 0.04, X, 0.35, s * Z, 'hazard');
    B.visualBox(s * X - s * 0.04, 0, -Z, s * X, 0.35, Z, 'hazard');
    B.visualBox(-X, 9.6, s * Z - s * 0.06, X, 9.75, s * Z, accentNeon);
  }

  // ---------------- floors ----------------
  B.floor(-X, 12, X, Z, -0.6, 0, 'gravel', [[-2, 14, 2, 22]]);
  B.floor(-X, -Z, X, -12, -0.6, 0, 'concreteDark');
  B.floor(-X, -12, -24, 12, -0.6, 0, 'plate');
  B.floor(24, -12, X, 12, -0.6, 0, 'plate');
  B.floor(-24, -12, 24, 12, -0.6, 0, 'concrete', [[-20, -2, -12, 2], [12, -2, 20, 2], [-6, -6, 6, 6]]);
  B.box(-6, -0.18, -6, 6, 0, 6, 'grate', { surface: 'grate' });
  // Hazard frame around the reactor grate
  for (const s of [-1, 1]) {
    B.visualBox(-6.3, 0, s * 6 - 0.3, 6.3, 0.015, s * 6 + 0.0, 'hazard');
    B.visualBox(s * 6 - 0.3, 0, -6, s * 6, 0.015, 6, 'hazard');
  }
  await yieldFrame(); progress(0.15);

  // ---------------- underground ----------------
  const T = -4;
  // West/east tunnel ramps (top at x=±20 ground level, bottom at x=±12)
  B.ramp([-20, T, -2], [-12, 0, 2], 'x', -1, 'concrete');
  B.ramp([12, T, -2], [20, 0, 2], 'x', 1, 'concrete');
  B.mbox(-12, T - 0.6, -2, -7, T, 2, 'concrete');
  B.box(-7, T - 0.6, -7, 7, T, 7, 'plate');
  B.box(-2, T - 0.6, 7, 2, T, 14, 'concrete');
  B.ramp([-2, T, 14], [2, 0, 22], 'z', 1, 'concrete');
  // tunnel walls
  B.mbox(-20, T - 0.6, -2.4, -7, 0, -2, 'wall');
  B.mbox(-20, T - 0.6, 2, -7, 0, 2.4, 'wall');
  // chamber walls
  B.mwall('z', -7.4, 7.4, -7.4, -7, T - 0.6, -0.6, 'wall', [{ a0: -2, a1: 2, y0: T, y1: -0.6 }]);
  B.box(-7.4, T - 0.6, -7.4, 7.4, -0.6, -7, 'wall');
  B.wall('x', -7.4, 7.4, 7, 7.4, T - 0.6, -0.6, 'wall', [{ a0: -2, a1: 2, y0: T, y1: -0.6 }]);
  // north tunnel walls (west wall has the secret crawlspace)
  B.wall('z', 7.4, 22, -2.4, -2, T - 0.6, 0, 'wall', [{ a0: 10, a1: 11.2, y0: T, y1: T + 1.25 }]);
  B.box(2, T - 0.6, 7.4, 2.4, 0, 22, 'wall');
  // tunnel neon strips + chamber trims
  B.mbox(-19.5, T + 2.6, -1.98, -7.2, T + 2.66, -1.95, accentNeon, { noCollide: true });
  B.mbox(-19.5, T + 2.6, 1.95, -7.2, T + 2.66, 1.98, accentNeon, { noCollide: true });
  B.visualBox(-1.98, T + 2.6, 7.6, -1.95, T + 2.66, 21.5, accentNeon);
  B.visualBox(1.95, T + 2.6, 7.6, 1.98, T + 2.66, 21.5, accentNeon);
  for (const s of [-1, 1]) {
    B.visualBox(-6.98, T + 0.02, s * 6.95 - (s > 0 ? 0.03 : -0.03), 6.98, T + 0.1, s * 6.95, 'hazard');
  }
  // chamber pipes along walls
  if (detail !== 'low') {
    for (const s of [-1, 1]) {
      B.pipe('z', -6.6, 6.6, s * 6.6, T + 3.1, 0.18, 'pipeGreen', { flanges: 3 });
      B.pipe('z', -6.6, 6.6, s * 6.75, T + 2.6, 0.12, 'pipe', {});
      B.pipe('x', -6.6, -2.3, -6.7, T + 3.0, 0.16, 'pipe', { flanges: 2 });
      B.pipe('x', 2.3, 6.6, -6.7, T + 3.0, 0.16, 'pipe', { flanges: 2 });
    }
  }
  // pit rails at ground level
  B.mrailing(-20, -2.15, -12, -2.15, 0, {});
  B.mrailing(-20, 2.15, -12, 2.15, 0, {});
  B.mrailing(-11.9, -2.1, -11.9, 2.1, 0, {});
  B.railing(-2.15, 14, -2.15, 22, 0, {});
  B.railing(2.15, 14, 2.15, 22, 0, {});
  B.railing(-2.1, 14.05, 2.1, 14.05, 0, {});

  // Secret room (behind the breakable vent in the north tunnel)
  B.box(-6.8, T - 0.6, 8.1, -2.4, T, 12.9, 'plate');
  B.box(-6.8, T - 0.6, 8.1, -6.4, -0.6, 12.9, 'wall');
  B.box(-6.8, T - 0.6, 8.1, -2.4, -0.6, 8.5, 'wall');
  B.box(-6.8, T - 0.6, 12.5, -2.4, -0.6, 12.9, 'wall');
  B.box(-6.8, T + 2.6, 8.1, -2.4, -0.6, 12.9, 'darkMetal');
  await yieldFrame(); progress(0.3);

  // ---------------- bases ----------------
  const DOOR = 3.2, UP = 4.5;
  B.mwall('z', -12, 12, -24.5, -24, 0, 4.3, 'wall', [
    { a0: -7, a1: -4, y0: 0, y1: DOOR }, { a0: -1.6, a1: 1.6, y0: 1.1, y1: 3.0 }, { a0: 4, a1: 7, y0: 0, y1: DOOR },
  ]);
  B.mwall('x', -34, -24.5, 11.6, 12, 0, 4.3, 'wall', [{ a0: -31, a1: -27, y0: 0, y1: DOOR }]);
  B.mwall('x', -34, -24.5, -12, -11.6, 0, 4.3, 'wall', [{ a0: -31, a1: -27, y0: 0, y1: DOOR }]);
  // upper floor slab with stair hole
  B.floor(-34, -12, -24, 12, 4.3, UP, 'plate', [[-33.8, -3.8, -31.6, 4.4]]);
  B.floor(24, -12, 34, 12, 4.3, UP, 'plate', [[31.6, -3.8, 33.8, 4.4]]);
  B.stairs('z', 4.2, -3.8, -33.8, -31.6, 0, UP, 'plate', { mirror: true });
  B.mrailing(-31.55, -3.6, -31.55, 4.4, UP, {});
  B.mrailing(-33.8, 4.45, -31.6, 4.45, UP, {});
  // upper room walls & roof
  B.mwall('z', -12, 12, -24.5, -24, UP, 8.8, 'wall', [{ a0: -4, a1: 4, y0: UP, y1: 7.7 }]);
  B.mwall('x', -34, -24.5, 11.6, 12, UP, 8.8, 'wall', [{ a0: -31, a1: -27, y0: UP, y1: 7.7 }]);
  B.mwall('x', -34, -24.5, -12, -11.6, UP, 8.8, 'wall', [{ a0: -31, a1: -27, y0: UP, y1: 7.7 }]);
  B.mbox(-34, 8.8, -12, -24, 9.1, 12, 'darkMetal');
  // balcony + bridge to the reactor ring
  B.mbox(-24, 4.3, -4, -20.5, UP, 4, 'grate');
  B.mrailing(-24, 4, -20.5, 4, UP, {});
  B.mrailing(-24, -4, -20.5, -4, UP, {});
  B.mrailing(-20.5, -4, -20.5, -1.25, UP, {});
  B.mrailing(-20.5, 1.25, -20.5, 4, UP, {});
  B.mbox(-20.5, 4.3, -1.25, -7.5, UP, 1.25, 'grate');
  B.mrailing(-20.5, -1.3, -7.5, -1.3, UP, {});
  B.mrailing(-20.5, 1.3, -7.5, 1.3, UP, {});
  // bridge supports
  for (const z of [-2.95, 2.6]) B.mbox(-16.2, 0, z, -15.85, 4.3, z + 0.35, 'darkMetal');
  B.mbox(-16.2, 3.9, -2.95, -15.85, 4.3, 2.95, 'darkMetal');
  for (const z of [-1.4, 1.05]) B.mbox(-9.35, 0, z, -9.0, 4.3, z + 0.35, 'darkMetal');
  // base interior details: team neon, lockers, benches, sector signs
  for (const s of [-1, 1]) {
    const neonKey = s < 0 ? 'neonP1' : 'neonP2';
    const xi = s * 24.55, xo = s * 33.9;
    B.visualBox(Math.min(xi, xo), 4.12, s < 0 ? 11.5 : 11.5, Math.max(xi, xo), 4.2, 11.55, neonKey);
    B.visualBox(Math.min(xi, xo), 4.12, -11.55, Math.max(xi, xo), 4.2, -11.5, neonKey);
    B.visualBox(Math.min(s * 24.6, s * 24.55), 0.4, -11.5, Math.max(s * 24.6, s * 24.55), 0.46, 11.5, neonKey);
    B.visualBox(Math.min(xi, xo), 8.6, -11.5, Math.max(xi, xo), 8.68, -11.45, neonKey);
    B.visualBox(Math.min(xi, xo), 8.6, 11.45, Math.max(xi, xo), 8.68, 11.5, neonKey);
    // lockers
    for (let i = 0; i < 6; i++) {
      const x = s * (25.2 + i * 0.75);
      B.box(Math.min(x, x + s * 0.7), 0, 10.9, Math.max(x, x + s * 0.7), 2.1, 11.6, 'machine', { surface: 'metal' });
    }
    // benches
    B.box(Math.min(s * 27, s * 30), 0, -2.6, Math.max(s * 27, s * 30), 0.48, -2.0, 'darkMetal');
    // sector sign on the facade
    const sign = signPlane(s < 0 ? lib.signs.sectorA : lib.signs.sectorB, 2.4, 2.4, { pos: [s * 23.94, 6.3, 6], rotY: s < 0 ? Math.PI / 2 : -Math.PI / 2, glow: 1.4 });
    B.mesh(sign);
    const logo = signPlane(lib.signs.logo, 5.2, 1.95, { pos: [s * 23.94, 6.4, -7.5], rotY: s < 0 ? Math.PI / 2 : -Math.PI / 2, glow: 2.2 });
    B.mesh(logo);
  }
  await yieldFrame(); progress(0.42);

  // ---------------- north catwalk + yard ----------------
  B.mbox(-31, 4.3, 12, -27, UP, 22.5, 'grate');
  B.mrailing(-31.05, 12, -31.05, 22.5, UP, {});
  B.mrailing(-26.95, 12, -26.95, 22.5, UP, {});
  B.box(-31, 4.3, 22.5, 31, UP, 25.5, 'grate');
  for (const [a, b] of [[-27, -16.5], [-11.5, -7.6], [-4.4, 4.4]]) {
    B.railing(a, 22.45, b, 22.45, UP, {});
    if (Math.abs(a + b) > 1e-6) B.railing(-b, 22.45, -a, 22.45, UP, {});
  }
  // catwalk supports
  for (const x of [-24, -16, -8, 0, 8, 16, 24]) B.box(x - 0.15, 0, 22.55, x + 0.15, 4.3, 22.85, 'darkMetal');
  // divider wall (4 gaps)
  B.wall('x', -24, 24, 12, 12.6, 0, 4.3, 'wall', [
    { a0: -19, a1: -15, y0: 0, y1: 4.3 }, { a0: -9, a1: -5, y0: 0, y1: 4.3 },
    { a0: 5, a1: 9, y0: 0, y1: 4.3 }, { a0: 15, a1: 19, y0: 0, y1: 4.3 },
  ]);
  B.visualBox(-24, 4.3, 11.95, 24, 4.42, 12.65, 'hazard');
  // containers
  B.mbox(-24, 0, 15.4, -18, 2.6, 17.8, 'container', { surface: 'metal' });
  B.mbox(-23.5, 2.6, 15.4, -17.5, 5.2, 17.8, 'containerGreen', { surface: 'metal' });
  B.mbox(-17, 0, 20, -11, 2.6, 22.4, 'containerOrange', { surface: 'metal' });
  B.mbox(-11.4, 0, 18.0, -10.1, 1.3, 19.3, 'darkMetal', { surface: 'metal' });
  B.mbox(-14.6, 0, 13.4, -13.4, 1.2, 14.6, 'darkMetal', { surface: 'metal' });
  // broken generator under the link catwalk
  B.mbox(-29.6, 0, 18.6, -26.2, 2.2, 22.2, 'machine', { surface: 'metal' });
  B.mbox(-29.4, 2.2, 19.0, -26.4, 2.5, 21.8, 'darkMetal', { surface: 'metal' });
  await yieldFrame(); progress(0.5);

  // ---------------- atrium ----------------
  // reactor ring catwalk
  B.box(-7.5, 4.3, 4.6, 7.5, UP, 7.5, 'grate');
  B.box(-7.5, 4.3, -7.5, 7.5, UP, -4.6, 'grate');
  B.mbox(-7.5, 4.3, -4.6, -4.6, UP, 4.6, 'grate');
  // ring railings (outer)
  B.mrailing(-7.5, 7.55, -6.7, 7.55, UP, {});
  B.railing(-4.3, 7.55, 4.3, 7.55, UP, {});
  B.mrailing(-7.5, -7.55, -1.25, -7.55, UP, {});
  B.mrailing(-7.55, -7.5, -7.55, -1.25, UP, {});
  B.mrailing(-7.55, 1.25, -7.55, 7.5, UP, {});
  // inner railings around the reactor gap
  B.railing(-4.6, 4.55, 4.6, 4.55, UP, {});
  B.railing(-4.6, -4.55, 4.6, -4.55, UP, {});
  B.mrailing(-4.55, -4.6, -4.55, 4.6, UP, {});
  // south bridge to gallery walkway
  B.box(-1.25, 4.3, -12, 1.25, UP, -7.5, 'grate');
  B.mrailing(-1.3, -12, -1.3, -7.6, UP, {});
  // ring support columns
  for (const [x, z] of [[-7.3, -7.3], [-7.3, 7.0], [7.0, -7.3], [7.0, 7.0]]) B.box(x, 0, z, x + 0.3, 4.3, z + 0.3, 'darkMetal');
  // low walls (mantle height)
  B.mbox(-11, 0, 3.5, -10.5, 1.1, 7.5, 'concrete');
  B.mbox(-11, 0, -7.5, -10.5, 1.1, -3.5, 'concrete');
  B.mbox(-11.02, 1.1, 3.5, -10.48, 1.16, 7.5, 'hazard', { noCollide: true });
  B.mbox(-11.02, 1.1, -7.5, -10.48, 1.16, -3.5, 'hazard', { noCollide: true });
  // containers & crates
  B.mbox(-21, 0, 7.4, -15, 2.6, 9.8, 'container', { surface: 'metal' });
  B.mbox(-21, 0, -9.8, -15, 2.6, -7.4, 'containerWhite', { surface: 'metal' });
  B.mbox(-13.6, 0, 9.2, -12.4, 1.2, 10.4, 'darkMetal', { surface: 'metal' });
  B.mbox(-14.2, 0, -6.8, -13.0, 1.2, -5.6, 'darkMetal', { surface: 'metal' });
  B.mbox(-7.2, 0, 10.2, -6.2, 1.0, 11.2, 'darkMetal', { surface: 'metal' });
  B.mbox(-7.1, 1.0, 10.3, -6.3, 1.8, 11.1, 'darkMetal', { surface: 'metal' });
  await yieldFrame(); progress(0.58);

  // ---------------- gallery ----------------
  B.wall('x', -24, 24, -12.6, -12, 0, 4.3, 'wall', [
    { a0: -19, a1: -15, y0: 0, y1: 3.3 }, { a0: -11, a1: -6, y0: 1.2, y1: 3.1, glass: true },
    { a0: -2.2, a1: 2.2, y0: 0, y1: 3.3 }, { a0: 6, a1: 11, y0: 1.2, y1: 3.1, glass: true }, { a0: 15, a1: 19, y0: 0, y1: 3.3 },
  ]);
  B.box(-31, 4.3, -15, 31, UP, -12, 'plate');
  B.mrailing(-24, -11.95, -1.25, -11.95, UP, {});
  B.mrailing(-31, -15.05, -21, -15.05, UP, {});
  B.railing(-11, -15.05, 11, -15.05, UP, {});
  // control rooms
  for (const s of [-1, 1]) {
    const x0 = s < 0 ? -21 : 11, x1 = s < 0 ? -11 : 21;
    const mx = (v) => s * v; // helper for mirrored x
    B.wall('x', x0, x1, -15.35, -15, 0, 4.3, 'wall', s < 0
      ? [{ a0: -18, a1: -15.5, y0: 0, y1: DOOR }, { a0: -14.5, a1: -11.8, y0: 1.2, y1: 3.0 }]
      : [{ a0: 11.8, a1: 14.5, y0: 1.2, y1: 3.0 }, { a0: 15.5, a1: 18, y0: 0, y1: DOOR }]);
    B.wall('x', x0, x1, -21, -20.65, 0, 4.3, 'wall', s < 0 ? [{ a0: -15, a1: -12.5, y0: 0, y1: DOOR }] : [{ a0: 12.5, a1: 15, y0: 0, y1: DOOR }]);
    B.wall('z', -21, -15, Math.min(mx(21), mx(20.65)), Math.max(mx(21), mx(20.65)), 0, 4.3, 'wall', [{ a0: -19, a1: -17, y0: 0, y1: DOOR }]);
    B.wall('z', -21, -15, Math.min(mx(11), mx(11.35)), Math.max(mx(11), mx(11.35)), 0, 4.3, 'wall', [{ a0: -20, a1: -16, y0: 1.2, y1: 3.0 }]);
    B.box(x0, 4.3, -21, x1, UP, -15, 'plate');
    // consoles
    B.box(Math.min(mx(20.5), mx(17.5)), 0, -20.6, Math.max(mx(20.5), mx(17.5)), 0.95, -19.9, 'machine');
    B.box(Math.min(mx(14), mx(11.5)), 0, -16.0, Math.max(mx(14), mx(11.5)), 0.95, -15.4, 'machine');
    B.visualBox(Math.min(mx(20.4), mx(17.6)), 0.95, -20.55, Math.max(mx(20.4), mx(17.6)), 0.97, -19.95, accentNeon);
  }
  B.mrailing(-21.05, -21, -21.05, -15, UP, {});
  B.mrailing(-21, -21.05, -11, -21.05, UP, {});
  B.mrailing(-10.95, -19.4, -10.95, -15.1, UP, {});
  // sniper platform + stairs
  B.box(-5, 7.8, -26, 5, 8.0, -19, 'plate');
  for (const [x, z] of [[-4.75, -19.5], [4.4, -19.5], [-4.75, -25.9], [4.4, -25.9]]) B.box(x, 0, z, x + 0.35, 7.8, z + 0.35, 'darkMetal');
  B.railing(-5, -18.95, 5, -18.95, 8.0, {});
  B.mrailing(-5.05, -26, -5.05, -21.1, 8.0, {});
  B.stairs('x', -11, -5, -21, -19.5, UP, 8.0, 'plate', { mirror: true, base: 4.3, steps: 12 });
  B.mbox(-11, 4.0, -21, -5, 4.3, -19.5, 'darkMetal', { noCollide: true });
  // machinery under the platform
  B.box(-3.5, 0, -25.6, 3.5, 2.4, -22, 'machine', { surface: 'metal' });
  B.box(-3.2, 2.4, -25.3, 3.2, 2.6, -22.3, 'darkMetal');
  B.visualBox(-3.52, 1.2, -22.02, 3.52, 1.3, -21.98, accentNeon);
  // gallery cover
  B.mbox(-27.6, 0, -18.6, -26.4, 1.2, -17.4, 'darkMetal', { surface: 'metal' });
  B.mbox(-9.2, 0, -24.8, -7.8, 1.4, -23.4, 'darkMetal', { surface: 'metal' });
  B.mbox(-30, 0, -25.7, -24, 2.6, -23.3, 'containerGreen', { surface: 'metal' });
  if (detail !== 'low') {
    B.pipe('x', -33.9, 33.9, 5.6, -25.5, 0.35, 'pipeGreen', { flanges: 6 });
    B.pipe('x', -33.9, 33.9, 6.5, -25.6, 0.22, 'pipe', { flanges: 8 });
    for (const [a, b] of [[-33.9, -5.6], [5.6, 33.9]]) {
      B.pipe('x', a, b, 11.5, -25.4, 0.3, 'pipeWhite', { flanges: 4 });
      B.pipe('x', a, b, 11.0, 25.4, 0.4, 'pipeGreen', { flanges: 3 });
      B.pipe('x', a, b, 12.0, 25.5, 0.25, 'pipe', { flanges: 4 });
    }
    for (const x of [-30, -12, 12, 30]) B.pipe('y', 0, 15, x, -25.6, 0.16, 'pipe', {});
  }
  await yieldFrame(); progress(0.66);

  // ---------------- reactor (X-CORE) ----------------
  const RX = 3.4;
  W.addCylinder(0, 0, RX, T - 0.6, 9.2, { surface: 'metal' });
  B.box(-4.5, 9.2, -4.5, 4.5, 9.5, 4.5, 'plate');
  for (const s of [-1, 1]) {
    B.visualBox(-4.5, 9.5, s * 4.5 - (s > 0 ? 0.25 : -0.25), 4.5, 9.52, s * 4.5, 'hazard');
    B.visualBox(s * 4.5 - (s > 0 ? 0.25 : -0.25), 9.5, -4.5, s * 4.5, 9.52, 4.5, 'hazard');
    B.visualBox(-4.5, 9.2, s * 4.5 - (s > 0 ? 0.04 : -0.04), 4.5, 9.3, s * 4.5, accentNeon);
  }
  B.cylinder(0, 0, 2.6, 12.6, CEIL, 'machine', {});
  B.cylinder(0, 0, 3.0, 12.4, 12.8, 'darkMetal', { noCollide: true });
  B.cylinder(0, 0, 3.9, T, T + 0.6, 'darkMetal', { noCollide: true });
  B.cylinder(0, 0, 3.75, -0.2, 0.3, 'darkMetal', { noCollide: true });
  B.cylinder(0, 0, 3.6, 8.6, 9.2, 'darkMetal', { noCollide: true });
  const reactor = new THREE.Group();
  const coreMat = reactorCoreMaterial(lockdown ? 0xff3a10 : PALETTE.acid);
  arena.shaderMats.push(coreMat);
  const core = new THREE.Mesh(new THREE.CylinderGeometry(2.55, 2.55, 13.2 + 0.4, B.segs * 2, 1, true), coreMat);
  core.position.y = (T + 9.2) / 2;
  reactor.add(core);
  const glass = new THREE.Mesh(new THREE.CylinderGeometry(3.3, 3.3, 13.2, B.segs * 2, 1, true), M.reactorGlass);
  glass.position.y = (T + 9.2) / 2;
  glass.renderOrder = 3;
  reactor.add(glass);
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    const rib = new THREE.BoxGeometry(0.22, 13.2, 0.3);
    rib.rotateY(-a);
    rib.translate(Math.cos(a) * 3.38, (T + 9.2) / 2, Math.sin(a) * 3.38);
    B.geo(rib, 'darkMetal');
  }
  for (const y of [T + 0.7, -0.4, 2.2, 4.4, 6.7, 8.5]) {
    const tg = new THREE.TorusGeometry(3.4, 0.11, 8, B.segs * 2);
    tg.rotateX(Math.PI / 2);
    tg.translate(0, y, 0);
    B.geo(tg, 'trim');
  }
  const ringMat = neon(lockdown ? PALETTE.warnRed : PALETTE.acid, 3);
  const innerRings = [];
  for (let i = 0; i < 3; i++) {
    const r = new THREE.Mesh(new THREE.TorusGeometry(2.95, 0.05, 6, 64), ringMat);
    r.position.y = 0.8 + i * 3.1;
    r.rotation.x = Math.PI / 2;
    reactor.add(r);
    innerRings.push(r);
  }
  if (effects !== 'low') reactor.add(reactorParticles(effects === 'high' ? 360 : 180, 2.4, T, 9.2, lockdown ? 0xff4a20 : PALETTE.acid));
  for (const c of reactor.children) if (c.material?.isShaderMaterial && !arena.shaderMats.includes(c.material)) arena.shaderMats.push(c.material);
  // Electrical arcs between core and frame
  const arcCount = 6, arcSegs = 10;
  const arcGeo = new THREE.BufferGeometry();
  arcGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(arcCount * arcSegs * 2 * 3), 3));
  const arcMat = new THREE.LineBasicMaterial({ color: new THREE.Color(lockdown ? 0xff7050 : 0xc8ff90).multiplyScalar(4), transparent: true, blending: THREE.AdditiveBlending, depthWrite: false });
  const arcs = new THREE.LineSegments(arcGeo, arcMat);
  arcs.frustumCulled = false;
  reactor.add(arcs);
  let arcTimer = 0;
  const regenArcs = () => {
    const p = arcGeo.attributes.position.array;
    let k = 0;
    for (let a = 0; a < arcCount; a++) {
      const on = Math.random() < 0.55;
      const ang = Math.random() * Math.PI * 2;
      const y = T + 1 + Math.random() * 11;
      const ang2 = ang + (Math.random() - 0.5) * 0.6;
      const y2 = y + (Math.random() - 0.5) * 2;
      let px = Math.cos(ang) * 2.6, py = y, pz = Math.sin(ang) * 2.6;
      for (let s = 0; s < arcSegs; s++) {
        const t = (s + 1) / arcSegs;
        const r = 2.6 + 0.72 * t;
        const aa = ang + (ang2 - ang) * t;
        const jitter = s === arcSegs - 1 ? 0 : 0.18;
        const nx = Math.cos(aa) * r + (Math.random() - 0.5) * jitter;
        const ny = y + (y2 - y) * t + (Math.random() - 0.5) * jitter * 2;
        const nz = Math.sin(aa) * r + (Math.random() - 0.5) * jitter;
        if (on) { p[k++] = px; p[k++] = py; p[k++] = pz; p[k++] = nx; p[k++] = ny; p[k++] = nz; }
        else { for (let q = 0; q < 6; q++) p[k++] = 0; }
        px = nx; py = ny; pz = nz;
      }
    }
    arcGeo.attributes.position.needsUpdate = true;
  };
  regenArcs();
  B.mesh(reactor);
  arena.reactor = { core, coreMat, rings: innerRings };

  // Reactor top crown pistons (moving mechanical elements)
  const pistons = [];
  if (detail !== 'low') {
    for (let i = 0; i < 4; i++) {
      const a = Math.PI / 4 + (i * Math.PI) / 2;
      const g = new THREE.Group();
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1.4, 12), M.darkMetal);
      sleeve.position.y = 0.7;
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.14, 1.6, 10), M.trim);
      rod.position.y = -0.2;
      g.add(sleeve, rod);
      g.position.set(Math.cos(a) * 3.1, 13.4, Math.sin(a) * 3.1);
      B.mesh(g);
      pistons.push({ rod, phase: i * 1.3 });
    }
  }
  await yieldFrame(); progress(0.72);

  // ---------------- jump pads ----------------
  const pads = [
    { pos: [-5.5, 0, 9.6], vel: [0, 15, -3.2] }, { pos: [5.5, 0, 9.6], vel: [0, 15, -3.2] },
    { pos: [-2.5, UP, 6.4], vel: [0, 15.5, -3.2] }, { pos: [2.5, UP, 6.4], vel: [0, 15.5, -3.2] },
    { pos: [-6.5, 0, 18.2], vel: [0, 14.5, 5.6] }, { pos: [6.5, 0, 18.2], vel: [0, 14.5, 5.6] },
  ];
  for (const p of pads) addJumpPad(arena, B, p.pos, p.vel, lockdown ? PALETTE.warnOrange : PALETTE.acid);

  // ---------------- breakable glass ----------------
  const glassPanes = [
    // base atrium windows
    [-24.45, 1.1, -1.6, -24.05, 3.0, 1.6], [24.05, 1.1, -1.6, 24.45, 3.0, 1.6],
    // gallery divider windows
    [-11, 1.2, -12.45, -6, 3.1, -12.15], [6, 1.2, -12.45, 11, 3.1, -12.15],
    // control room windows
    [-14.5, 1.2, -15.3, -11.8, 3.0, -15.05], [11.8, 1.2, -15.3, 14.5, 3.0, -15.05],
    [-11.3, 1.2, -20, -11.05, 3.0, -16], [11.05, 1.2, -20, 11.3, 3.0, -16],
  ];
  for (const g of glassPanes) addGlass(arena, B, g, M.glass);
  // secret room vent grille (breakable)
  addGlass(arena, B, [-2.38, T, 10, -2.02, T + 1.25, 11.2], new THREE.MeshStandardMaterial({ color: 0x3a3f42, metalness: 0.9, roughness: 0.4, alphaMap: lib.sets.grate.alphaMap, alphaTest: 0.5, side: THREE.DoubleSide }), true);

  // ---------------- energy barrels ----------------
  const barrelSpots = [
    [-12.4, 11.2], [12.4, 11.2], [-22.3, -10.8], [22.3, -10.8], [-21.2, 20.6], [21.2, 20.6], [-20.3, 21.7], [20.3, 21.7],
    [-8, 25], [8, 25], [-7, -13.4], [7, -13.4], [-31.5, -24.6], [31.5, -24.6],
  ];
  for (const [x, z] of barrelSpots) addBarrel(arena, B, x, 0, z, lib);

  // ---------------- breakable tunnel lamps ----------------
  const lampSpots = [];
  for (const s of [-1, 1]) for (const x of [9, 15]) lampSpots.push([s * x, T + 2.9, -1.92, 0], [s * x, T + 2.9, 1.92, Math.PI]);
  for (const z of [10, 17]) lampSpots.push([1.92, T + 2.9, z, -Math.PI / 2]);
  for (const l of lampSpots) addLamp(arena, B, ...l);

  await yieldFrame(); progress(0.78);

  // ---------------- signs, graffiti, holograms, screens ----------------
  B.mesh(signPlane(lib.signs.facility, 12, 3, { pos: [0, 7.4, 25.94], rotY: Math.PI, glow: 1.5 }));
  B.mesh(signPlane(lib.signs.reactor, 9, 1.4, { pos: [0, 2.5, -12.62], rotY: Math.PI, glow: 1.4 }));
  B.mesh(signPlane(lib.signs.reactor, 9, 1.4, { pos: [0, 2.5, -11.98], rotY: 0, glow: 1.4 }));
  B.mesh(signPlane(lib.signs.arrowUp, 3.2, 0.8, { pos: [-20.1, 3.4, 2.43], rotY: 0, glow: 1.4 }));
  B.mesh(signPlane(lib.signs.arrowUp, 3.2, 0.8, { pos: [20.1, 3.4, 2.43], rotY: 0, glow: 1.4 }));
  B.mesh(signPlane(lib.signs.voltage, 1.6, 0.8, { pos: [-6.95, T + 1.9, 4.5], rotY: Math.PI / 2, glow: 1.2 }));
  B.mesh(signPlane(lib.signs.voltage, 1.6, 0.8, { pos: [6.95, T + 1.9, 4.5], rotY: -Math.PI / 2, glow: 1.2 }));
  B.mesh(signPlane(lib.signs.voltage, 1.6, 0.8, { pos: [0, 1.6, -21.97], rotY: 0, glow: 1.2 }));
  const graffiti = [
    ['noExcuses', 7, 2.6, [-12, 2.2, 12.62], 0], ['oneVone', 5, 2.5, [12, 2.0, 12.62], 0],
    ['rush', 4.6, 2.3, [-17.5, 1.9, -12.62], Math.PI], ['blackout', 7, 2.6, [33.95, 3.0, -18], -Math.PI / 2],
    ['xmark', 2.6, 2.6, [-33.95, 2.8, 19], Math.PI / 2], ['gg', 4, 2, [17.5, 1.9, -12.62], Math.PI],
    ['noExcuses', 6, 2.2, [0, 1.8, -25.95], 0], ['xmark', 1.6, 1.6, [-1.9, T + 1.4, 18], Math.PI / 2],
    ['devs', 3.6, 1.35, [-6.38, T + 1.5, 10.5], Math.PI / 2], ['secret', 2.6, 1.3, [-4.4, T + 1.5, 12.48], Math.PI],
  ];
  for (const [k, w, h, pos, ry] of graffiti) B.mesh(signPlane(lib.graffiti[k], w, h, { pos, rotY: ry, lit: true }));

  const holoMats = [];
  const holo = (tex, w, h, pos, ry, color) => {
    const m = hologramMaterial(tex, color);
    holoMats.push(m);
    arena.shaderMats.push(m);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h), m);
    mesh.position.set(...pos);
    mesh.rotation.y = ry;
    mesh.renderOrder = 4;
    B.mesh(mesh);
    // projector base
    const pb = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 0.25, 16), M.darkMetal);
    pb.position.set(pos[0], pos[1] - h / 2 - 0.2, pos[2]);
    B.mesh(pb);
    return mesh;
  };
  const holoA = holo(lib.signs.holoAd, 4, 6, [0, 7.6, 18.6], 0, lockdown ? PALETTE.warnOrange : PALETTE.acid);
  const holoB = holo(lib.signs.holoAd2, 8, 4, [0, 12.2, -19], 0, PALETTE.acid);
  const holoC = holo(lib.signs.holoAd, 2.6, 3.9, [-32.6, 2.4, -19], Math.PI / 2, PALETTE.p2);
  const holoD = holo(lib.signs.holoAd, 2.6, 3.9, [32.6, 2.4, -19], -Math.PI / 2, PALETTE.p2);
  void holoC; void holoD;
  arena.animated.push((dt, t) => {
    holoA.rotation.y = Math.sin(t * 0.25) * 0.5;
    holoB.position.y = 12.2 + Math.sin(t * 0.7) * 0.15;
  });

  // digital scoreboards (live score)
  for (const [pos, ry] of [[[0, 10.6, 25.9], Math.PI], [[0, 12.0, -25.9], 0], [[-33.9, 12.0, 0], Math.PI / 2], [[33.9, 12.0, 0], -Math.PI / 2]]) {
    const c = document.createElement('canvas');
    c.width = 1024; c.height = 320;
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(9, 2.8), new THREE.MeshBasicMaterial({ map: tex, color: new THREE.Color(1.8, 1.8, 1.8) }));
    mesh.position.set(...pos);
    mesh.rotation.y = ry;
    const frame = new THREE.Mesh(new THREE.BoxGeometry(9.4, 3.2, 0.3), M.darkMetal);
    frame.position.copy(mesh.position);
    frame.rotation.y = ry;
    frame.translateZ(-0.17);
    B.mesh(frame);
    B.mesh(mesh);
    const sb = { canvas: c, ctx: c.getContext('2d'), tex, mesh };
    arena.scoreboards.push(sb);
    drawScoreboard(sb, 0, 0, '08:00', ['PLAYER 1', 'PLAYER 2']);
  }

  // vending machines (interactable easter egg) + arcade machine
  for (const s of [-1, 1]) {
    const vm = buildVending(lib, M);
    vm.position.set(s * 25.05, 0, -9.6);
    vm.rotation.y = s < 0 ? -Math.PI / 2 : Math.PI / 2;
    B.mesh(vm);
    W.addBox([Math.min(s * 24.5, s * 25.6), 0, -10.2], [Math.max(s * 24.5, s * 25.6), 2.1, -9.0], { surface: 'metal' });
    arena.interactables.push({ pos: new THREE.Vector3(s * 26.0, 1, -9.6), radius: 1.8, kind: 'vending', label: 'GRAB A MONSTER-X' });
  }
  const arcade = buildArcade(lib, M);
  arcade.position.set(-5.7, T, 11.6);
  arcade.rotation.y = Math.PI * 0.75;
  B.mesh(arcade);
  W.addBox([-6.3, T, 11.1], [-5.1, T + 1.7, 12.2], { surface: 'metal' });
  arena.interactables.push({ pos: new THREE.Vector3(-5.2, T + 1, 11.0), radius: 1.8, kind: 'arcade', label: 'PLAY X-RACER 86' });
  // hidden golden helmet on a pedestal
  const helmet = buildHiddenHelmet();
  helmet.position.set(-3.4, T + 1.05, 8.9);
  B.mesh(helmet);
  B.box(-3.8, T, 8.6, -3.0, T + 0.8, 9.4, 'machine');
  arena.animated.push((dt) => { helmet.rotation.y += dt * 0.6; });
  arena.interactables.push({ pos: new THREE.Vector3(-3.4, T + 1, 9.4), radius: 1.6, kind: 'helmet', label: 'INSPECT THE GOLDEN LID' });
  // energy cans stash (props)
  const canMat = new THREE.MeshStandardMaterial({ color: 0x0b0d0c, roughness: 0.3, metalness: 0.9, emissive: 0x7dff1a, emissiveIntensity: 0.25 });
  const canGeo = new THREE.CylinderGeometry(0.035, 0.035, 0.13, 10);
  const cans = new THREE.InstancedMesh(canGeo, canMat, 24);
  const mtx = new THREE.Matrix4();
  const canSpots = [];
  for (let i = 0; i < 7; i++) canSpots.push([-6.0 + (i % 4) * 0.09, T + 0.865 + Math.floor(i / 4) * 0.13, 9.1 + Math.floor(i / 4) * 0.04]);
  canSpots.push([-19.0, 1.015, -20.2], [-18.6, 1.015, -20.1], [19.1, 1.015, -20.2], [-13.2, 1.015, -15.7], [-8.6, 1.465, -24.2], [8.3, 1.465, -23.9]);
  canSpots.push([-0.4, 9.565, 4.2], [-29.0, 0.545, -2.3], [28.6, 0.545, -2.4], [-12.9, 1.265, 9.6]);
  canSpots.forEach((p, i) => { mtx.makeRotationY(i * 1.7); mtx.setPosition(p[0], p[1], p[2]); cans.setMatrixAt(i, mtx); });
  cans.count = canSpots.length;
  B.mesh(cans);
  // secret room consoles
  B.box(-6.35, T, 9.0, -5.5, T + 0.8, 9.6, 'machine');

  await yieldFrame(); progress(0.84);

  // ---------------- industrial decor ----------------
  // ceiling trusses
  for (let x = -30; x <= 30; x += 10) {
    B.visualBox(x - 0.25, 14.2, -Z, x + 0.25, 15, Z, 'darkMetal');
    if (detail !== 'low') for (let z = -24; z <= 24; z += 4) B.visualBox(x - 0.08, 14.2, z - 0.05, x + 0.08, 14.3, z + 0.05, 'trim');
  }
  for (const z of [-18, -6, 6, 18]) B.visualBox(-X, 14.4, z - 0.15, X, 14.7, z + 0.15, 'darkMetal');
  // ventilation ducts
  B.mbox(-33.9, 13.7, -10, -32.4, 14.6, 10, 'machine', { noCollide: true });
  B.visualBox(-12, 13.8, 24.4, 12, 14.6, 25.9, 'machine');
  B.visualBox(-14, 13.8, -25.9, 14, 14.6, -24.4, 'machine');
  // wall fans
  const fans = [];
  for (const [x, y, z, ry] of [[-33.85, 11.2, -17, Math.PI / 2], [33.85, 11.2, -17, -Math.PI / 2], [-33.85, 11.2, 17, Math.PI / 2], [33.85, 11.2, 17, -Math.PI / 2], [-18, 8.6, -25.85, 0], [18, 8.6, -25.85, 0]]) {
    const f = buildFan(M, lockdown ? PALETTE.warnRed : PALETTE.acid);
    f.root.position.set(x, y, z);
    f.root.rotation.y = ry;
    B.mesh(f.root);
    fans.push(f);
  }
  arena.animated.push((dt) => { for (const f of fans) f.blades.rotation.z += dt * 9; });
  // overhead gantry crane (moving)
  const crane = new THREE.Group();
  const beam = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.9, 51), M.darkMetal);
  crane.add(beam);
  const trolley = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.8, 2.4), M.machine);
  trolley.position.y = -0.8;
  crane.add(trolley);
  const cable = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 2.4, 6), M.trim);
  cable.position.y = -2.4;
  trolley.add(cable);
  const hook = new THREE.Mesh(new THREE.TorusGeometry(0.25, 0.07, 8, 16, Math.PI * 1.4), M.trim);
  hook.position.y = -1.3;
  cable.add(hook);
  const craneLight = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.06, 0.2), M.neonWhite);
  craneLight.position.set(0, -0.48, 0);
  crane.add(craneLight);
  crane.position.set(0, 13.6, 0);
  B.mesh(crane);
  arena.animated.push((dt, t) => {
    crane.position.x = Math.sin(t * 0.05) * 22;
    trolley.position.z = Math.sin(t * 0.09 + 1) * 18;
  });

  // broken machinery sparks + electrical boxes
  arena.sparkBoxes.push(
    { pos: new THREE.Vector3(-27.9, 2.4, 20.4), interval: 1.6, timer: 0 },
    { pos: new THREE.Vector3(27.9, 2.4, 20.4), interval: 1.9, timer: 0.7 },
    { pos: new THREE.Vector3(0, 2.5, -22.05), interval: 2.4, timer: 1.1 },
    { pos: new THREE.Vector3(-6.9, T + 2.3, -3.5), interval: 2.8, timer: 0.4 },
    { pos: new THREE.Vector3(6.9, T + 2.3, -3.5), interval: 3.1, timer: 1.9 },
  );
  for (const sb of arena.sparkBoxes) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.7, 0.25), M.machine);
    box.position.copy(sb.pos);
    B.mesh(box);
  }
  arena.steamVents.push(
    { pos: new THREE.Vector3(-7, 0.05, -17), interval: 0.18 }, { pos: new THREE.Vector3(7, 0.05, -17), interval: 0.18 },
    { pos: new THREE.Vector3(-26, 0.05, -21), interval: 0.22 }, { pos: new THREE.Vector3(26, 0.05, -21), interval: 0.22 },
    { pos: new THREE.Vector3(-14, 0.05, 23.8), interval: 0.25 }, { pos: new THREE.Vector3(14, 0.05, 23.8), interval: 0.25 },
  );
  for (const v of arena.steamVents) {
    B.visualBox(v.pos.x - 0.5, 0, v.pos.z - 0.5, v.pos.x + 0.5, 0.03, v.pos.z + 0.5, 'grate');
  }

  // ---------------- lights ----------------
  const L = arena.lights;
  const hemi = new THREE.HemisphereLight(lockdown ? 0x8a5a54 : 0x8e9894, 0x1a1c1c, lockdown ? 0.75 : 1.1);
  B.mesh(hemi);
  const sun = new THREE.DirectionalLight(lockdown ? 0xff9a8a : 0xdfe8ff, lockdown ? 0.7 : 1.5);
  sun.position.set(14, 30, 10);
  sun.target.position.set(0, 0, 0);
  B.mesh(sun); B.mesh(sun.target);
  arena.sun = sun;
  const addPoint = (color, intensity, distance, pos, opts2 = {}) => {
    const l = new THREE.PointLight(color, intensity, distance, opts2.decay ?? 1.6);
    l.position.set(...pos);
    B.mesh(l);
    L.push(l);
    return l;
  };
  const reactorColor = lockdown ? 0xff3a12 : PALETTE.acid;
  const rl1 = addPoint(reactorColor, 38, 24, [0, 2.5, 0]);
  const rl2 = addPoint(reactorColor, 40, 16, [0, -2.2, 0]);
  const rl3 = addPoint(reactorColor, 30, 16, [0, 10.8, 0]);
  arena.animated.push((dt, t) => {
    const pulse = 0.85 + 0.15 * Math.sin(t * 2.1) + 0.05 * Math.sin(t * 13.7);
    rl1.intensity = 38 * pulse; rl2.intensity = 26 * pulse; rl3.intensity = 18 * pulse;
    coreMat.uniforms.uPulse.value = Math.max(0, Math.sin(t * 2.1)) * 0.3;
    innerRings[0].rotation.z += dt * 0.6; innerRings[1].rotation.z -= dt * 0.9; innerRings[2].rotation.z += dt * 1.3;
    innerRings.forEach((r, i) => { r.position.y = 0.8 + i * 3.1 + Math.sin(t * 0.8 + i) * 0.5; });
    arcTimer -= dt;
    if (arcTimer <= 0) { arcTimer = 0.06 + Math.random() * 0.12; regenArcs(); }
    for (const p of pistons) p.rod.position.y = -0.2 - Math.abs(Math.sin(t * 1.4 + p.phase)) * 0.7;
  });
  if (lighting !== 'low') {
    addPoint(0xf2f5f0, 34, 18, [-29, 3.7, 0]);
    addPoint(0xf2f5f0, 34, 18, [29, 3.7, 0]);
    addPoint(lockdown ? 0xff4020 : 0xe0f0ff, 40, 26, [-14, 9, 22]);
    addPoint(lockdown ? 0xff4020 : 0xe0f0ff, 40, 26, [14, 9, 22]);
    addPoint(lockdown ? 0xff2a1a : PALETTE.acid, 15, 13, [-12, T + 2.2, 0]);
    addPoint(lockdown ? 0xff2a1a : PALETTE.acid, 15, 13, [12, T + 2.2, 0]);
  }
  if (lighting === 'high') {
    addPoint(PALETTE.p1, 14, 12, [-29, 8.0, 0]);
    addPoint(PALETTE.p2, 14, 12, [29, 8.0, 0]);
    const f1 = addPoint(0xfff2dd, 30, 20, [-15, 3.6, -18]);
    const f2 = addPoint(0xfff2dd, 30, 20, [15, 3.6, -18]);
    arena.flickerLights.push({ light: f1, base: 30, timer: 0.5, on: true }, { light: f2, base: 30, timer: 1.3, on: true });
  }
  // rotating emergency beacons (spot lights)
  const beacons = [];
  const beaconCount = lighting === 'low' ? 0 : lockdown ? 2 : 1;
  const beaconSpots = [[0, 7.6, -19.3], [0, 13.0, 18.6]];
  for (let i = 0; i < beaconCount; i++) {
    const sp = new THREE.SpotLight(PALETTE.warnRed, lockdown ? 220 : 140, 30, 0.5, 0.6, 1.5);
    sp.position.set(...beaconSpots[i]);
    B.mesh(sp); B.mesh(sp.target);
    const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 0.3, 12), M.neonRed);
    housing.position.copy(sp.position).add(new THREE.Vector3(0, 0.15, 0));
    B.mesh(housing);
    beacons.push({ sp, phase: i * 2 });
  }
  arena.animated.push((dt, t) => {
    for (const b of beacons) {
      const a = t * 2.4 + b.phase;
      b.sp.target.position.set(b.sp.position.x + Math.cos(a) * 8, b.sp.position.y - 6, b.sp.position.z + Math.sin(a) * 8);
    }
  });
  // emissive lamp fixtures + volumetric light shafts
  const lampPos = [[-12, -6], [12, -6], [-12, 6], [12, 6], [-20, 19], [20, 19], [-20, -19], [20, -19], [0, 22.5]];
  for (const [x, z] of lampPos) {
    const fixture = new THREE.Mesh(new THREE.CylinderGeometry(0.75, 0.9, 0.3, 16), M.darkMetal);
    fixture.position.set(x, 14.1, z);
    B.mesh(fixture);
    const bulb = new THREE.Mesh(new THREE.CircleGeometry(0.68, 20), lockdown ? M.neonRed : M.neonWhite);
    bulb.rotation.x = Math.PI / 2;
    bulb.position.set(x, 13.94, z);
    B.mesh(bulb);
    if (effects !== 'low') {
      const sm = shaftMaterial(lockdown ? 0xff5a40 : 0xe8f4ff, lockdown ? 0.05 : 0.065);
      arena.shaderMats.push(sm);
      const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 3.4, 13.4, 20, 1, true), sm);
      shaft.position.set(x, 14 - 6.7, z);
      shaft.renderOrder = 5;
      B.mesh(shaft);
    }
  }
  if (effects !== 'low') {
    const dust = dustSystem(effects === 'high' ? 900 : 450, new THREE.Vector3(-X, 0, -Z), new THREE.Vector3(X, 13, Z), lockdown ? 0xff8060 : 0xc8ffa0);
    dust.material.uniforms.uScale.value = 420;
    arena.shaderMats.push(dust.material);
    B.mesh(dust);
  }
  await yieldFrame(); progress(0.9);

  // ---------------- gameplay data ----------------
  const sp = (x, y, z, yawToCenter = true) => {
    const yaw = yawToCenter ? Math.atan2(x, z) : 0;
    return { pos: new THREE.Vector3(x, y, z), yaw };
  };
  arena.spawns = [];
  for (const s of [-1, 1]) {
    arena.spawns.push(
      sp(s * 29, 0, 7), sp(s * 29, 0, -7), sp(s * 30.5, 0, 0), sp(s * 29, UP, 8.5), sp(s * 29, UP, -8.5),
      sp(s * 28, 0, 23.5), sp(s * 28, 0, -21.5), sp(s * 22, UP, 24), sp(s * 15, 0, -23.5),
    );
  }
  // Initial spawns: west base for player 0, east base for player 1.
  arena.initialSpawns = [arena.spawns[2], arena.spawns[11]];

  const P = (kind, pos, extra = {}) => arena.addPickup({ kind, pos: new THREE.Vector3(...pos), ...extra }, lib, detail);
  // weapons
  for (const s of [-1, 1]) {
    P('weapon', [s * 20, 0, 13.9], { weapon: 'volt' });
    P('weapon', [s * 16, 0, -18], { weapon: 'crush' });
    P('weapon', [s * 20, UP, -13.5], { weapon: 'venom' });
  }
  P('weapon', [0, T, 4.6], { weapon: 'chaos' });
  P('weapon', [0, 8.0, -23.5], { weapon: 'rail' });
  // health / armor / energy / mega
  for (const s of [-1, 1]) {
    P('health', [s * 26.2, 0, -9]);
    P('health', [s * 12, 0, -23.8]);
    P('health', [s * 14, 0, 24.3]);
    P('health', [s * 29, UP, -5.5]);
    P('healthLarge', [s * 10, T, 0]);
    P('armor', [s * 14, UP, 0]);
    P('energy', [s * 27, 1.2, -18]);
    P('energy', [s * 3.4, 0, 17.8]);
    P('energy', [s * 6.3, UP, -6.3]);
    P('energy', [s * 15.5, 2.6, 21.2]);
  }
  P('armor', [0, UP, 24]);
  P('mega', [0, 9.5, 0]);

  // camera paths
  arena.flyover = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-30, 13, 22), new THREE.Vector3(-16, 10, 15), new THREE.Vector3(-4, 7.5, 13),
    new THREE.Vector3(9, 6.5, 9), new THREE.Vector3(13, 6.8, -4), new THREE.Vector3(6, 7.5, -13), new THREE.Vector3(-6, 9, -16),
  ]);
  arena.flyoverLook = new THREE.Vector3(0, 4, 0);
  arena.menuPath = new THREE.CatmullRomCurve3([
    new THREE.Vector3(-18, 6.5, 9), new THREE.Vector3(-8, 8, 13), new THREE.Vector3(8, 9, 11), new THREE.Vector3(17, 7, 3),
    new THREE.Vector3(15, 6, -9), new THREE.Vector3(4, 7.5, -13), new THREE.Vector3(-10, 8.5, -12), new THREE.Vector3(-18, 7, -3),
  ], true);
  arena.bounds = { min: new THREE.Vector3(-X, T - 1, -Z), max: new THREE.Vector3(X, CEIL, Z) };
  arena.killY = T - 8;

  B.finalize(true);
  progress(1);
  return arena;
}

// ---------------------------------------------------------------------------
// Prop helpers
// ---------------------------------------------------------------------------
function addJumpPad(arena, B, pos, vel, color) {
  const [x, y, z] = pos;
  B.box(x - 0.95, y, z - 0.95, x + 0.95, y + 0.12, z + 0.95, 'darkMetal', { surface: 'metal' });
  const pad = B.world.addJumpPad([x - 0.8, y + 0.1, z - 0.8], [x + 0.8, y + 0.9, z + 0.8], vel);
  const mat = jumpPadMaterial(color);
  arena.shaderMats.push(mat);
  const disc = new THREE.Mesh(new THREE.PlaneGeometry(1.7, 1.7), mat);
  disc.rotation.x = -Math.PI / 2;
  disc.position.set(x, y + 0.125, z);
  B.mesh(disc);
  const ring = new THREE.Mesh(new THREE.TorusGeometry(0.9, 0.04, 6, 32), neon(color, 3));
  ring.rotation.x = Math.PI / 2;
  ring.position.set(x, y + 0.13, z);
  B.mesh(ring);
  arena.jumpPadVisuals.push({ pad, mat });
}

function addGlass(arena, B, [x0, y0, z0, x1, y1, z1], material, isVent = false) {
  const collider = B.world.addBox([x0, y0, z0], [x1, y1, z1], { surface: isVent ? 'metal' : 'glass', glass: true, blocksBullets: false, blocksMove: true });
  const g = new THREE.BoxGeometry(x1 - x0, y1 - y0, z1 - z0);
  const mesh = new THREE.Mesh(g, material);
  mesh.position.set((x0 + x1) / 2, (y0 + y1) / 2, (z0 + z1) / 2);
  mesh.renderOrder = 3;
  B.mesh(mesh);
  const id = arena.glass.length;
  collider.glassId = id;
  arena.glass.push({ id, collider, mesh, broken: false, center: mesh.position.clone(), size: new THREE.Vector3(x1 - x0, y1 - y0, z1 - z0), vent: isVent });
}

let barrelGeo = null;
function addBarrel(arena, B, x, y, z, lib) {
  if (!barrelGeo) {
    barrelGeo = {
      body: new THREE.CylinderGeometry(0.42, 0.42, 1.2, 18),
      band: new THREE.CylinderGeometry(0.435, 0.435, 0.16, 18, 1, true),
      cap: new THREE.CylinderGeometry(0.3, 0.3, 0.06, 14),
    };
  }
  const g = new THREE.Group();
  const body = new THREE.Mesh(barrelGeo.body, lib.M.darkMetal);
  body.position.y = 0.6;
  body.castShadow = true;
  const band = new THREE.Mesh(barrelGeo.band, lib.M.neonGreen);
  band.position.y = 0.75;
  const band2 = new THREE.Mesh(barrelGeo.band, lib.M.neonGreen);
  band2.position.y = 0.35;
  const cap = new THREE.Mesh(barrelGeo.cap, lib.M.hazard);
  cap.position.y = 1.22;
  g.add(body, band, band2, cap);
  g.position.set(x, y, z);
  g.rotation.y = Math.random() * 6;
  B.mesh(g);
  const collider = B.world.addCylinder(x, z, 0.42, y, y + 1.2, { surface: 'metal' });
  const id = arena.barrels.length;
  collider.barrelId = id;
  arena.barrels.push({ id, collider, mesh: g, alive: true, pos: new THREE.Vector3(x, y + 0.6, z) });
}

function addLamp(arena, B, x, y, z, ry) {
  const onMat = B.M.neonWhite;
  const offMat = B.M.black;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.14, 0.12), onMat);
  mesh.position.set(x, y, z);
  mesh.rotation.y = ry;
  B.mesh(mesh);
  const hx = Math.abs(Math.cos(ry)) > 0.5 ? 0.35 : 0.08, hz = Math.abs(Math.cos(ry)) > 0.5 ? 0.08 : 0.35;
  const collider = B.world.addBox([x - hx, y - 0.08, z - hz], [x + hx, y + 0.08, z + hz], { surface: 'glass', blocksMove: false, blocksBullets: true });
  const id = arena.lamps.length;
  collider.lampId = id;
  arena.lamps.push({ id, collider, mesh, onMat, offMat, broken: false, pos: mesh.position.clone() });
}

function buildFan(M, color) {
  const root = new THREE.Group();
  const housing = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.2, 10, 32), M.darkMetal);
  root.add(housing);
  const back = new THREE.Mesh(new THREE.CircleGeometry(1.45, 24), new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(0.6) }));
  back.position.z = 0.02;
  root.add(back);
  const blades = new THREE.Group();
  for (let i = 0; i < 5; i++) {
    const b = new THREE.Mesh(new THREE.BoxGeometry(0.32, 1.35, 0.04), M.machine);
    b.position.y = 0.7;
    const holder = new THREE.Group();
    holder.rotation.z = (i / 5) * Math.PI * 2;
    b.rotation.y = 0.5;
    holder.add(b);
    blades.add(holder);
  }
  blades.position.z = 0.12;
  root.add(blades);
  const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.25, 12), M.trim);
  hub.rotation.x = Math.PI / 2;
  hub.position.z = 0.15;
  root.add(hub);
  return { root, blades };
}

function buildVending(lib, M) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(1.2, 2.1, 0.9), M.darkMetal);
  body.position.y = 1.05;
  body.castShadow = true;
  g.add(body);
  const front = new THREE.Mesh(new THREE.PlaneGeometry(1.08, 1.98), new THREE.MeshBasicMaterial({ map: lib.signs.vending, color: new THREE.Color(1.6, 1.6, 1.6) }));
  front.position.set(0, 1.05, 0.451);
  g.add(front);
  const glow = new THREE.Mesh(new THREE.BoxGeometry(1.24, 0.06, 0.94), lib.M.neonGreen);
  glow.position.y = 2.1;
  g.add(glow);
  return g;
}

function buildArcade(lib, M) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.8, 1.7, 0.7), M.black);
  body.position.y = 0.85;
  g.add(body);
  const screen = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.46), new THREE.MeshBasicMaterial({ map: lib.signs.arcade, color: new THREE.Color(1.5, 1.5, 1.5) }));
  screen.position.set(0, 1.3, 0.352);
  screen.rotation.x = -0.15;
  g.add(screen);
  const marquee = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.16, 0.72), lib.M.neonP2 || lib.M.neonOrange);
  marquee.position.y = 1.72;
  g.add(marquee);
  const panel = new THREE.Mesh(new THREE.BoxGeometry(0.78, 0.08, 0.3), M.darkMetal);
  panel.position.set(0, 0.98, 0.42);
  panel.rotation.x = 0.3;
  g.add(panel);
  return g;
}

function buildHiddenHelmet() {
  const g = new THREE.Group();
  const gold = new THREE.MeshStandardMaterial({ color: 0xffc640, metalness: 1, roughness: 0.18, emissive: 0x3a2400, emissiveIntensity: 0.4 });
  const shell = new THREE.Mesh(new THREE.SphereGeometry(0.2, 20, 14), gold);
  shell.scale.set(1, 1.05, 1.15);
  g.add(shell);
  const chin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.09, 0.14), gold);
  chin.position.set(0, -0.12, -0.17);
  g.add(chin);
  const visor = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.03, 0.18), gold);
  visor.position.set(0, 0.16, -0.18);
  visor.rotation.x = -0.25;
  g.add(visor);
  const goggle = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.08, 0.05), new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.acid).multiplyScalar(3) }));
  goggle.position.set(0, 0.03, -0.22);
  g.add(goggle);
  return g;
}

export { addJumpPad as addJumpPadPublic, signPlane as signPlanePublic };

// Pickup definitions and their in-world visuals (weapon pedestals, health, armor,
// energy cans, mega energy). Availability is driven by the match authority.
import * as THREE from 'three';
import { PALETTE } from './config.js';
import { buildWeaponModel, getWeapon } from './weapons/index.js';

export const PICKUP_KINDS = {
  health: { amount: 20, respawn: 15, label: '+20 HEALTH' },
  healthLarge: { amount: 50, respawn: 25, label: '+50 HEALTH' },
  armor: { amount: 25, respawn: 20, label: '+25 ARMOR' },
  energy: { amount: 25, respawn: 12, label: '+25 ENERGY' },
  mega: { amount: 50, respawn: 35, label: 'MEGA ENERGY' },
  weapon: { respawn: 15, label: '' },
};

export function pickupRespawn(p) {
  if (p.kind === 'weapon') return getWeapon(p.weapon).pickupRespawn;
  return PICKUP_KINDS[p.kind].respawn;
}

function canGeometry() {
  const pts = [];
  pts.push(new THREE.Vector2(0, 0));
  pts.push(new THREE.Vector2(0.075, 0));
  pts.push(new THREE.Vector2(0.085, 0.015));
  pts.push(new THREE.Vector2(0.085, 0.22));
  pts.push(new THREE.Vector2(0.07, 0.25));
  pts.push(new THREE.Vector2(0.065, 0.26));
  pts.push(new THREE.Vector2(0, 0.26));
  const g = new THREE.LatheGeometry(pts, 20);
  g.translate(0, -0.13, 0);
  return g;
}

let shared = null;
function sharedAssets(lib) {
  if (shared) return shared;
  const ringGeo = new THREE.TorusGeometry(0.55, 0.035, 8, 40);
  ringGeo.rotateX(Math.PI / 2);
  const baseGeo = new THREE.CylinderGeometry(0.62, 0.72, 0.12, 24);
  const crossA = new THREE.BoxGeometry(0.42, 0.13, 0.13);
  const crossB = new THREE.BoxGeometry(0.13, 0.42, 0.13);
  const armorShape = new THREE.Shape();
  armorShape.moveTo(0, 0.28); armorShape.lineTo(0.24, 0.18); armorShape.lineTo(0.22, -0.12);
  armorShape.lineTo(0, -0.3); armorShape.lineTo(-0.22, -0.12); armorShape.lineTo(-0.24, 0.18); armorShape.closePath();
  const armorGeo = new THREE.ExtrudeGeometry(armorShape, { depth: 0.08, bevelEnabled: true, bevelSize: 0.02, bevelThickness: 0.02, bevelSegments: 2 });
  armorGeo.translate(0, 0, -0.04);
  const can = canGeometry();
  const orb = new THREE.IcosahedronGeometry(0.32, 3);
  const beamGeo = new THREE.CylinderGeometry(0.5, 0.5, 2.2, 24, 1, true);
  beamGeo.translate(0, 1.1, 0);
  const beamMat = new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    uniforms: { uColor: { value: new THREE.Color(PALETTE.acid) }, uTime: { value: 0 }, uAlpha: { value: 1 } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv=uv; gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.0);}',
    fragmentShader: `uniform vec3 uColor; uniform float uTime; uniform float uAlpha; varying vec2 vUv;
      void main(){ float a = pow(1.0 - vUv.y, 2.2) * 0.35; a *= 0.75 + 0.25*sin(vUv.y*30.0 - uTime*6.0);
      gl_FragColor = vec4(uColor * 1.6, a * uAlpha); }`,
  });
  shared = {
    ringGeo, baseGeo, crossA, crossB, armorGeo, can, orb, beamGeo, beamMat,
    baseMat: lib.M.darkMetal,
    healthMat: new THREE.MeshStandardMaterial({ color: 0xf2f5f0, emissive: 0x7dff1a, emissiveIntensity: 0.9, roughness: 0.3, metalness: 0.1 }),
    armorMat: new THREE.MeshStandardMaterial({ color: 0xdfe6ea, emissive: 0x4fb8ff, emissiveIntensity: 0.25, roughness: 0.25, metalness: 0.85 }),
    canMat: new THREE.MeshStandardMaterial({ color: 0x0b0d0c, roughness: 0.25, metalness: 0.9, emissive: 0x7dff1a, emissiveIntensity: 0.35 }),
    canBand: new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.acid).multiplyScalar(3) }),
    megaMat: new THREE.MeshBasicMaterial({ color: new THREE.Color(PALETTE.acid).multiplyScalar(2.6) }),
  };
  return shared;
}

const KIND_COLORS = {
  health: 0x7dff1a, healthLarge: 0x7dff1a, armor: 0x6ac8ff, energy: 0x7dff1a, mega: 0xa6ff4d, weapon: 0xf2f5f0,
};

export class PickupVisual {
  constructor(def, lib, detail = 'high') {
    const S = sharedAssets(lib);
    this.def = def;
    this.root = new THREE.Group();
    this.root.position.copy(def.pos);
    this.item = new THREE.Group();
    this.item.position.y = 0.75;
    this.root.add(this.item);
    const color = def.kind === 'weapon' && getWeapon(def.weapon).rare ? 0xff8a1f : KIND_COLORS[def.kind];
    const ringMat = new THREE.MeshBasicMaterial({ color: new THREE.Color(color).multiplyScalar(3) });
    this.ringMat = ringMat;
    const base = new THREE.Mesh(S.baseGeo, S.baseMat);
    base.position.y = 0.06;
    base.receiveShadow = true;
    this.root.add(base);
    const ring = new THREE.Mesh(S.ringGeo, ringMat);
    ring.position.y = 0.13;
    this.root.add(ring);
    this.ring = ring;
    if (detail !== 'low') {
      const beamMat = S.beamMat.clone();
      beamMat.uniforms.uColor.value = new THREE.Color(color);
      this.beam = new THREE.Mesh(S.beamGeo, beamMat);
      this.beam.position.y = 0.12;
      this.root.add(this.beam);
    }

    switch (def.kind) {
      case 'health':
      case 'healthLarge': {
        const s = def.kind === 'healthLarge' ? 1.45 : 1;
        const g = new THREE.Group();
        g.add(new THREE.Mesh(S.crossA, S.healthMat), new THREE.Mesh(S.crossB, S.healthMat));
        g.scale.setScalar(s);
        this.item.add(g);
        break;
      }
      case 'armor': {
        const m = new THREE.Mesh(S.armorGeo, S.armorMat);
        m.scale.setScalar(1.2);
        this.item.add(m);
        break;
      }
      case 'energy': {
        const c = new THREE.Mesh(S.can, S.canMat);
        const band = new THREE.Mesh(new THREE.CylinderGeometry(0.087, 0.087, 0.06, 20, 1, true), S.canBand);
        band.position.y = 0.01;
        c.add(band);
        c.scale.setScalar(1.7);
        c.rotation.z = 0.35;
        this.item.add(c);
        break;
      }
      case 'mega': {
        const o = new THREE.Mesh(S.orb, S.megaMat);
        this.item.add(o);
        for (let i = 0; i < 2; i++) {
          const r = new THREE.Mesh(new THREE.TorusGeometry(0.48 + i * 0.1, 0.02, 6, 48), ringMat);
          r.rotation.x = Math.PI / 2 + i * 0.6;
          this.item.add(r);
        }
        this.item.position.y = 1.0;
        this.light = true;
        break;
      }
      case 'weapon': {
        const m = buildWeaponModel(def.weapon, { detail: 'low' });
        m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
        const box = new THREE.Box3().setFromObject(m);
        const size = box.getSize(new THREE.Vector3());
        const sc = 0.95 / Math.max(size.x, size.y, size.z) * 1.15;
        m.scale.setScalar(Math.min(1.5, sc * 1.2));
        const c = box.getCenter(new THREE.Vector3()).multiplyScalar(m.scale.x);
        m.position.sub(c);
        const holder = new THREE.Group();
        holder.add(m);
        holder.rotation.z = -0.25;
        this.item.add(holder);
        this.item.position.y = 0.85;
        break;
      }
    }
    this.available = true;
    this.phase = Math.random() * Math.PI * 2;
    this.flash = 0;
  }

  setAvailable(v) {
    if (this.available === v) return;
    this.available = v;
    this.item.visible = v;
    if (v) this.flash = 1;
  }

  update(dt, t) {
    this.item.rotation.y += dt * (this.def.kind === 'weapon' ? 1.1 : 1.6);
    this.item.position.y = (this.def.kind === 'mega' ? 1.0 : this.def.kind === 'weapon' ? 0.85 : 0.75) + Math.sin(t * 2 + this.phase) * 0.06;
    const base = this.available ? 3 : 0.45;
    this.flash = Math.max(0, this.flash - dt * 2);
    const k = base + this.flash * 6;
    this.ringMat.color.setHex(this.def.kind === 'weapon' && getWeapon(this.def.weapon).rare ? 0xff8a1f : KIND_COLORS[this.def.kind]).multiplyScalar(k * (0.85 + 0.15 * Math.sin(t * 4 + this.phase)));
    if (this.beam) {
      this.beam.material.uniforms.uTime.value = t;
      this.beam.material.uniforms.uAlpha.value = this.available ? 1 : 0.12;
    }
  }
}

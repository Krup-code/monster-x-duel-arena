// Post-processing chain: world render -> (camera motion blur) -> (GTAO) -> first-person
// viewmodel (depth cleared so guns never clip into walls) -> bloom -> combat overlay
// (vignette, damage, Energy Rush glow, death desaturation) -> tone mapping -> (SMAA/FXAA).
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { FXAAPass } from 'three/addons/postprocessing/FXAAPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const OverlayShader = {
  uniforms: {
    tDiffuse: { value: null },
    uDamage: { value: 0 }, uRush: { value: 0 }, uLow: { value: 0 }, uDesat: { value: 0 },
    uTime: { value: 0 }, uFlash: { value: 0 }, uVignette: { value: 0.55 }, uAspect: { value: 1.7 }, uScope: { value: 0 },
  },
  vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix*modelViewMatrix*vec4(position,1.0); }',
  fragmentShader: `uniform sampler2D tDiffuse; uniform float uDamage, uRush, uLow, uDesat, uTime, uFlash, uVignette, uAspect, uScope; varying vec2 vUv;
    void main(){
      vec2 c = vUv - 0.5; c.x *= uAspect; float r = length(c);
      float ca = 0.0008 + uDamage*0.0035;
      vec2 dir = (vUv - 0.5) * ca;
      vec3 col = vec3(texture2D(tDiffuse, vUv + dir).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - dir).b);
      float l = dot(col, vec3(0.299, 0.587, 0.114));
      col = mix(col, vec3(l) * vec3(0.9, 1.0, 0.92), uDesat);
      col *= mix(1.0, smoothstep(1.25, 0.32, r), uVignette);
      float edge = smoothstep(0.42, 1.05, r);
      float hurt = edge * uDamage * 0.85 + edge * uLow * 0.4 * (0.65 + 0.35 * sin(uTime * 5.5));
      col = mix(col, col * 0.35 + vec3(0.85, 0.04, 0.02) * 0.65, clamp(hurt, 0.0, 0.9));
      col += vec3(0.30, 1.0, 0.08) * edge * edge * uRush * (0.32 + 0.12 * sin(uTime * 7.0));
      col *= 1.0 - uScope * smoothstep(0.30, 0.34, r);
      col += vec3(uFlash);
      gl_FragColor = vec4(col, 1.0);
    }`,
};

class CameraMotionBlurPass extends Pass {
  constructor(camera) {
    super();
    this.camera = camera;
    this.prevViewProj = new THREE.Matrix4();
    this.hasPrev = false;
    this.material = new THREE.ShaderMaterial({
      uniforms: {
        tDiffuse: { value: null }, tDepth: { value: null },
        uInvViewProj: { value: new THREE.Matrix4() }, uPrevViewProj: { value: new THREE.Matrix4() }, uStrength: { value: 0.6 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
      fragmentShader: `uniform sampler2D tDiffuse; uniform sampler2D tDepth; uniform mat4 uInvViewProj; uniform mat4 uPrevViewProj; uniform float uStrength; varying vec2 vUv;
        void main(){
          float d = texture2D(tDepth, vUv).x;
          vec4 clip = vec4(vUv * 2.0 - 1.0, d * 2.0 - 1.0, 1.0);
          vec4 world = uInvViewProj * clip; world /= world.w;
          vec4 prev = uPrevViewProj * world; prev /= prev.w;
          vec2 vel = (vUv - (prev.xy * 0.5 + 0.5)) * uStrength;
          float len = length(vel);
          if (len > 0.035) vel *= 0.035 / len;
          vec4 acc = texture2D(tDiffuse, vUv);
          for (int i = 1; i < 8; i++) acc += texture2D(tDiffuse, vUv - vel * (float(i) / 7.0));
          gl_FragColor = acc / 8.0;
        }`,
    });
    this.fsQuad = new FullScreenQuad(this.material);
    this._vp = new THREE.Matrix4();
  }

  render(renderer, writeBuffer, readBuffer) {
    const cam = this.camera;
    this._vp.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse);
    if (!this.hasPrev) { this.prevViewProj.copy(this._vp); this.hasPrev = true; }
    const u = this.material.uniforms;
    u.tDiffuse.value = readBuffer.texture;
    u.tDepth.value = readBuffer.depthTexture;
    u.uInvViewProj.value.copy(this._vp).invert();
    u.uPrevViewProj.value.copy(this.prevViewProj);
    this.prevViewProj.copy(this._vp);
    renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
    this.fsQuad.render(renderer);
  }

  dispose() { this.material.dispose(); this.fsQuad.dispose(); }
}

export class PostFX {
  constructor(renderer, scene, camera, vmScene, vmCamera) {
    this.renderer = renderer;
    this.scene = scene;
    this.camera = camera;
    this.vmScene = vmScene;
    this.vmCamera = vmCamera;
    this.composer = null;
    this.overlay = null;
    this.state = { damage: 0, rush: 0, low: 0, desat: 0, flash: 0, scope: 0 };
    this.time = 0;
  }

  build(g) {
    if (this.composer) {
      this.composer.passes.forEach((p) => p.dispose?.());
      this.composer.renderTarget1.dispose();
      this.composer.renderTarget2.dispose();
    }
    const r = this.renderer;
    const size = r.getDrawingBufferSize(new THREE.Vector2());
    const rt = new THREE.WebGLRenderTarget(size.x, size.y, { type: THREE.HalfFloatType });
    if (g.motionBlur) {
      rt.depthTexture = new THREE.DepthTexture(size.x, size.y);
      rt.depthTexture.type = THREE.UnsignedIntType;
    }
    const composer = new EffectComposer(r, rt);
    composer.setPixelRatio(1);
    composer.setSize(size.x, size.y);
    composer.addPass(new RenderPass(this.scene, this.camera));
    this.motionBlur = null;
    if (g.motionBlur) {
      this.motionBlur = new CameraMotionBlurPass(this.camera);
      composer.addPass(this.motionBlur);
    }
    if (g.ao) {
      const ao = new GTAOPass(this.scene, this.camera, size.x, size.y);
      ao.output = GTAOPass.OUTPUT.Default;
      ao.blendIntensity = 0.85;
      ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1, thickness: 1.2, scale: 1 });
      composer.addPass(ao);
      this.ao = ao;
    } else this.ao = null;
    const vm = new RenderPass(this.vmScene, this.vmCamera);
    vm.clear = false;
    vm.clearDepth = true;
    composer.addPass(vm);
    this.bloom = null;
    if (g.bloom) {
      const scale = g.effects === 'low' ? 0.5 : 1;
      this.bloom = new UnrealBloomPass(new THREE.Vector2(size.x * scale, size.y * scale), 0.55, 0.45, 1.0);
      composer.addPass(this.bloom);
    }
    this.overlay = new ShaderPass(OverlayShader);
    composer.addPass(this.overlay);
    composer.addPass(new OutputPass());
    // Post-process AA after tone mapping. (Multisampled HDR targets proved unreliable with
    // bloom on some GPUs, so MSAA is not offered; SMAA gives comparable edge quality.)
    if (g.antialias === 'fxaa') composer.addPass(new FXAAPass());
    else if (g.antialias === 'smaa') composer.addPass(new SMAAPass());
    this.composer = composer;
  }

  setSize(w, h) {
    if (!this.composer) return;
    this.composer.setSize(w, h);
    if (this.overlay) this.overlay.uniforms.uAspect.value = w / Math.max(1, h);
  }

  render(dt) {
    this.time += dt;
    const u = this.overlay.uniforms;
    const s = this.state;
    u.uTime.value = this.time;
    u.uDamage.value = s.damage;
    u.uRush.value = s.rush;
    u.uLow.value = s.low;
    u.uDesat.value = s.desat;
    u.uFlash.value = s.flash;
    u.uScope.value = s.scope;
    this.composer.render(dt);
  }
}

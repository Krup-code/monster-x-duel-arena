// Game: renderer + main loop + app state machine + menu/lobby/match flows.
//
// App states (this.state):
//   BOOT → MAIN_MENU → CREATING_ROOM / JOINING_ROOM → LOBBY → LOADING →
//   COUNTDOWN → PLAYING ⇄ RESPAWNING → SUDDEN_DEATH → MATCH_ENDED   (+ DISCONNECTED, TRAINING)
// Lobby logic lives here; match logic lives in MatchClient; rules live in HostAuthority.
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { NET, PLAYER, PROTOCOL_VERSION, MATCH } from './config.js';
import { settings } from './settings.js';
import { Input } from './input.js';
import { AudioEngine } from './audio.js';
import { buildMaterialLibrary } from './textures.js';
import { buildArena, MAPS } from './arena.js';
import { Effects } from './effects.js';
import { PostFX } from './postfx.js';
import { CharacterModel } from './characters.js';
import { ViewModel } from './viewmodel.js';
import { buildWeaponModel } from './weapons/index.js';
import { NetSession } from './network.js';
import { inviteLink, normalizeCode, isValidCode } from './network/rooms.js';
import { MatchClient, isAuthorityEvent } from './matchClient.js';
import { NavGraph } from './nav.js';
import { UI } from './ui.js';

export const VERSION = '1.0.0';
const BOT_NAMES = { easy: 'BOT · EASY', normal: 'BOT · NORMAL', hard: 'BOT · HARD', insane: 'BOT · INSANE' };
const DRAW = { low: { far: 70, fog: 1.5 }, medium: { far: 100, fog: 1.15 }, high: { far: 160, fog: 1 } };
const SHADOW = { low: 1024, medium: 2048, high: 4096 };

export class Game {
  constructor(canvas, uiRoot) {
    this.canvas = canvas;
    this.uiRoot = uiRoot;
    this.state = 'BOOT';
    this.version = VERSION;
    this.fps = 60;
    this._fpsAcc = 0;
    this._fpsFrames = 0;
    this.timeScale = 1;
    this.timeScaleUntil = 0;
    this.mc = null;
    this.net = null;
    this.arena = null;
    this.nav = null;
    this.lobby = null;
    this.debugVisible = false;
    this.pendingEvents = null;
    this.menuT = 0;
    this._tpWeapons = new Map();
    const params = new URLSearchParams(location.search);
    const room = normalizeCode(params.get('room'));
    this.initialRoom = isValidCode(room) ? room : null;

    // renderer
    const r = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.ACESFilmicToneMapping;
    r.toneMappingExposure = 1.25;
    r.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer = r;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(70, 16 / 9, 0.05, 160);
    this.camera.rotation.order = 'YXZ';
    this.vmScene = new THREE.Scene();
    this.vmCamera = new THREE.PerspectiveCamera(72, 16 / 9, 0.01, 10);
    this.postfx = new PostFX(r, this.scene, this.camera, this.vmScene, this.vmCamera);
    this.input = new Input(canvas);
    this.audio = new AudioEngine();
    this.facade = this._makeFacade();
    this.ui = new UI(uiRoot, this.facade);
    this.ui.show('loading');
    this.ui.setLoading(0, 'BOOTING');

    window.addEventListener('resize', () => this._resize());
    const unlockAudio = () => this.audio.resume();
    window.addEventListener('pointerdown', unlockAudio, true);
    window.addEventListener('keydown', unlockAudio, true);
    canvas.addEventListener('click', () => { if (this.mc && !this.input.locked && !this.mc.ended) this.facade.actions.resume(); });
    this.input.onLockChange((locked, isError) => this._onLockChange(locked, isError));
    document.addEventListener('visibilitychange', () => this._onVisibility());
    document.addEventListener('fullscreenchange', () => { if (!document.fullscreenElement) navigator.keyboard?.unlock?.(); });
    settings.onChange((section, key) => this.applySettings(section, key));
    this._installDebugApi();
  }

  // ================================================================== boot
  async boot() {
    const stage = (from, to) => (p) => this.ui.setLoading(from + (to - from) * p, this._loadLabel);
    try {
      this._loadLabel = 'LOADING FONTS';
      await Promise.race([document.fonts?.ready, new Promise((r) => setTimeout(r, 2500))]);
      await Promise.all(['700 64px Teko', '600 32px Rajdhani', '400 40px "Permanent Marker"'].map((f) => document.fonts?.load(f).catch(() => {})));
      this._loadLabel = 'SYNTHESIZING AUDIO';
      await this.audio.init(stage(0.02, 0.3));
      this.audio.setVolumes(settings.data.audio);
      this._loadLabel = 'FORGING TEXTURES';
      this.libQuality = settings.data.graphics.textures;
      this.lib = await buildMaterialLibrary(this.libQuality, this.renderer, stage(0.3, 0.55));
      this.effects = new Effects(this.scene, this.lib, settings.data.graphics.effects, null);
      this.effects.onSound = (name, pos) => { if (name === 'casing') this.audio.play('impact_metal', { position: pos, volume: 0.06, pitch: 2.4, pitchVar: 0.2 }); };
      this.models = [new CharacterModel({ accent: 0x7dff1a, detail: settings.data.graphics.geometry }), new CharacterModel({ accent: 0xff8a1f, detail: settings.data.graphics.geometry })];
      for (const m of this.models) { m.setVisible(false); this.scene.add(m.root); }
      this.viewmodel = new ViewModel({ scene: this.vmScene, camera: this.vmCamera, accent: 0x7dff1a });
      this.viewmodel.setWeapon('razor', { instant: true });
      this.viewmodel.setVisible(false);
      this._loadLabel = 'BUILDING THE BLACKOUT FACILITY';
      await this._loadArena('blackout', stage(0.55, 0.95), false);
      this.postfx.build(settings.data.graphics);
      this._resize();
      this._applyCrosshair();
      this._loadLabel = 'COMPILING SHADERS';
      this.ui.setLoading(0.97, this._loadLabel);
      await this._compile();
      this.ui.setLoading(1, 'READY');
    } catch (e) {
      console.error(e);
      this.ui.setLoading(1, 'ERROR: ' + (e.message || e));
      throw e;
    }
    this._last = performance.now();
    requestAnimationFrame((t) => this._raf(t));
    this.toMainMenu();
    if (this.initialRoom) this.ui.show('join', { code: this.initialRoom });
    console.log('%cMONSTER-X: DUEL ARENA', 'color:#7dff1a;font:700 22px Teko,sans-serif', '\n1V1. NO EXCUSES. — psst: there is a vent in the north tunnel worth shooting.');
  }

  async _compile() {
    try {
      this.camera.position.set(0, 6, 14);
      this.camera.lookAt(0, 3, 0);
      if (this.renderer.compileAsync) await this.renderer.compileAsync(this.scene, this.camera);
      if (this.renderer.compileAsync) await this.renderer.compileAsync(this.vmScene, this.vmCamera);
    } catch (e) { console.warn('compile', e); }
  }

  qualityKey() {
    const g = settings.data.graphics;
    return `${g.textures}|${g.geometry}|${g.lighting}|${g.effects}`;
  }

  async _loadArena(mapId, onProgress = null, showScreen = true) {
    if (showScreen) { this.ui.show('loading'); this.ui.setLoading(0, 'LOADING ARENA'); }
    const progress = onProgress || ((p) => this.ui.setLoading(p * 0.95, 'LOADING ARENA'));
    if (this.arena && this.arena.id === mapId && this.arenaKey === this.qualityKey()) { progress(1); return this.arena; }
    if (this.arena) {
      this.scene.remove(this.arena.group);
      this.arena.dispose();
      this.audio.clearAmbient();
    }
    const g = settings.data.graphics;
    if (this.libQuality !== g.textures) {
      this.libQuality = g.textures;
      this.lib = await buildMaterialLibrary(g.textures, this.renderer, (p) => progress(p * 0.3));
    }
    const arena = await buildArena(mapId, this.lib, { geometry: g.geometry, lighting: g.lighting, effects: g.effects, onProgress: (p) => progress(0.3 + p * 0.6) });
    this.arena = arena;
    this.arenaKey = this.qualityKey();
    this.nav = null;
    this.scene.add(arena.group);
    this.scene.fog = arena.fog;
    this._baseFog = arena.fog.density;
    this.renderer.setClearColor(arena.clearColor, 1);
    this.effects.world = arena.world;
    this.effects.clearDecals();
    this._applyShadows();
    this._applyDrawDistance();
    this._buildEnvironment();
    this._startAmbient();
    progress(1);
    if (showScreen) await this._compile();
    return arena;
  }

  getNav() {
    if (!this.nav) {
      const t0 = performance.now();
      this.nav = NavGraph.build(this.arena.world, this.arena);
      console.log(`[nav] ${this.nav.nodes.length} nodes in ${(performance.now() - t0).toFixed(0)} ms`);
    }
    return this.nav;
  }

  thirdPersonWeapon(id) {
    let m = this._tpWeapons.get(id);
    if (!m) {
      m = buildWeaponModel(id, { detail: 'low' });
      m.traverse((o) => { if (o.isMesh) o.castShadow = true; });
      this._tpWeapons.set(id, m);
    }
    return m;
  }

  _buildEnvironment() {
    const pm = new THREE.PMREMGenerator(this.renderer);
    let env;
    if (settings.data.graphics.reflections === 'high' && this.arena) {
      // Real reflections: capture the arena itself from near the reactor.
      const cubeRT = new THREE.WebGLCubeRenderTarget(256, { type: THREE.HalfFloatType });
      const cubeCam = new THREE.CubeCamera(0.5, 120, cubeRT);
      cubeCam.position.set(0, 5.5, 9);
      const prevEnv = this.scene.environment;
      this.scene.environment = null;
      const vis = this.effects.group.visible;
      this.effects.group.visible = false;
      cubeCam.update(this.renderer, this.scene);
      this.effects.group.visible = vis;
      env = pm.fromCubemap(cubeRT.texture).texture;
      cubeRT.dispose();
      prevEnv?.dispose?.();
    } else {
      const room = new RoomEnvironment();
      env = pm.fromScene(room, 0.04).texture;
      room.traverse((o) => { o.geometry?.dispose(); });
    }
    pm.dispose();
    if (this.envMap && this.envMap !== env) this.envMap.dispose();
    this.envMap = env;
    this.scene.environment = env;
    this.scene.environmentIntensity = settings.data.graphics.reflections === 'high' ? 0.85 : 0.45;
    this.vmScene.environment = env;
  }

  _startAmbient() {
    const a = this.audio;
    const A = this.arena;
    if (A.isTraining) {
      a.addAmbient('machinery', new THREE.Vector3(0, 6, -10), { volume: 0.4 });
      return;
    }
    a.addAmbient('reactor_hum', new THREE.Vector3(0, 2, 0), { volume: 1 });
    a.addAmbient('electric_hum', new THREE.Vector3(0, -2.5, 0), { volume: 0.7 });
    a.addAmbient('machinery', new THREE.Vector3(0, 1.5, -23.5), { volume: 0.7 });
    a.addAmbient('machinery', new THREE.Vector3(-27.9, 1.5, 20.4), { volume: 0.4 });
    a.addAmbient('fan', new THREE.Vector3(-33, 11, -17), { volume: 0.5 });
    a.addAmbient('fan', new THREE.Vector3(33, 11, 17), { volume: 0.5 });
    for (const v of A.steamVents.slice(0, 4)) a.addAmbient('steam', v.pos, { volume: 0.35 });
    if (A.id === 'lockdown') a.addAmbient('alarm', new THREE.Vector3(0, 10, 0), { volume: 0.35 });
  }

  // ================================================================== settings
  applySettings(section, key) {
    const g = settings.data.graphics;
    if (section === 'audio') this.audio.setVolumes(settings.data.audio);
    if (section === 'crosshair') this._applyCrosshair();
    if (section === 'graphics') {
      if (!key || key === 'renderScale') this._resize();
      if (!key || key === 'shadows') this._applyShadows(true);
      if (!key || key === 'drawDistance') this._applyDrawDistance();
      if (!key || key === 'reflections') this._buildEnvironment();
      if (!key || ['antialias', 'motionBlur', 'bloom', 'ao', 'effects', 'preset'].includes(key)) { this.postfx.build(g); this._resize(); }
    }
    if (section === 'player' && this.lobby) this._lobbyNameChanged();
  }

  _applyCrosshair() { this.ui.hud.setCrosshairSettings(settings.data.crosshair); }

  _applyShadows(rebuild = false) {
    const q = settings.data.graphics.shadows;
    const on = q !== 'off';
    const was = this.renderer.shadowMap.enabled;
    this.renderer.shadowMap.enabled = on;
    const sun = this.arena?.sun;
    if (sun) {
      sun.castShadow = on;
      const size = SHADOW[q] || 2048;
      sun.shadow.mapSize.set(size, size);
      const c = sun.shadow.camera;
      c.left = -46; c.right = 46; c.top = 40; c.bottom = -40; c.near = 1; c.far = 90;
      c.updateProjectionMatrix();
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.04;
      if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
    }
    if (rebuild && was !== on) this.scene.traverse((o) => { if (o.material) [].concat(o.material).forEach((m) => { m.needsUpdate = true; }); });
  }

  _applyDrawDistance() {
    const d = DRAW[settings.data.graphics.drawDistance] || DRAW.high;
    this.camera.far = d.far;
    this.camera.updateProjectionMatrix();
    if (this.scene.fog && this._baseFog) this.scene.fog.density = this._baseFog * d.fog;
  }

  _resize() {
    const w = window.innerWidth, h = window.innerHeight;
    const scale = settings.data.graphics.renderScale || 1;
    const pr = Math.min(window.devicePixelRatio || 1, 2) * scale;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.vmCamera.aspect = w / h;
    this.vmCamera.updateProjectionMatrix();
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this.postfx.setSize(size.x, size.y);
    this._rect = null;
  }

  canvasRect() {
    if (!this._rect) this._rect = { width: window.innerWidth, height: window.innerHeight };
    return this._rect;
  }

  /** Horizontal FOV in degrees (at 16:9) -> camera vertical FOV. */
  setFov(hfov) {
    const v = 2 * Math.atan(Math.tan((hfov * Math.PI) / 360) * (9 / 16)) * (180 / Math.PI);
    if (Math.abs(this.camera.fov - v) > 0.01) {
      this.camera.fov = v;
      this.camera.updateProjectionMatrix();
    }
  }

  setTimeScale(scale, dur) {
    this.timeScale = scale;
    this.timeScaleUntil = performance.now() / 1000 + dur;
  }

  get inputActive() { return this.input.locked || !!this.input.debugInput; }

  // ================================================================== loop
  _raf(t) {
    requestAnimationFrame((tt) => this._raf(tt));
    const limit = settings.data.graphics.fpsLimit;
    if (limit > 0 && t - this._lastRender < 1000 / limit - 0.6) return;
    this._lastRender = t;
    this._frame(t, true);
  }

  _onVisibility() {
    clearInterval(this._bgTimer);
    if (document.hidden && this.mc && this.mc.online) {
      // Keep simulating (and hosting) while the tab is in the background.
      this._bgTimer = setInterval(() => this._frame(performance.now(), false), 33);
    }
  }

  _frame(now, render) {
    let realDt = Math.min(0.1, Math.max(0, (now - this._last) / 1000));
    this._last = now;
    if (realDt <= 0) return;
    this._fpsAcc += realDt; this._fpsFrames++;
    if (this._fpsAcc >= 0.5) { this.fps = this._fpsFrames / this._fpsAcc; this._fpsAcc = 0; this._fpsFrames = 0; }
    if (performance.now() / 1000 > this.timeScaleUntil) this.timeScale = 1;
    const simDt = this.mc && this.mc.role === 'offline' ? realDt * this.timeScale : realDt;
    const t = now / 1000;
    // global hotkeys
    if (this.input.pressed('debug')) this.debugVisible = !this.debugVisible;

    if (this.mc) {
      this.mc.update(simDt, realDt);
      this._updateMatchUi();
    } else {
      this._updateMenuCamera(realDt);
    }
    if (this.arena) {
      this.arena.update(realDt * (this.mc ? this.mc.fxTimeScale : 1), t);
      this._updateArenaFx(realDt);
    }
    this.effects.update(realDt * (this.mc ? this.mc.fxTimeScale : 1), this.camera);
    // viewmodel camera mirrors the world camera
    this.camera.updateMatrixWorld();
    this.vmCamera.position.copy(this.camera.position);
    this.vmCamera.quaternion.copy(this.camera.quaternion);
    const vf = settings.data.camera.viewmodelFov;
    if (this.vmCamera.fov !== vf) { this.vmCamera.fov = vf; this.vmCamera.updateProjectionMatrix(); }
    this.vmCamera.updateMatrixWorld();
    if (this.arena && this.viewmodel) {
      this._vmTint = this._vmTint || new THREE.Color();
      this.viewmodel.setLightTint?.(this.arena.sampleLight(this.camera.position, this._vmTint));
    }
    const fwd = this._fwd || (this._fwd = new THREE.Vector3());
    this.camera.getWorldDirection(fwd);
    this.audio.setListener(this.camera.position, fwd, this.camera.up);
    if (render) this.postfx.render(realDt);
    this.input.endFrame();
  }

  _updateArenaFx(dt) {
    const A = this.arena;
    for (const sb of A.sparkBoxes) {
      sb.timer -= dt;
      if (sb.timer <= 0) {
        sb.timer = sb.interval * (0.5 + Math.random());
        this.effects.sparkBurst(sb.pos, 10);
        if (this.camera.position.distanceTo(sb.pos) < 22) this.audio.play('spark', { position: sb.pos, volume: 0.45 });
      }
    }
    if (settings.data.graphics.effects !== 'low') {
      for (const v of A.steamVents) {
        v.t = (v.t ?? Math.random()) - dt;
        if (v.t <= 0) { v.t = v.interval; this.effects.steam(v.pos); }
      }
    }
    if (A.statsBoard && this.mc?.training) {
      this._boardT = (this._boardT ?? 0) - dt;
      if (this._boardT <= 0) {
        this._boardT = 0.5;
        const T = this.mc.hud.training;
        const { ctx, canvas, tex } = A.statsBoard;
        ctx.fillStyle = '#040504'; ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = '#7dff1a'; ctx.lineWidth = 6; ctx.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
        ctx.fillStyle = '#7dff1a'; ctx.font = '700 72px Teko, sans-serif'; ctx.textAlign = 'left';
        ctx.fillText('TRAINING STATS', 40, 90);
        ctx.font = '600 52px Teko, sans-serif'; ctx.fillStyle = '#f2f5f0';
        const rows = [['SHOTS', T?.shots ?? 0], ['HITS', T?.hits ?? 0], ['ACCURACY', `${T?.accuracy ?? 0}%`], ['HEADSHOTS', T?.headshots ?? 0], ['DAMAGE', T?.damage ?? 0], ['DPS (3s)', T?.dps ?? 0]];
        rows.forEach(([k, v], i) => { ctx.fillText(k, 40 + (i % 2) * 480, 170 + Math.floor(i / 2) * 100); ctx.fillStyle = '#7dff1a'; ctx.fillText(String(v), 300 + (i % 2) * 480, 170 + Math.floor(i / 2) * 100); ctx.fillStyle = '#f2f5f0'; });
        tex.needsUpdate = true;
      }
    }
  }

  _updateMenuCamera(dt) {
    this.menuT += dt;
    const A = this.arena;
    if (!A?.menuPath) return;
    const p = A.menuPath.getPointAt((this.menuT * 0.008) % 1);
    this.camera.position.copy(p);
    this.camera.position.y += Math.sin(this.menuT * 0.3) * 0.4;
    this.camera.lookAt(Math.sin(this.menuT * 0.07) * 2, 4 + Math.sin(this.menuT * 0.11), Math.cos(this.menuT * 0.05) * 2);
    this.setFov(92);
    this.postfx.state.desat = 0;
    this.postfx.state.damage = 0;
    this.postfx.state.rush = 0;
    this.postfx.state.low = 0;
    this.postfx.state.scope = 0;
  }

  _updateMatchUi() {
    const mc = this.mc;
    const hud = this.ui.hud;
    hud.update(mc.hud);
    // scoreboard (held Tab, works even when menus are open)
    const sbHeld = this._heldAction('scoreboard') && !this.ui.isMenuOpen();
    if (sbHeld !== this._sbVisible) { this._sbVisible = sbHeld; this.ui.scoreboard.setVisible(sbHeld); }
    if (sbHeld) {
      this._sbT = (this._sbT ?? 0) - 1;
      if (this._sbT <= 0) {
        this._sbT = 10;
        this.ui.scoreboard.update({ mode: mc.mode, map: this.arena.name, timeText: mc.hud.timeText, rows: mc.scoreboardRows() });
      }
    }
    hud.setDebug(this.debugVisible, this.debugVisible ? mc.debugLines() : null);
    if (mc.netPaused && this.net) hud.setOverlay('disconnected', { remaining: Math.ceil(this.net.reconnectRemaining) });
    // keep the app state label current
    this.updateMatchState();
  }

  _heldAction(action) {
    for (const c of settings.data.controls.bindings[action] || []) if (this.input.held.has(c)) return true;
    return false;
  }

  // ================================================================== state machine
  setState(s) {
    if (this.state === s) return;
    this.state = s;
    document.body.dataset.state = s;
  }

  updateMatchState() {
    const mc = this.mc;
    if (!mc) return;
    if (mc.netPaused) return this.setState('DISCONNECTED');
    const p = mc.view.phase;
    if (mc.mode === 'training') return this.setState(mc.local.alive ? 'TRAINING' : 'RESPAWNING');
    if (p === 'intro' || p === 'countdown' || p === 'idle') return this.setState('COUNTDOWN');
    if (p === 'ended') return this.setState('MATCH_ENDED');
    if (!mc.local.alive) return this.setState('RESPAWNING');
    this.setState(p === 'suddendeath' ? 'SUDDEN_DEATH' : 'PLAYING');
  }

  // ================================================================== flows
  toMainMenu() {
    this._disposeMatch();
    if (this.net) { this.net.leave(); this.net = null; }
    this.lobby = null;
    this.input.enabled = false;
    this.input.exitLock();
    this.ui.hud.setVisible(false);
    this.ui.end.hide();
    this.ui.show('main');
    this.setState('MAIN_MENU');
    this.audio.startMusic('menu');
    this.audio.setMuffled(false);
    if (this.arena && this.arena.id !== 'blackout' && this.arena.id !== 'lockdown') this._loadArena('blackout', null, false);
  }

  _disposeMatch() {
    if (this.mc) {
      this.mc.dispose();
      this.mc = null;
    }
    clearInterval(this._bgTimer);
    this.pendingEvents = null;
    this.viewmodel?.setVisible(false);
    for (const m of this.models || []) m.setVisible(false);
    this.ui.hud.setOverlay(null);
    this.ui.hud.setDebug(false, null);
    this.ui.scoreboard.setVisible(false);
    this.ui.hud.setVisible(false);
    this.postfx.state.desat = 0;
    this.timeScale = 1;
  }

  _myName(index) {
    const n = (settings.data.player.name || '').trim().toUpperCase().slice(0, 16);
    return n || `PLAYER ${index + 1}`;
  }

  // ------------------------------------------------------------------ offline
  async startBot({ difficulty = 'normal', map = 'blackout' } = {}) {
    this.input.requestLock();
    this._disposeMatch();
    this.setState('LOADING');
    await this._loadArena(map);
    this.offlineCfg = { mode: 'bot', difficulty, map };
    const mc = new MatchClient(this, { mode: 'bot', role: 'offline', myIndex: 0, names: [this._myName(0), BOT_NAMES[difficulty] || 'BOT'], difficulty });
    this.mc = mc;
    mc.startAuthority(false);
  }

  async startTraining() {
    this.input.requestLock();
    this._disposeMatch();
    this.setState('LOADING');
    await this._loadArena('training');
    this.offlineCfg = { mode: 'training', map: 'training' };
    const mc = new MatchClient(this, { mode: 'training', role: 'offline', myIndex: 0, names: [this._myName(0), ''] });
    this.mc = mc;
    mc.startAuthority(false);
  }

  /** Called by MatchClient on every 'start' event (first start, rematch, resume). */
  onMatchStarted(mc, e) {
    this.ui.end.hide();
    this.ui.show(null);
    this.ui.hud.setVisible(true);
    this.ui.hud.setOverlay(this.inputActive ? null : 'resume');
    this.input.enabled = true;
    this.viewmodel.setAccent(mc.me === 0 ? 0x7dff1a : 0xff8a1f);
    this.viewmodel.setVisible(true);
    this.audio.startMusic('match');
    this.audio.setSuddenDeath(false);
    this.audio.setMuffled(false);
    this.ui.end.setRematchStatus({ me: false, them: false, online: mc.online });
    this.updateMatchState();
    void e;
  }

  showEndScreen(mc) {
    if (this.mc !== mc || !mc.view.endData) return;
    this.input.exitLock();
    this.ui.hud.setOverlay(null);
    this.ui.show('end', mc.view.endData);
    this.ui.end.setRematchStatus({ me: mc.rematchReq.me, them: mc.rematchReq.them, online: mc.online });
    this.audio.startMusic('menu');
  }

  _onLockChange(locked, isError = false) {
    const mc = this.mc;
    if (!mc) return;
    if (isError) {
      // The browser refused the lock (no user gesture yet): ask for a click instead of pausing.
      if (!mc.ended && this.ui.current !== 'pause') this.ui.hud.setOverlay('resume');
      return;
    }
    if (locked) {
      if (mc.ended) return;
      this.ui.show(null);
      this.ui.hud.setOverlay(mc.netPaused ? 'disconnected' : null);
      mc.paused = false;
    } else {
      if (mc.ended || this.ui.current === 'end') return;
      if (mc.role === 'offline') mc.paused = true;
      this.ui.show('pause', { online: mc.online, mode: mc.mode });
    }
  }

  // ------------------------------------------------------------------ online: host
  async hostMatch() {
    this._disposeMatch();
    if (this.net) { this.net.leave(); this.net = null; }
    this.setState('CREATING_ROOM');
    const net = new NetSession({ name: this._myName(0) });
    this.net = net;
    this.lobby = { role: 'host', ready: [false, false], names: [this._myName(0), ''], map: 'blackout', connected: false, loaded: [false, false], rematch: [false, false] };
    this._wireNet(net);
    this.ui.show('lobby');
    this._pushLobby();
    try {
      const code = await net.host();
      if (this.net !== net) return code;
      this.setState('LOBBY');
      this._pushLobby();
      return code;
    } catch (e) {
      console.error(e);
      if (this.net === net) { net.leave(false); this.net = null; }
      this.toMainMenu();
      this.ui.toast(`COULD NOT CREATE ROOM — ${friendlyNetError(e.message)}`, 'error', 4200);
      throw e;
    }
  }

  // ------------------------------------------------------------------ online: guest
  async joinMatch(rawCode) {
    const code = normalizeCode(rawCode);
    if (!isValidCode(code)) throw new Error('ROOM_NOT_FOUND');
    this._disposeMatch();
    if (this.net) { this.net.leave(); this.net = null; }
    this.setState('JOINING_ROOM');
    const net = new NetSession({ name: this._myName(1) });
    this.net = net;
    this.lobby = { role: 'guest', ready: [false, false], names: ['', this._myName(1)], map: 'blackout', connected: false, loaded: [false, false], rematch: [false, false] };
    this._wireNet(net);
    net.on('status', (s) => this.ui.lobby.setJoinStatus(s, 'info'));
    const connected = new Promise((resolve, reject) => {
      net.on('connected', resolve);
      net.on('closed', (info) => reject(new Error(info?.reason || 'connect-failed')));
    });
    try {
      await net.join(code);
      await Promise.race([connected, new Promise((_, rej) => setTimeout(() => rej(new Error('ice-failed')), 25000))]);
      if (this.net !== net) return;
      this.lobby.names[0] = net.peerName || 'PLAYER 1';
      this.setState('LOBBY');
      this.ui.show('lobby');
      this._pushLobby();
      net.send('prefs', { autoSwap: !!settings.data.controls.autoSwap });
    } catch (e) {
      if (this.net === net) { net.leave(false); this.net = null; }
      this.lobby = null;
      this.setState('MAIN_MENU');
      throw e;
    }
  }

  _wireNet(net) {
    net.on('connected', () => {
      if (this.net !== net) return;
      this.lobby.connected = true;
      if (net.role === 'host') {
        this.lobby.names[1] = net.peerName || 'PLAYER 2';
        this.lobby.ready = [false, false];
        this.audio.play('ui_click', { bus: 'ui' });
        this.ui.toast(`${this.lobby.names[1]} JOINED THE ROOM`, 'success');
        this._broadcastLobby();
      }
      this._pushLobby();
    });
    net.on('message', (m) => this._onNetMessage(m));
    net.on('state', (buf) => this.mc?.onRemoteState(buf));
    net.on('disconnected', () => {
      if (this.net !== net) return;
      if (this.mc) {
        this.mc.netPaused = true;
        this.mc.authority?.pause(true);
        this.ui.hud.setOverlay('disconnected', { remaining: NET.reconnectWindow });
        this.updateMatchState();
      }
      this._pushLobby();
    });
    net.on('reconnected', () => {
      if (this.net !== net) return;
      this.lobby.connected = true;
      if (this.mc) {
        this.mc.netPaused = false;
        this.ui.hud.setOverlay(this.inputActive ? null : 'resume');
        if (net.role === 'host') {
          this.mc.authority?.pause(false);
          this.mc.authority?.resync();
        }
        this.ui.toast('CONNECTION RESTORED', 'success');
        this.updateMatchState();
      } else if (net.role === 'host') {
        this._broadcastLobby();
        if (this.lobby?.inMatchMap) this.net.send('load', { map: this.lobby.inMatchMap, resume: true });
      }
      this._pushLobby();
    });
    net.on('closed', (info) => {
      if (this.net !== net) return;
      const inMatch = !!this.mc;
      if (net.role === 'host' && info?.roomOpen) {
        // Opponent left: keep the room open for a new challenger.
        this._disposeMatch();
        this.input.exitLock();
        this.lobby.connected = false;
        this.lobby.names[1] = '';
        this.lobby.ready = [false, false];
        this.lobby.rematch = [false, false];
        this.lobby.inMatchMap = null;
        this.ui.show('lobby');
        this.setState('LOBBY');
        this._pushLobby();
        this.audio.startMusic('menu');
        this.ui.toast(inMatch ? 'MATCH ENDED — OPPONENT LEFT' : 'OPPONENT LEFT THE ROOM', 'error', 4200);
      } else {
        this.net = null;
        const reason = info?.reason;
        this.toMainMenu();
        this.ui.toast(inMatch ? 'MATCH ENDED — OPPONENT LEFT' : reason === 'left' ? 'HOST CLOSED THE ROOM' : 'CONNECTION LOST', 'error', 4200);
      }
    });
  }

  _onNetMessage(m) {
    const net = this.net;
    if (!net || !m) return;
    if (net.role === 'host') {
      switch (m.t) {
        case 'ready': this.lobby.ready[1] = !!m.v; this._broadcastLobby(); this._pushLobby(); return;
        case 'name': this.lobby.names[1] = String(m.name || 'PLAYER 2').slice(0, 16); this._broadcastLobby(); this._pushLobby(); return;
        case 'loaded': this.lobby.loaded[1] = true; this._maybeStartOnline(); return;
        case 'rematch': this.lobby.rematch[1] = true; this._rematchStatus(); this._maybeRematch(); return;
        case 'toLobby': this._backToLobby(false); return;
        default: this.mc?.onGuestMessage(m); return;
      }
    }
    // guest
    if (isAuthorityEvent(m)) {
      if (!this.mc) {
        if (m.t === 'start') this._guestEnterMatch(m);
        else if (this.pendingEvents) this.pendingEvents.push(m);
        return;
      }
      if (this.pendingEvents) { this.pendingEvents.push(m); return; }
      this.mc.handleEvent(m);
      return;
    }
    switch (m.t) {
      case 'lobby':
        Object.assign(this.lobby, { ready: m.ready, map: m.map });
        this.lobby.names = [m.names[0], m.names[1] || this._myName(1)];
        this._pushLobby();
        break;
      case 'load': this._guestLoad(m.map); break;
      case 'rematchStatus':
        if (this.mc) {
          this.mc.rematchReq = { me: !!m.guest, them: !!m.host };
          this.ui.end.setRematchStatus({ me: !!m.guest, them: !!m.host, online: true });
        }
        break;
      case 'toLobby': this._backToLobby(true); break;
      default: break;
    }
  }

  _pushLobby() {
    const L = this.lobby;
    const net = this.net;
    if (!L) return;
    const host = L.role === 'host';
    const connected = !!net?.connected;
    this.ui.lobby.update({
      role: L.role, code: net?.code || null, invite: net?.code ? inviteLink(net.code) : null,
      status: net?.statusText || '', connected,
      players: [
        { name: L.names[0] || 'PLAYER 1', ready: L.ready[0], connected: host || connected, isMe: host },
        { name: L.names[1] || (host ? '' : this._myName(1)), ready: L.ready[1], connected: !host || connected, isMe: !host },
      ],
      ping: connected && net.rtt ? Math.round(net.rtt) : null, map: L.map,
      canStart: host && connected && L.ready[0] && L.ready[1], backend: net?.backendLabel || '',
    });
  }

  _broadcastLobby() {
    if (!this.net?.connected || this.lobby?.role !== 'host') return;
    this.net.send('lobby', { ready: this.lobby.ready, names: this.lobby.names, map: this.lobby.map });
  }

  _lobbyNameChanged() {
    const L = this.lobby;
    if (!L) return;
    if (L.role === 'host') { L.names[0] = this._myName(0); this.net && (this.net.name = L.names[0]); this._broadcastLobby(); }
    else { L.names[1] = this._myName(1); this.net?.send('name', { name: L.names[1] }); }
    this._pushLobby();
  }

  setReady(v) {
    const L = this.lobby;
    if (!L) return;
    if (L.role === 'host') { L.ready[0] = !!v; this._broadcastLobby(); }
    else { L.ready[1] = !!v; this.net?.send('ready', { v: !!v }); }
    this._pushLobby();
  }

  selectMap(id) {
    const L = this.lobby;
    if (!L || L.role !== 'host' || !MAPS[id] || id === 'training') return;
    L.map = id;
    this._broadcastLobby();
    this._pushLobby();
  }

  async startOnlineMatch() {
    const L = this.lobby;
    if (!L || L.role !== 'host' || !this.net?.connected || !(L.ready[0] && L.ready[1])) return;
    this.input.requestLock();
    L.loaded = [false, false];
    L.inMatchMap = L.map;
    this.net.send('load', { map: L.map });
    this.setState('LOADING');
    await this._loadArena(L.map);
    if (!this.net?.connected) return;
    this._disposeMatch();
    this.mc = new MatchClient(this, { mode: 'duel', role: 'host', myIndex: 0, names: [L.names[0] || 'PLAYER 1', L.names[1] || 'PLAYER 2'] });
    this.ui.show('loading');
    this.ui.setLoading(1, 'WAITING FOR OPPONENT');
    L.loaded[0] = true;
    this._maybeStartOnline();
  }

  _maybeStartOnline() {
    const L = this.lobby;
    if (!L || !this.mc || this.mc.authority?.phase !== 'idle') return;
    if (L.loaded[0] && L.loaded[1]) {
      L.rematch = [false, false];
      this.mc.startAuthority(false);
    }
  }

  async _guestLoad(map) {
    this.setState('LOADING');
    this.lobby.inMatchMap = map;
    await this._loadArena(map);
    if (!this.net?.connected) return;
    this._disposeMatch();
    this.mc = new MatchClient(this, { mode: 'duel', role: 'guest', myIndex: 1, names: [this.lobby.names[0] || 'PLAYER 1', this.lobby.names[1] || 'PLAYER 2'] });
    this.ui.show('loading');
    this.ui.setLoading(1, 'WAITING FOR HOST');
    this.net.send('loaded');
  }

  /** Guest receives 'start' without having loaded (e.g. rejoined a running match after a reload). */
  async _guestEnterMatch(startEvt) {
    if (this._entering) { this.pendingEvents?.push(startEvt); return; }
    this._entering = true;
    this.pendingEvents = [startEvt];
    try {
      await this._loadArena(startEvt.map);
      this._disposeMatchKeepQueue();
      this.mc = new MatchClient(this, { mode: 'duel', role: 'guest', myIndex: 1, names: startEvt.names || ['PLAYER 1', 'PLAYER 2'] });
      const q = this.pendingEvents;
      this.pendingEvents = null;
      for (const e of q) this.mc.handleEvent(e);
    } finally {
      this._entering = false;
    }
  }

  _disposeMatchKeepQueue() {
    const q = this.pendingEvents;
    this._disposeMatch();
    this.pendingEvents = q;
  }

  // ------------------------------------------------------------------ end of match actions
  rematch() {
    const mc = this.mc;
    if (!mc) return;
    if (!mc.online) {
      this.input.requestLock();
      mc.startAuthority(true);
      return;
    }
    if (this.net?.role === 'host') {
      this.lobby.rematch[0] = true;
      mc.rematchReq.me = true;
      this._rematchStatus();
      this._maybeRematch();
    } else {
      mc.rematchReq.me = true;
      this.net?.send('rematch');
      this.ui.end.setRematchStatus({ me: true, them: mc.rematchReq.them, online: true });
    }
    this.input.requestLock();
  }

  _rematchStatus() {
    const L = this.lobby;
    if (!L) return;
    if (this.mc) {
      this.mc.rematchReq = { me: L.rematch[0], them: L.rematch[1] };
      if (this.ui.current === 'end') this.ui.end.setRematchStatus({ me: L.rematch[0], them: L.rematch[1], online: true });
    }
    this.net?.send('rematchStatus', { host: L.rematch[0], guest: L.rematch[1] });
  }

  _maybeRematch() {
    const L = this.lobby;
    if (!L || !this.mc || !this.mc.ended) return;
    if (L.rematch[0] && L.rematch[1]) {
      L.rematch = [false, false];
      this.mc.startAuthority(true);
    }
  }

  changeMap() {
    const mc = this.mc;
    if (mc && !mc.online) {
      const cfg = this.offlineCfg;
      this._disposeMatch();
      this.input.exitLock();
      if (cfg?.mode === 'training') this.toMainMenu();
      else { this.ui.show('botSetup'); this.setState('MAIN_MENU'); this.audio.startMusic('menu'); }
      return;
    }
    if (this.net?.connected) this.net.send('toLobby');
    this._backToLobby(this.net?.role === 'guest');
  }

  _backToLobby() {
    if (!this.lobby) return this.toMainMenu();
    this._disposeMatch();
    this.input.exitLock();
    this.lobby.ready = [false, false];
    this.lobby.rematch = [false, false];
    this.lobby.loaded = [false, false];
    this.lobby.inMatchMap = null;
    this.ui.show('lobby');
    this.setState('LOBBY');
    this.audio.startMusic('menu');
    this._pushLobby();
  }

  leaveMatch() {
    if (this.mc && !this.mc.online) { this.toMainMenu(); return; }
    this.toMainMenu();
  }

  // ================================================================== facade for the UI
  _makeFacade() {
    const game = this;
    return {
      version: VERSION,
      maps: Object.values(MAPS).filter((m) => m.id !== 'training').map((m) => ({ id: m.id, name: m.name, desc: m.desc })),
      get initialRoom() { return game.initialRoom; },
      get audio() { return game.audio; },
      get input() { return game.input; },
      settings,
      netInfo: () => ({ backend: game.net?.backendLabel || 'PeerJS broker (0.peerjs.com)' }),
      actions: {
        hostMatch: () => game.hostMatch(),
        joinMatch: (code) => game.joinMatch(code),
        cancelJoin: () => { if (game.net && !game.net.connected) { game.net.leave(false); game.net = null; game.lobby = null; } game.setState('MAIN_MENU'); },
        leaveRoom: () => game.toMainMenu(),
        setReady: (v) => game.setReady(v),
        selectMap: (id) => game.selectMap(id),
        startMatch: () => game.startOnlineMatch(),
        setName: (name) => { settings.set('player', 'name', String(name || '').toUpperCase().replace(/[^A-Z0-9 _\-.!]/g, '').slice(0, 16)); },
        startBot: (cfg) => game.startBot(cfg),
        startTraining: () => game.startTraining(),
        resume: () => { game.audio.resume(); game.input.requestLock(); },
        leaveMatch: () => game.leaveMatch(),
        rematch: () => game.rematch(),
        changeMap: () => game.changeMap(),
        mainMenu: () => game.toMainMenu(),
        quit: () => {
          game.toMainMenu();
          try { window.close(); } catch { /* ignore */ }
          setTimeout(() => game.ui.show('quit'), 120);
        },
        toggleFullscreen: () => game.toggleFullscreen(),
        isFullscreen: () => !!document.fullscreenElement,
        copyText: async (text) => {
          try { await navigator.clipboard.writeText(text); return true; } catch {
            try {
              const ta = document.createElement('textarea');
              ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
              document.body.appendChild(ta); ta.select();
              const ok = document.execCommand('copy');
              ta.remove();
              return ok;
            } catch { return false; }
          }
        },
        inviteLink: () => (game.net?.code ? inviteLink(game.net.code) : null),
        resetTrainingStats: () => game.mc?.resetTrainingStats(),
      },
    };
  }

  async toggleFullscreen() {
    try {
      if (document.fullscreenElement) { await document.exitFullscreen(); return; }
      await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
      // Keyboard Lock (Chrome/Edge) lets Ctrl/W/Tab reach the game in fullscreen. Hold Esc to exit.
      await navigator.keyboard?.lock?.(['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyC', 'KeyQ', 'KeyE', 'KeyR', 'KeyF', 'Tab', 'ControlLeft', 'Digit1', 'Digit2', 'Digit3', 'Space']).catch(() => {});
    } catch (e) {
      this.ui.toast('FULLSCREEN NOT AVAILABLE', 'error');
    }
  }

  // ================================================================== debug / automation API
  _installDebugApi() {
    const game = this;
    const vec = (v) => (v ? [Math.round(v.x * 100) / 100, Math.round(v.y * 100) / 100, Math.round(v.z * 100) / 100] : null);
    window.__mx = {
      game,
      version: VERSION,
      protocol: PROTOCOL_VERSION,
      state: () => game.state,
      code: () => game.net?.code || null,
      net: () => (game.net ? game.net.stats() : null),
      lobby: () => game.lobby,
      /** Drive inputs without pointer lock (tests). keys: action names; '!action' = one-shot press. */
      input: (obj) => { game.input.debugInput = obj ? { ...obj } : null; },
      press: (action) => { game.input.debugInput = game.input.debugInput || {}; game.input.debugInput['!' + action] = true; },
      aimAt: (x, y, z) => {
        const mc = game.mc;
        if (!mc) return false;
        const eye = mc.local.sim.eyePosition(new THREE.Vector3());
        const d = new THREE.Vector3(x, y, z).sub(eye).normalize();
        mc.local.sim.yaw = Math.atan2(-d.x, -d.z);
        mc.local.sim.pitch = Math.asin(Math.max(-1, Math.min(1, d.y)));
        mc.recoil.p = mc.recoil.y = 0;
        return true;
      },
      aimAtOpponent: (head = false) => {
        const mc = game.mc;
        const o = mc?._oppRenderState();
        if (!o) return false;
        return window.__mx.aimAt(o.pos.x, o.pos.y + (head ? o.height - 0.2 : o.height * 0.6), o.pos.z);
      },
      teleport: (x, y, z) => { const mc = game.mc; if (!mc) return false; mc.local.sim.pos.set(x, y, z); mc.local.sim.vel.set(0, 0, 0); return true; },
      view: () => {
        const mc = game.mc;
        if (!mc) return { state: game.state };
        const o = mc._oppRenderState();
        return {
          state: game.state, phase: mc.view.phase, me: mc.me, role: mc.role, mode: mc.mode,
          scores: [mc.view.ps[0].kills, mc.view.ps[1].kills], deaths: [mc.view.ps[0].deaths, mc.view.ps[1].deaths],
          hp: [mc.view.ps[0].hp, mc.view.ps[1].hp], ar: [mc.view.ps[0].ar, mc.view.ps[1].ar], en: [mc.view.ps[0].en, mc.view.ps[1].en],
          alive: [mc.view.ps[0].alive, mc.view.ps[1].alive], localAlive: mc.local.alive, winner: mc.view.winner, ended: mc.ended,
          pos: vec(mc.local.sim.pos), oppPos: vec(o?.pos), oppValid: !!o, weapon: mc.local.weapons.current, ammo: mc.local.weapons.ammo[mc.local.weapons.current],
          rematch: mc.rematchReq, ui: game.ui.current, timeText: mc.hud.timeText,
        };
      },
      actions: game.facade.actions,
      /** Test hook: override a match rule on this machine (only meaningful on the host). */
      setRule: (key, value) => { if (key in MATCH) { MATCH[key] = value; return true; } return false; },
    };
  }
}

export function friendlyNetError(msg) {
  switch (msg) {
    case 'ROOM_NOT_FOUND': return 'ROOM NOT FOUND';
    case 'ROOM_FULL': return 'ROOM IS FULL';
    case 'SIGNAL_UNREACHABLE': case 'SIGNAL_TIMEOUT': case 'SIGNAL_CLOSED': return "CAN'T REACH MATCHMAKING SERVER";
    case 'ice-failed': case 'connect-failed': return 'COULD NOT CONNECT (NAT/FIREWALL)';
    default: return String(msg || 'UNKNOWN ERROR').toUpperCase();
  }
}

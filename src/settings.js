// Persistent user settings with graphics presets. Stored in localStorage.

const STORAGE_KEY = 'monsterx-duel-settings-v2';

export const DEFAULT_BINDINGS = {
  forward: ['KeyW', 'ArrowUp'],
  back: ['KeyS', 'ArrowDown'],
  left: ['KeyA', 'ArrowLeft'],
  right: ['KeyD', 'ArrowRight'],
  jump: ['Space'],
  sprint: ['ShiftLeft', 'ShiftRight'],
  crouch: ['KeyC', 'ControlLeft'],
  fire: ['Mouse0'],
  ads: ['Mouse2'],
  reload: ['KeyR'],
  interact: ['KeyE'],
  slot1: ['Digit1'],
  slot2: ['Digit2'],
  slot3: ['Digit3'],
  nextWeapon: ['WheelDown'],
  prevWeapon: ['WheelUp'],
  melee: ['KeyQ', 'KeyV'],
  rush: ['KeyF'],
  scoreboard: ['Tab'],
  debug: ['F3'],
};

export const ACTION_LABELS = {
  forward: 'Move forward', back: 'Move backward', left: 'Strafe left', right: 'Strafe right',
  jump: 'Jump / mantle / wall kick', sprint: 'Sprint', crouch: 'Crouch / slide', fire: 'Fire',
  ads: 'Aim / alt fire', reload: 'Reload', interact: 'Interact / pick up', slot1: 'Primary weapon',
  slot2: 'Secondary weapon', slot3: 'Special weapon', nextWeapon: 'Next weapon', prevWeapon: 'Previous weapon',
  melee: 'Quick melee', rush: 'Energy Rush', scoreboard: 'Scoreboard', debug: 'Network debug panel',
};

export const PRESETS = {
  low: { renderScale: 0.75, shadows: 'off', textures: 'low', effects: 'low', antialias: 'off', bloom: true, ao: false, reflections: 'low', drawDistance: 'low', geometry: 'low', lighting: 'low' },
  medium: { renderScale: 1, shadows: 'low', textures: 'medium', effects: 'medium', antialias: 'fxaa', bloom: true, ao: false, reflections: 'low', drawDistance: 'medium', geometry: 'medium', lighting: 'medium' },
  high: { renderScale: 1, shadows: 'medium', textures: 'high', effects: 'high', antialias: 'smaa', bloom: true, ao: false, reflections: 'high', drawDistance: 'high', geometry: 'high', lighting: 'high' },
  ultra: { renderScale: 1, shadows: 'high', textures: 'high', effects: 'high', antialias: 'smaa', bloom: true, ao: true, reflections: 'high', drawDistance: 'high', geometry: 'high', lighting: 'high' },
};

function defaults() {
  return {
    version: 2,
    player: { name: '' },
    graphics: { preset: 'high', fpsLimit: 0, fov: 100, showFps: false, motionBlur: false, ...PRESETS.high },
    controls: {
      sensitivity: 2.0,
      adsSensitivity: 0.85,
      invertY: false,
      toggleAds: false,
      toggleCrouch: false,
      autoSwap: false,
      bindings: structuredClone(DEFAULT_BINDINGS),
    },
    crosshair: { style: 'cross', color: '#7dff1a', size: 7, thickness: 2, gap: 4, outline: true, dot: true, dynamic: true, opacity: 1 },
    camera: { headBob: 0.45, weaponSway: 1.0, screenShake: 0.6, landingDip: 0.7, recoilShake: 1.0, damageNumbers: true, killSlowmo: true, viewmodelFov: 72 },
    audio: { master: 0.8, music: 0.5, effects: 0.9, announcer: 0.9 },
    hud: { netIndicator: true, killfeed: true, hitSound: true },
  };
}

function merge(base, over) {
  if (!over || typeof over !== 'object') return base;
  for (const k of Object.keys(base)) {
    if (!(k in over)) continue;
    const bv = base[k], ov = over[k];
    if (bv && typeof bv === 'object' && !Array.isArray(bv)) base[k] = merge(bv, ov);
    else if (typeof ov === typeof bv || (Array.isArray(bv) && Array.isArray(ov))) base[k] = ov;
  }
  return base;
}

export function detectPreset() {
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (!gl) return 'low';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const r = (ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER)) || '';
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    if (/swiftshader|llvmpipe|software/i.test(r)) return 'low';
    if (/intel|mali|adreno|powervr/i.test(r)) return 'medium';
    if (/apple m[1-9]|rtx|radeon rx|geforce gtx 1[06-9]|rx [5-9]\d{3}/i.test(r)) return 'high';
    return 'high';
  } catch {
    return 'medium';
  }
}

class SettingsStore {
  constructor() {
    this.listeners = new Set();
    this.data = defaults();
    let loaded = null;
    try { loaded = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null'); } catch { loaded = null; }
    if (loaded) {
      merge(this.data, loaded);
      if (this.data.graphics.antialias === 'msaa') this.data.graphics.antialias = 'smaa'; // pre-1.0 setting
      // Make sure new actions get default bindings.
      for (const [k, v] of Object.entries(DEFAULT_BINDINGS)) {
        if (!Array.isArray(this.data.controls.bindings[k])) this.data.controls.bindings[k] = [...v];
      }
    } else {
      const p = detectPreset();
      this.applyPreset(p, false);
    }
  }

  get g() { return this.data.graphics; }

  applyPreset(name, notify = true) {
    const p = PRESETS[name];
    if (!p) return;
    Object.assign(this.data.graphics, p, { preset: name });
    if (notify) this.changed('graphics');
  }

  set(section, key, value) {
    this.data[section][key] = value;
    if (section === 'graphics' && key in PRESETS.high) this.data.graphics.preset = 'custom';
    this.changed(section, key);
  }

  changed(section, key) {
    this.save();
    for (const l of this.listeners) l(section, key, this.data);
  }

  onChange(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  save() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data)); } catch { /* private mode */ }
  }

  resetSection(section) {
    this.data[section] = defaults()[section];
    if (section === 'graphics') this.applyPreset(detectPreset(), false);
    this.changed(section);
  }
}

export const settings = new SettingsStore();

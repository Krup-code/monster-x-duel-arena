// MONSTER-X: DUEL ARENA - settings (tabbed) and the controls reference screen.
// Every control reads and writes through settings.set(section, key, value) so the game
// (listening via settings.onChange) applies it live.
import { ACTION_LABELS, DEFAULT_BINDINGS } from '../settings.js';
import { ENERGY, MOVE } from '../config.js';
import { codeLabel } from '../input.js';
import {
  el, setText, setAttr, setHidden, mxButton, setButtonLabel, pageShell, ICONS, keycap, bindingsFor, clamp,
} from './MainMenu.js';

const same = (a, b) => (typeof a === 'number' && typeof b === 'number' ? Math.abs(a - b) < 1e-4 : a === b);
const HEX_RE = /^#[0-9a-f]{6}$/i;
const pct = (v) => `${Math.round(v * 100)}%`;
const pctEdit = (v) => String(Math.round(v * 100));
const fromPct = (raw) => raw / 100;

const TABS = [
  { id: 'graphics', label: 'GRAPHICS', sections: ['graphics'] },
  { id: 'controls', label: 'CONTROLS', sections: ['controls'] },
  { id: 'crosshair', label: 'CROSSHAIR', sections: ['crosshair'] },
  { id: 'camera', label: 'CAMERA', sections: ['camera', 'hud'] },
  { id: 'audio', label: 'AUDIO', sections: ['audio'] },
];

const RENDER_SCALES = [0.5, 0.67, 0.75, 0.85, 1, 1.25];
const FPS_LIMITS = [0, 30, 60, 120, 144, 240];
const LMH = [{ value: 'low', label: 'LOW' }, { value: 'medium', label: 'MEDIUM' }, { value: 'high', label: 'HIGH' }];

export const CROSSHAIR_SWATCHES = [
  { id: 'acid', color: '#7dff1a' },
  { id: 'white', color: '#ffffff' },
  { id: 'red', color: '#ff2a1a' },
  { id: 'cyan', color: '#1ae8ff' },
  { id: 'yellow', color: '#ffe81a' },
  { id: 'orange', color: '#ff8a1f' },
];

const XH_ICON = {
  cross: '<path d="M12 2v6M12 16v6M2 12h6M16 12h6"/>',
  dot: '<circle cx="12" cy="12" r="2.6" fill="currentColor" stroke="none"/>',
  circle: '<circle cx="12" cy="12" r="7"/>',
  crossdot: '<path d="M12 2v6M12 16v6M2 12h6M16 12h6"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  chevron: '<path d="M5 19l7-7 7 7"/>',
};
const xhIcon = (k) => `<svg viewBox="0 0 24 24" class="mx-ico" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2">${XH_ICON[k]}</svg>`;

// ---------------------------------------------------------------------------------------
// Crosshair renderer (shared look rules with the HUD crosshair)
// ---------------------------------------------------------------------------------------

/**
 * Draw a crosshair centered at (cx, cy) device pixels. s = device pixels per CSS px.
 * Rules: arms of length `size` and width `thickness`, starting `gap` from the center;
 * circle = ring of radius gap + size; chevron = ^ just below the center; outline = 1px dark.
 */
export function drawCrosshair(ctx, cfg, cx, cy, s, spread = 0) {
  const style = cfg.style || 'cross';
  const t = clamp(+cfg.thickness || 1, 1, 5);
  const size = clamp(+cfg.size || 2, 2, 20);
  const gap = clamp(+cfg.gap || 0, 0, 14) + (cfg.dynamic ? Math.max(0, spread) : 0);
  const color = HEX_RE.test(cfg.color) ? cfg.color : '#7dff1a';
  const alpha = clamp(cfg.opacity == null ? 1 : +cfg.opacity, 0, 1);
  const dark = 'rgba(0,0,0,0.85)';
  const arms = style === 'cross' || style === 'crossdot';
  const dot = style === 'dot' || style === 'crossdot' || (cfg.dot && style !== 'dot');
  const dotR = style === 'dot' ? Math.max(1.5, t) : Math.max(1, t * 0.5 + 0.25);
  cx = Math.round(cx);
  cy = Math.round(cy);
  const R = (x, y, w, h) => {
    const x0 = Math.round(cx + x * s), y0 = Math.round(cy + y * s);
    ctx.fillRect(x0, y0, Math.max(1, Math.round(cx + (x + w) * s) - x0), Math.max(1, Math.round(cy + (y + h) * s) - y0));
  };
  ctx.save();
  ctx.globalAlpha = alpha;
  const passes = cfg.outline ? 2 : 1;
  for (let pass = 0; pass < passes; pass++) {
    const outlinePass = cfg.outline && pass === 0;
    const g = outlinePass ? 1 : 0;
    ctx.fillStyle = outlinePass ? dark : color;
    ctx.strokeStyle = outlinePass ? dark : color;
    if (arms) {
      const h = t / 2;
      R(gap - g, -h - g, size + 2 * g, t + 2 * g); // right
      R(-gap - size - g, -h - g, size + 2 * g, t + 2 * g); // left
      R(-h - g, gap - g, t + 2 * g, size + 2 * g); // down
      R(-h - g, -gap - size - g, t + 2 * g, size + 2 * g); // up
    }
    if (style === 'circle') {
      ctx.lineWidth = (t + 2 * g) * s;
      ctx.beginPath();
      ctx.arc(cx, cy, (gap + size) * s, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (style === 'chevron') {
      const top = gap * 0.6 + 1;
      const w = size;
      ctx.lineWidth = (t + 2 * g) * s;
      ctx.lineJoin = 'miter';
      ctx.lineCap = outlinePass ? 'square' : 'butt';
      ctx.beginPath();
      ctx.moveTo(cx - w * s, cy + (top + w * 0.8) * s);
      ctx.lineTo(cx, cy + top * s);
      ctx.lineTo(cx + w * s, cy + (top + w * 0.8) * s);
      ctx.stroke();
    }
    if (dot) {
      ctx.beginPath();
      ctx.arc(cx, cy, (dotR + g) * s, 0, Math.PI * 2);
      ctx.fill();
    }
  }
  ctx.restore();
}

// ---------------------------------------------------------------------------------------
// Settings screen
// ---------------------------------------------------------------------------------------

export class SettingsScreen {
  constructor(ui, game) {
    this.ui = ui;
    this.game = game;
    this.S = game.settings;
    this.syncers = [];
    this.visible = false;
    this.dirty = false;
    this.tab = 'graphics';
    this.capture = null;
    this.capToken = 0;
    this.resetArmed = false;
    this.resetTimer = 0;

    const p = pageShell('settings', { kicker: 'SYSTEM', title: 'SETTINGS', sub: 'Changes apply instantly and are saved in this browser.', onBack: () => ui.back() });
    this.el = p.root;

    // Tabs
    this.tabBtns = {};
    this.panes = {};
    const tabs = el('div', { class: 'mx-tabs', role: 'tablist', 'aria-label': 'Settings sections' });
    TABS.forEach((t, i) => {
      const b = el('button', { type: 'button', class: 'mx-tab', role: 'tab', 'aria-selected': 'false', id: `mx-tab-${t.id}` }, [
        el('span', { class: 'mx-tab__idx', text: String(i + 1).padStart(2, '0') }),
        el('span', { class: 'mx-tab__label', text: t.label }),
      ]);
      b.addEventListener('click', () => this.setTab(t.id));
      b.addEventListener('keydown', (e) => {
        if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          e.preventDefault();
          const next = TABS[(i + (e.key === 'ArrowRight' ? 1 : TABS.length - 1)) % TABS.length];
          this.setTab(next.id);
          this.tabBtns[next.id].focus();
        }
      });
      this.tabBtns[t.id] = b;
      tabs.append(b);
    });
    this.scroller = el('div', { class: 'mx-settings__scroll' });
    for (const t of TABS) {
      const pane = el('div', { class: `mx-pane mx-pane--${t.id}`, role: 'tabpanel', 'aria-labelledby': `mx-tab-${t.id}`, hidden: true });
      this.panes[t.id] = pane;
      this.scroller.append(pane);
    }
    p.body.append(el('div', { class: 'mx-settings' }, [tabs, this.scroller]));

    this.resetBtn = mxButton({ label: 'RESET GRAPHICS', variant: 'ghost small', sound: 'back', cls: 'mx-reset', onClick: () => this._reset() });
    p.foot.append(el('span', { class: 'mx-page__grow' }), this.resetBtn);

    this._buildGraphics(this.panes.graphics);
    this._buildControls(this.panes.controls);
    this._buildCrosshair(this.panes.crosshair);
    this._buildCamera(this.panes.camera);
    this._buildAudio(this.panes.audio);

    this.S.onChange((section) => {
      if (this.visible) this._sync(section);
      else this.dirty = true;
    });
    window.addEventListener('resize', () => {
      if (this.visible) this._updateResLabels();
    });
    this.setTab(this.tab);
  }

  // ----- binding helpers -----

  _b(section, key) {
    const S = this.S;
    return { section, get: () => S.data[section][key], set: (v) => S.set(section, key, v) };
  }

  _reg(section, sync) {
    this.syncers.push({ section, sync });
    sync();
  }

  _sync(section) {
    for (const s of this.syncers) if (!section || s.section === section || s.section === '*') s.sync();
    if (!section || section === 'crosshair') this._xhDirty = true;
  }

  // ----- control factories -----

  _row(label, control, note) {
    return el('div', { class: 'mx-row' }, [
      el('div', { class: 'mx-row__label' }, [
        el('span', { class: 'mx-row__name', text: label }),
        note ? el('span', { class: 'mx-row__note', text: note }) : null,
      ]),
      el('div', { class: 'mx-row__ctl' }, control),
    ]);
  }

  _group(title, children, note) {
    return el('div', { class: 'mx-group' }, [
      el('h3', { class: 'mx-group__title' }, [el('span', { text: title }), note ? el('span', { class: 'mx-group__note', text: note }) : null]),
      ...children,
    ]);
  }

  _seg(b, options, o = {}) {
    const wrap = el('div', { class: `mx-seg${o.grid ? ' mx-seg--grid' : ''}`, role: 'radiogroup', 'aria-label': o.label || '' });
    const btns = options.map((opt) => {
      const main = el('span', { class: 'mx-seg__main' });
      if (opt.icon) main.innerHTML = opt.icon;
      main.append(el('span', { text: opt.label }));
      const btn = el('button', { type: 'button', class: 'mx-seg__opt', role: 'radio', 'aria-checked': 'false' }, [main]);
      if (opt.sub != null) {
        btn.__sub = el('span', { class: 'mx-seg__sub', text: opt.sub });
        btn.append(btn.__sub);
      }
      btn.__label = main.lastChild;
      btn.addEventListener('click', () => {
        if (!same(b.get(), opt.value)) b.set(opt.value);
      });
      wrap.append(btn);
      return btn;
    });
    let shown = {};
    this._reg(b.section, () => {
      const v = b.get();
      if (same(v, shown)) return;
      shown = v;
      for (let i = 0; i < btns.length; i++) {
        const on = same(options[i].value, v);
        btns[i].classList.toggle('is-on', on);
        setAttr(btns[i], 'aria-checked', on ? 'true' : 'false');
      }
    });
    wrap.__btns = btns;
    return wrap;
  }

  _toggle(b, o = {}) {
    const label = el('span', { class: 'mx-switch__label' });
    const btn = el('button', { type: 'button', class: 'mx-switch', role: 'switch', 'aria-checked': 'false', 'aria-label': o.label || '' }, [
      el('span', { class: 'mx-switch__track', 'aria-hidden': 'true' }, [el('span', { class: 'mx-switch__knob' })]),
      label,
    ]);
    btn.addEventListener('click', () => b.set(!b.get()));
    let shown;
    this._reg(b.section, () => {
      const v = !!b.get();
      if (v === shown) return;
      shown = v;
      btn.classList.toggle('is-on', v);
      setAttr(btn, 'aria-checked', v ? 'true' : 'false');
      setText(label, v ? o.on || 'ON' : o.off || 'OFF');
    });
    return btn;
  }

  /** o: { min, max, step, label, fmt(v), edit(v), parse(raw), release(v) } */
  _slider(b, o) {
    const { min, max, step } = o;
    const dec = (String(step).split('.')[1] || '').length;
    const snap = (v) => +clamp(Math.round((v - min) / step) * step + min, min, max).toFixed(dec);
    const fmt = o.fmt || ((v) => v.toFixed(dec));
    const range = el('input', { type: 'range', class: 'mx-range', min, max, step, 'aria-label': o.label || '' });
    const out = el('input', { type: 'text', class: 'mx-range__val', inputmode: 'decimal', spellcheck: 'false', autocomplete: 'off', 'aria-label': `${o.label || ''} value`, 'data-esc': 'blur' });
    let shown = NaN;
    let pending = null;
    let raf = 0;
    const paint = (v) => {
      range.style.setProperty('--p', ((v - min) / (max - min)).toFixed(4));
      if (document.activeElement !== out) {
        const f = fmt(v);
        if (out.value !== f) out.value = f;
      }
    };
    const flush = () => {
      raf = 0;
      if (pending === null) return;
      const v = pending;
      pending = null;
      if (!same(b.get(), v)) b.set(v);
    };
    range.addEventListener('input', () => {
      const v = snap(+range.value);
      shown = v;
      paint(v);
      pending = v;
      if (!raf) raf = requestAnimationFrame(flush);
    });
    range.addEventListener('change', () => {
      if (raf) cancelAnimationFrame(raf);
      flush();
      if (o.release) o.release(shown);
    });
    out.addEventListener('focus', () => {
      out.value = o.edit ? o.edit(shown) : String(shown);
      out.select();
    });
    out.addEventListener('change', () => {
      const raw = parseFloat(String(out.value).replace(',', '.').replace(/[^0-9.-]/g, ''));
      let v = o.parse ? o.parse(raw) : raw;
      if (!Number.isFinite(v)) return;
      v = snap(v);
      shown = v;
      range.value = String(v);
      paint(v);
      if (!same(b.get(), v)) b.set(v);
      if (o.release) o.release(v);
    });
    out.addEventListener('blur', () => {
      out.value = fmt(shown);
    });
    out.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        out.blur();
      }
    });
    this._reg(b.section, () => {
      const v = +b.get();
      if (pending !== null || same(v, shown)) return;
      shown = v;
      range.value = String(v);
      paint(v);
    });
    return el('div', { class: 'mx-slider' }, [range, out]);
  }

  _info(text) {
    return el('span', { class: 'mx-row__info', text });
  }

  // ----- tabs -----

  setTab(id) {
    if (!this.panes[id]) id = 'graphics';
    if (this.capture) this._cancelCapture();
    this.tab = id;
    for (const t of TABS) {
      const on = t.id === id;
      this.tabBtns[t.id].classList.toggle('is-on', on);
      setAttr(this.tabBtns[t.id], 'aria-selected', on ? 'true' : 'false');
      setAttr(this.tabBtns[t.id], 'tabindex', on ? '0' : '-1');
      setHidden(this.panes[t.id], !on);
    }
    const tab = TABS.find((t) => t.id === id);
    this._disarmReset();
    setButtonLabel(this.resetBtn, `RESET ${tab.label}`);
    this.scroller.scrollTop = 0;
    const pane = this.panes[id];
    pane.classList.remove('is-enter');
    void pane.offsetWidth;
    pane.classList.add('is-enter');
    this._xhSetRunning(this.visible && id === 'crosshair');
  }

  _disarmReset() {
    clearTimeout(this.resetTimer);
    this.resetArmed = false;
    this.resetBtn.classList.remove('is-armed');
    const tab = TABS.find((t) => t.id === this.tab);
    setButtonLabel(this.resetBtn, `RESET ${tab.label}`);
  }

  _reset() {
    const tab = TABS.find((t) => t.id === this.tab);
    if (!this.resetArmed) {
      this.resetArmed = true;
      this.resetBtn.classList.add('is-armed');
      setButtonLabel(this.resetBtn, 'CLICK AGAIN TO CONFIRM');
      clearTimeout(this.resetTimer);
      this.resetTimer = setTimeout(() => this._disarmReset(), 3200);
      return;
    }
    this._disarmReset();
    if (this.capture) this._cancelCapture();
    for (const s of tab.sections) this.S.resetSection(s);
    this._sync();
    this.ui.toast(`${tab.label} RESET TO DEFAULTS`, 'success');
  }

  // ----- GRAPHICS -----

  _buildGraphics(pane) {
    const S = this.S;
    const g = (k) => this._b('graphics', k);

    // Preset buttons: performance (low/medium) + quality (high/ultra).
    const presetBtns = [];
    const mk = (name, sub) => {
      const btn = el('button', { type: 'button', class: 'mx-seg__opt', role: 'radio', 'aria-checked': 'false' }, [
        el('span', { class: 'mx-seg__main', text: name.toUpperCase() }),
        el('span', { class: 'mx-seg__sub', text: sub }),
      ]);
      btn.__id = name;
      btn.addEventListener('click', () => S.applyPreset(name));
      presetBtns.push(btn);
      return btn;
    };
    const customPill = el('span', { class: 'mx-pill' });
    const presets = el('div', { class: 'mx-presets' }, [
      el('div', { class: 'mx-presets__grp' }, [el('span', { class: 'mx-presets__cap', text: 'PERFORMANCE' }), el('div', { class: 'mx-seg', role: 'radiogroup' }, [mk('low', 'MAX FPS'), mk('medium', 'BALANCED')])]),
      el('div', { class: 'mx-presets__grp' }, [el('span', { class: 'mx-presets__cap', text: 'QUALITY' }), el('div', { class: 'mx-seg', role: 'radiogroup' }, [mk('high', 'SHARP'), mk('ultra', 'SHOWCASE')])]),
      customPill,
    ]);
    this._reg('graphics', () => {
      const p = S.data.graphics.preset;
      for (const b of presetBtns) {
        const on = b.__id === p;
        b.classList.toggle('is-on', on);
        setAttr(b, 'aria-checked', on ? 'true' : 'false');
      }
      customPill.classList.toggle('is-on', p === 'custom');
      setText(customPill, p === 'custom' ? 'CUSTOM' : `PRESET · ${String(p).toUpperCase()}`);
    });

    // Resolution (render scale) with live pixel sizes.
    this.resSeg = this._seg(g('renderScale'), RENDER_SCALES.map((v) => ({ value: v, label: '', sub: `${Math.round(v * 100)}%` })), { grid: true, label: 'Resolution' });
    this._updateResLabels();

    const fsBind = { section: '*fs', get: () => this.ui.isFullscreen(), set: () => this.ui.act('toggleFullscreen') };

    pane.append(
      this._group('QUALITY PRESET', [
        this._row('Preset', presets, 'Auto-detected for your GPU on first launch. Changing an option below switches to CUSTOM.'),
      ]),
      this._group('DISPLAY', [
        this._row('Resolution', this.resSeg, 'Internal render resolution. Lower = more FPS.'),
        this._row('Fullscreen', this._toggle(fsBind, { label: 'Fullscreen' })),
        this._row('VSync', this._info('Always on — browsers present in sync with the display')),
        this._row('Field of view', this._slider(g('fov'), { min: 70, max: 120, step: 1, label: 'Field of view', fmt: (v) => `${Math.round(v)}°` }), 'Horizontal-feel FOV. Default 100.'),
        this._row('FPS limit', this._seg(g('fpsLimit'), FPS_LIMITS.map((v) => ({ value: v, label: v === 0 ? 'UNLIMITED' : String(v) })), { label: 'FPS limit' })),
        this._row('Show FPS', this._toggle(g('showFps'), { label: 'Show FPS' })),
      ]),
      this._group('RENDERING', [
        this._row('Texture quality', this._seg(g('textures'), LMH, { label: 'Texture quality' }), 'Applies on next map load'),
        this._row('Shadow quality', this._seg(g('shadows'), [{ value: 'off', label: 'OFF' }, ...LMH], { label: 'Shadow quality' })),
        this._row('Effects quality', this._seg(g('effects'), LMH, { label: 'Effects quality' }), 'Particles, sparks, decals'),
        this._row('Anti-aliasing', this._seg(g('antialias'), [{ value: 'off', label: 'OFF' }, { value: 'fxaa', label: 'FXAA' }, { value: 'smaa', label: 'SMAA' }], { label: 'Anti-aliasing' })),
        this._row('Reflections', this._seg(g('reflections'), [{ value: 'low', label: 'LOW' }, { value: 'high', label: 'HIGH' }], { label: 'Reflections' })),
        this._row('Draw distance', this._seg(g('drawDistance'), LMH, { label: 'Draw distance' })),
        this._row('Geometry detail', this._seg(g('geometry'), LMH, { label: 'Geometry detail' }), 'Applies on next map load'),
        this._row('Lighting', this._seg(g('lighting'), LMH, { label: 'Lighting' }), 'Applies on next map load'),
      ]),
      this._group('POST PROCESSING', [
        this._row('Bloom', this._toggle(g('bloom'), { label: 'Bloom' }), 'Neon glow on lights and energy'),
        this._row('Motion blur', this._toggle(g('motionBlur'), { label: 'Motion blur' })),
        this._row('Ambient occlusion', this._toggle(g('ao'), { label: 'Ambient occlusion' }), 'Contact shadows. Costly on laptops.'),
      ]),
    );
  }

  _updateResLabels() {
    if (!this.resSeg) return;
    const dpr = window.devicePixelRatio || 1;
    const w = window.innerWidth * dpr;
    const h = window.innerHeight * dpr;
    this.resSeg.__btns.forEach((btn, i) => {
      const s = RENDER_SCALES[i];
      setText(btn.__label, `${Math.round(w * s)}×${Math.round(h * s)}`);
      setAttr(btn, 'aria-label', `${Math.round(w * s)}×${Math.round(h * s)} (${Math.round(s * 100)}%)`);
    });
  }

  // ----- CONTROLS -----

  _buildControls(pane) {
    const c = (k) => this._b('controls', k);
    pane.append(
      this._group('MOUSE', [
        this._row('Mouse sensitivity', this._slider(c('sensitivity'), { min: 0.1, max: 10, step: 0.05, label: 'Mouse sensitivity', fmt: (v) => v.toFixed(2) })),
        this._row('ADS sensitivity', this._slider(c('adsSensitivity'), { min: 0.2, max: 1.5, step: 0.05, label: 'ADS sensitivity', fmt: (v) => `${v.toFixed(2)}×` }), 'Multiplier while aiming down sights'),
        this._row('Invert mouse Y', this._toggle(c('invertY'), { label: 'Invert mouse Y' })),
      ]),
      this._group('BEHAVIOR', [
        this._row('Aim down sights', this._toggle(c('toggleAds'), { label: 'Toggle ADS', on: 'TOGGLE', off: 'HOLD' })),
        this._row('Crouch', this._toggle(c('toggleCrouch'), { label: 'Toggle crouch', on: 'TOGGLE', off: 'HOLD' })),
        this._row('Auto-swap weapons', this._toggle(c('autoSwap'), { label: 'Auto-swap weapons' }), 'Swap automatically when walking over a weapon'),
      ]),
    );

    // Key bindings
    this.bindRows = [];
    const list = el('div', { class: 'mx-binds' });
    for (const action of Object.keys(ACTION_LABELS)) {
      const slots = [0, 1].map((i) => {
        const b = el('button', { type: 'button', class: 'mx-keyslot', 'aria-label': `${ACTION_LABELS[action]} binding ${i + 1}` });
        b.addEventListener('click', () => this._startCapture(action, i, b));
        return b;
      });
      const row = el('div', { class: 'mx-bind' }, [
        el('span', { class: 'mx-bind__label', text: ACTION_LABELS[action] }),
        el('span', { class: 'mx-bind__warn', text: 'UNBOUND' }),
        el('span', { class: 'mx-bind__slots' }, slots),
      ]);
      this.bindRows.push({ action, row, slots });
      list.append(row);
    }
    this._reg('controls', () => this._syncBindings());

    const resetBinds = mxButton({ label: 'RESET TO DEFAULTS', variant: 'ghost small', sound: 'back', onClick: () => {
      this._cancelCapture();
      this.S.set('controls', 'bindings', structuredClone(DEFAULT_BINDINGS));
      this.ui.toast('KEY BINDINGS RESET TO DEFAULTS', 'success');
    } });
    pane.append(this._group('KEY BINDINGS', [
      el('div', { class: 'mx-binds__head' }, [
        el('p', { class: 'mx-binds__hint' }, [
          'Click a slot, then press a key or mouse button. ',
          el('kbd', { class: 'mx-key', text: 'ESC' }), ' cancels · ',
          el('kbd', { class: 'mx-key mx-key--wide', text: 'BACKSPACE' }), ' clears.',
        ]),
        resetBinds,
      ]),
      list,
    ]));
  }

  _syncBindings() {
    const B = this.S.data.controls.bindings;
    for (const r of this.bindRows) {
      const codes = Array.isArray(B[r.action]) ? B[r.action] : [];
      for (let i = 0; i < 2; i++) {
        const slot = r.slots[i];
        if (this.capture && this.capture.btn === slot) continue;
        const code = codes[i];
        setText(slot, code ? codeLabel(code) : '—');
        slot.classList.toggle('is-empty', !code);
      }
      r.row.classList.toggle('is-unbound', codes.length === 0);
    }
  }

  _startCapture(action, idx, btn) {
    if (this.capture) {
      const same = this.capture.btn === btn;
      this._cancelCapture();
      if (same) return;
    }
    const token = ++this.capToken;
    this.capture = { action, idx, btn };
    btn.classList.add('is-listening');
    setText(btn, 'PRESS A KEY…');
    this.el.classList.add('is-capturing');
    this.ui.capturing = true;
    this.game.input.captureNext((code) => {
      if (token !== this.capToken) return;
      this._endCapture();
      if (code && (code.startsWith('Mouse') || code.startsWith('Wheel'))) this._swallowNextClick();
      if (code == null) return;
      if (code === 'Backspace' || code === 'Delete') this._clearSlot(action, idx);
      else this._assign(action, idx, code);
    });
  }

  _endCapture() {
    const c = this.capture;
    this.capture = null;
    this.ui.capturing = false;
    this.el.classList.remove('is-capturing');
    if (c) c.btn.classList.remove('is-listening');
    this._syncBindings();
  }

  _cancelCapture() {
    if (!this.capture) return;
    this.capToken++;
    try { this.game.input.captureNext(null); } catch { /* ignore */ }
    this._endCapture();
  }

  /** A mouse button that was just bound must not also click whatever is under the pointer. */
  _swallowNextClick() {
    const kill = (e) => {
      e.preventDefault();
      e.stopPropagation();
    };
    const opts = { capture: true };
    window.addEventListener('click', kill, opts);
    window.addEventListener('auxclick', kill, opts);
    window.addEventListener('contextmenu', kill, opts);
    setTimeout(() => {
      window.removeEventListener('click', kill, opts);
      window.removeEventListener('auxclick', kill, opts);
      window.removeEventListener('contextmenu', kill, opts);
    }, 450);
  }

  _clearSlot(action, idx) {
    const B = structuredClone(this.S.data.controls.bindings);
    const arr = Array.isArray(B[action]) ? B[action].slice(0, 2) : [];
    if (idx < arr.length) arr.splice(idx, 1);
    B[action] = arr;
    this.S.set('controls', 'bindings', B);
  }

  _assign(action, idx, code) {
    const B = structuredClone(this.S.data.controls.bindings);
    let moved = null;
    for (const a of Object.keys(B)) {
      if (a === action || !Array.isArray(B[a])) continue;
      const i = B[a].indexOf(code);
      if (i >= 0) {
        B[a].splice(i, 1);
        moved = a;
      }
    }
    const arr = Array.isArray(B[action]) ? B[action].slice(0, 2) : [];
    const dup = arr.indexOf(code);
    if (dup >= 0) arr.splice(dup, 1);
    if (idx >= arr.length) arr.push(code);
    else arr[idx] = code;
    B[action] = arr.slice(0, 2);
    this.S.set('controls', 'bindings', B);
    if (moved) {
      const left = B[moved].length === 0 ? ' — NOW UNBOUND' : '';
      this.ui.toast(`${codeLabel(code)} MOVED FROM ${String(ACTION_LABELS[moved] || moved).toUpperCase()}${left}`, left ? 'error' : 'info', 3200);
    }
  }

  // ----- CROSSHAIR -----

  _buildCrosshair(pane) {
    const S = this.S;
    const x = (k) => this._b('crosshair', k);

    const style = this._seg(x('style'), [
      { value: 'cross', label: 'CROSS', icon: xhIcon('cross') },
      { value: 'dot', label: 'DOT', icon: xhIcon('dot') },
      { value: 'circle', label: 'CIRCLE', icon: xhIcon('circle') },
      { value: 'crossdot', label: 'CROSS+DOT', icon: xhIcon('crossdot') },
      { value: 'chevron', label: 'CHEVRON', icon: xhIcon('chevron') },
    ], { label: 'Crosshair style' });
    style.classList.add('mx-seg--icons');

    // Color: picker + hex field + swatches
    const picker = el('input', { type: 'color', class: 'mx-color', 'aria-label': 'Crosshair color' });
    const hex = el('input', { type: 'text', class: 'mx-hex', maxlength: '7', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Crosshair color hex', 'data-esc': 'blur' });
    let colorRaf = 0;
    let colorPending = null;
    const setColor = (c) => {
      colorPending = c.toLowerCase();
      if (!colorRaf) colorRaf = requestAnimationFrame(() => {
        colorRaf = 0;
        if (colorPending && colorPending !== S.data.crosshair.color) S.set('crosshair', 'color', colorPending);
        colorPending = null;
      });
    };
    picker.addEventListener('input', () => setColor(picker.value));
    hex.addEventListener('change', () => {
      let v = hex.value.trim();
      if (!v.startsWith('#')) v = '#' + v;
      if (/^#[0-9a-f]{3}$/i.test(v)) v = '#' + v[1] + v[1] + v[2] + v[2] + v[3] + v[3];
      if (HEX_RE.test(v)) S.set('crosshair', 'color', v.toLowerCase());
      else hex.value = S.data.crosshair.color;
    });
    hex.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); hex.blur(); } });
    const swatches = CROSSHAIR_SWATCHES.map((sw) => {
      const b = el('button', { type: 'button', class: 'mx-swatch', 'aria-label': `${sw.id} crosshair`, title: sw.id.toUpperCase() });
      b.style.setProperty('--c', sw.color);
      b.__c = sw.color;
      b.addEventListener('click', () => S.set('crosshair', 'color', sw.color));
      return b;
    });
    this._reg('crosshair', () => {
      const c = HEX_RE.test(S.data.crosshair.color) ? S.data.crosshair.color.toLowerCase() : '#7dff1a';
      if (picker.value !== c) picker.value = c;
      if (document.activeElement !== hex && hex.value !== c.toUpperCase()) hex.value = c.toUpperCase();
      for (const b of swatches) b.classList.toggle('is-on', b.__c === c);
    });
    const color = el('div', { class: 'mx-colorrow' }, [el('label', { class: 'mx-colorpick' }, [picker]), hex, el('div', { class: 'mx-swatches' }, swatches)]);

    const controls = el('div', { class: 'mx-xh__controls' }, [
      this._group('STYLE', [
        this._row('Shape', style),
        this._row('Color', color),
      ]),
      this._group('SHAPE', [
        this._row('Size', this._slider(x('size'), { min: 2, max: 20, step: 1, label: 'Crosshair size', fmt: (v) => `${v}px` }), 'Arm length'),
        this._row('Thickness', this._slider(x('thickness'), { min: 1, max: 5, step: 1, label: 'Crosshair thickness', fmt: (v) => `${v}px` })),
        this._row('Gap', this._slider(x('gap'), { min: 0, max: 14, step: 1, label: 'Crosshair gap', fmt: (v) => `${v}px` }), 'Distance from center'),
        this._row('Opacity', this._slider(x('opacity'), { min: 0.1, max: 1, step: 0.05, label: 'Crosshair opacity', fmt: pct, edit: pctEdit, parse: fromPct })),
      ]),
      this._group('OPTIONS', [
        this._row('Outline', this._toggle(x('outline'), { label: 'Crosshair outline' }), '1px dark edge for bright backgrounds'),
        this._row('Center dot', this._toggle(x('dot'), { label: 'Center dot' })),
        this._row('Dynamic spread', this._toggle(x('dynamic'), { label: 'Dynamic spread' }), 'Opens up while moving and firing'),
      ]),
    ]);

    // Live preview
    this.xhCanvas = el('canvas', { class: 'mx-xh__canvas', 'aria-hidden': 'true' });
    this.xhBox = el('div', { class: 'mx-xh__box', dataset: { bg: 'dark' } }, [
      el('span', { class: 'mx-xh__grid', 'aria-hidden': 'true' }),
      this.xhCanvas,
      (this.xhFire = el('span', { class: 'mx-xh__fire', text: 'SIMULATED FIRE' })),
    ]);
    this.xhZoom = 1;
    const zoomBtns = [1, 2, 4].map((z) => {
      const b = el('button', { type: 'button', class: 'mx-chip', text: `${z}×`, 'aria-label': `Zoom ${z}x` });
      b.addEventListener('click', () => {
        this.xhZoom = z;
        for (const o of zoomBtns) o.classList.toggle('is-on', o === b);
        this._xhDirty = true;
      });
      if (z === 1) b.classList.add('is-on');
      return b;
    });
    const bgBtns = [['dark', 'DARK'], ['concrete', 'BRIGHT'], ['neon', 'ARENA']].map(([id, label]) => {
      const b = el('button', { type: 'button', class: 'mx-chip', text: label });
      b.addEventListener('click', () => {
        this.xhBox.dataset.bg = id;
        for (const o of bgBtns) o.classList.toggle('is-on', o === b);
      });
      if (id === 'dark') b.classList.add('is-on');
      return b;
    });
    const preview = el('div', { class: 'mx-xh__preview' }, [
      el('div', { class: 'mx-xh__head' }, [el('span', { class: 'mx-group__title', text: 'LIVE PREVIEW' })]),
      this.xhBox,
      el('div', { class: 'mx-xh__chips' }, [el('span', { class: 'mx-xh__cap', text: 'ZOOM' }), ...zoomBtns]),
      el('div', { class: 'mx-xh__chips' }, [el('span', { class: 'mx-xh__cap', text: 'BACKDROP' }), ...bgBtns]),
    ]);

    pane.append(el('div', { class: 'mx-xh' }, [controls, preview]));

    this._xhDirty = true;
    this._xhRunning = false;
    this._xhRaf = 0;
    this._xhW = 0;
    this._xhH = 0;
    this._xhFrame = (now) => this._xhTick(now);
    if (typeof ResizeObserver !== 'undefined') {
      this._xhRO = new ResizeObserver(() => { this._xhDirty = true; });
      this._xhRO.observe(this.xhBox);
    }
  }

  _xhSetRunning(on) {
    if (on === this._xhRunning) return;
    this._xhRunning = on;
    if (on) {
      this._xhDirty = true;
      this._xhRaf = requestAnimationFrame(this._xhFrame);
    } else if (this._xhRaf) {
      cancelAnimationFrame(this._xhRaf);
      this._xhRaf = 0;
    }
  }

  _xhTick(now) {
    if (!this._xhRunning) return;
    this._xhRaf = requestAnimationFrame(this._xhFrame);
    const cfg = this.S.data.crosshair;
    const dyn = !!cfg.dynamic;
    this.xhFire.classList.toggle('is-on', dyn);
    if (!dyn && !this._xhDirty) return;
    const box = this.xhBox;
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(box.clientWidth * dpr));
    const h = Math.max(1, Math.round(box.clientHeight * dpr));
    const c = this.xhCanvas;
    if (w !== this._xhW || h !== this._xhH) {
      this._xhW = w;
      this._xhH = h;
      c.width = w;
      c.height = h;
    }
    let spread = 0;
    if (dyn) {
      // Simulated 4-round burst every 1.8 s: quick bloom, smooth recovery.
      const ph = (now % 1800) / 1800;
      const k = ph < 0.22 ? Math.sin((ph / 0.22) * Math.PI * 0.5) : Math.max(0, 1 - (ph - 0.22) / 0.45);
      spread = 8 * k * k;
    }
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, w, h);
    drawCrosshair(ctx, cfg, w / 2, h / 2, dpr * this.xhZoom, spread);
    this._xhDirty = false;
  }

  // ----- CAMERA (+ HUD) -----

  _buildCamera(pane) {
    const c = (k) => this._b('camera', k);
    const hud = (k) => this._b('hud', k);
    pane.append(
      el('div', { class: 'mx-callout' }, [el('span', { class: 'mx-callout__icon', html: ICONS.warn }), el('span', { text: 'Reduce these if you get motion sick.' })]),
      this._group('CAMERA FEEL', [
        this._row('Head bob', this._slider(c('headBob'), { min: 0, max: 1, step: 0.05, label: 'Head bob', fmt: pct, edit: pctEdit, parse: fromPct })),
        this._row('Weapon sway', this._slider(c('weaponSway'), { min: 0, max: 2, step: 0.05, label: 'Weapon sway', fmt: pct, edit: pctEdit, parse: fromPct })),
        this._row('Screen shake', this._slider(c('screenShake'), { min: 0, max: 1, step: 0.05, label: 'Screen shake', fmt: pct, edit: pctEdit, parse: fromPct })),
        this._row('Landing dip', this._slider(c('landingDip'), { min: 0, max: 1, step: 0.05, label: 'Landing dip', fmt: pct, edit: pctEdit, parse: fromPct })),
        this._row('Recoil camera response', this._slider(c('recoilShake'), { min: 0, max: 1.5, step: 0.05, label: 'Recoil camera response', fmt: pct, edit: pctEdit, parse: fromPct }), 'Visual kick only — spread is unchanged'),
        this._row('Viewmodel FOV', this._slider(c('viewmodelFov'), { min: 55, max: 90, step: 1, label: 'Viewmodel FOV', fmt: (v) => `${Math.round(v)}°` }), 'How large your weapon appears'),
      ]),
      this._group('FEEDBACK', [
        this._row('Damage numbers', this._toggle(c('damageNumbers'), { label: 'Damage numbers' })),
        this._row('Kill slow-motion', this._toggle(c('killSlowmo'), { label: 'Kill slow-motion' }), 'Brief slow-mo on the final elimination'),
      ]),
      this._group('HUD', [
        this._row('Network indicator', this._toggle(hud('netIndicator'), { label: 'Network indicator' }), 'Ping and packet loss, top-right'),
        this._row('Kill feed', this._toggle(hud('killfeed'), { label: 'Kill feed' })),
        this._row('Hit sound', this._toggle(hud('hitSound'), { label: 'Hit sound' })),
      ]),
    );
  }

  // ----- AUDIO -----

  _buildAudio(pane) {
    const a = (k) => this._b('audio', k);
    const ping = (bus) => () => {
      try { this.game.audio.play('ui_hover', { bus }); } catch { /* audio not ready */ }
    };
    const vol = (key, label, bus, note) => this._row(label, this._slider(a(key), {
      min: 0, max: 1, step: 0.01, label, fmt: pct, edit: pctEdit, parse: fromPct, release: ping(bus),
    }), note);
    pane.append(this._group('VOLUME', [
      vol('master', 'Master', 'ui'),
      vol('music', 'Music', 'ui', 'Menu and match soundtrack'),
      vol('effects', 'Effects', 'sfx', 'Weapons, footsteps, impacts'),
      vol('announcer', 'Announcer', 'announcer', 'FIRST BLOOD, MATCH POINT …'),
    ]));
  }

  // ----- lifecycle -----

  onShow(data) {
    this.visible = true;
    if (data && data.tab && this.panes[data.tab]) this.setTab(data.tab);
    if (this.dirty) {
      this.dirty = false;
      this._sync();
    } else this._sync('*fs');
    this._updateResLabels();
    this._disarmReset();
    this._xhSetRunning(this.tab === 'crosshair');
  }

  onHide() {
    this.visible = false;
    this._cancelCapture();
    this._disarmReset();
    this._xhSetRunning(false);
  }

  onFullscreen() {
    this._sync('*fs');
  }

  onBack() {
    // Esc while listening for a key is consumed by the capture itself.
    if (this.capture) return true;
    return false;
  }

  focusTarget() {
    return this.tabBtns[this.tab];
  }
}

// ---------------------------------------------------------------------------------------
// Controls reference
// ---------------------------------------------------------------------------------------

const REF_GROUPS = [
  { title: 'MOVEMENT', actions: ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'crouch'] },
  { title: 'COMBAT', actions: ['fire', 'ads', 'reload', 'melee', 'slot1', 'slot2', 'slot3', 'nextWeapon', 'prevWeapon'] },
  { title: 'ABILITIES', actions: ['rush', 'interact'] },
  { title: 'INTERFACE', actions: ['scoreboard', 'debug'], extra: [['Pause / release mouse', ['Escape']]] },
];

const TECH = [
  { title: 'SLIDE', keys: [['sprint'], '+', ['crouch']], text: 'Sprint, then crouch to slide. Low profile, fast, hard to track.' },
  { title: 'SLIDE-JUMP', keys: [['crouch'], '→', ['jump']], text: 'Jump out of a slide to carry its momentum into the air.' },
  { title: 'AIR STRAFE', keys: [['left'], '/', ['right'], '+', 'MOUSE'], text: 'In the air, hold a strafe key and turn smoothly the same way to curve and keep speed.' },
  { title: 'MANTLE', keys: ['HOLD', ['jump']], text: 'Hold jump while moving into a ledge to climb over it.' },
  { title: 'WALL KICK', keys: ['AIR', '+', ['jump']], text: 'Jump next to a wall while airborne to kick off it.' },
  { title: 'JUMP PADS', keys: ['STEP ON'], text: 'Glowing pads launch you across the arena. Air strafe to steer the landing.' },
  { title: 'ROCKET JUMP', keys: ['AIM DOWN', '+', ['jump'], '+', ['fire']], text: 'With the Chaos Launcher: look at your feet, jump and fire. Trades health for height.' },
  {
    title: 'ENERGY RUSH', keys: [['rush']],
    text: `Fill the meter with damage, kills and tricks, then trigger RUSH: ${ENERGY.rushDuration}s of +${Math.round((MOVE.rushSpeedMul - 1) * 100)}% speed and faster reloads.`,
  },
];

export class ControlsScreen {
  constructor(ui, game) {
    this.ui = ui;
    this.game = game;
    this.S = game.settings;
    const p = pageShell('controls', { kicker: 'REFERENCE', title: 'CONTROLS', sub: 'Your current bindings and the movement tech that wins duels.', onBack: () => ui.back() });
    this.el = p.root;
    this.content = el('div', { class: 'mx-ref' });
    p.body.append(this.content);
    this.editBtn = mxButton({ label: 'EDIT BINDINGS', icon: 'pencil', variant: 'small', onClick: () => ui.show('settings', { tab: 'controls' }) });
    p.foot.append(el('span', { class: 'mx-page__grow' }), this.editBtn);
  }

  _keys(action) {
    const codes = bindingsFor(this.S, action);
    if (!codes.length) return [el('span', { class: 'mx-ref__unbound', text: 'UNBOUND' })];
    const out = [];
    codes.forEach((c, i) => {
      if (i) out.push(el('span', { class: 'mx-ref__or', text: 'OR' }));
      out.push(keycap(c));
    });
    return out;
  }

  _render() {
    const S = this.S;
    const groups = REF_GROUPS.map((g) => {
      const rows = g.actions.map((a) => el('div', { class: 'mx-ref__row' }, [
        el('span', { class: 'mx-ref__action', text: ACTION_LABELS[a] || a }),
        el('span', { class: 'mx-ref__keys' }, this._keys(a)),
      ]));
      if (g.extra) {
        for (const [label, codes] of g.extra) {
          rows.push(el('div', { class: 'mx-ref__row' }, [
            el('span', { class: 'mx-ref__action', text: label }),
            el('span', { class: 'mx-ref__keys' }, codes.map((c) => keycap(c))),
          ]));
        }
      }
      const panel = el('div', { class: 'mx-ref__group' }, [el('h3', { class: 'mx-group__title', text: g.title })]);
      if (g.title === 'MOVEMENT') {
        const k = (a) => {
          const c = bindingsFor(S, a)[0];
          return keycap(c, 'mx-key--big');
        };
        panel.append(el('div', { class: 'mx-ref__wasd', 'aria-hidden': 'true' }, [
          el('span'), k('forward'), el('span'),
          k('left'), k('back'), k('right'),
        ]));
      }
      for (const r of rows) panel.append(r);
      return panel;
    });

    const tech = TECH.map((t) => {
      const keys = el('span', { class: 'mx-tech__keys' });
      for (const k of t.keys) {
        if (Array.isArray(k)) keys.append(keycap(bindingsFor(S, k[0])[0]));
        else if (k === '+' || k === '→' || k === '/') keys.append(el('span', { class: 'mx-tech__op', text: k }));
        else keys.append(el('span', { class: 'mx-tech__word', text: k }));
      }
      return el('div', { class: 'mx-tech' }, [
        el('span', { class: 'mx-tech__title', text: t.title }),
        keys,
        el('span', { class: 'mx-tech__text', text: t.text }),
      ]);
    });

    this.content.replaceChildren(
      el('div', { class: 'mx-ref__groups' }, groups),
      el('div', { class: 'mx-ref__techwrap' }, [
        el('h3', { class: 'mx-group__title' }, [el('span', { text: 'ADVANCED MOVEMENT' }), el('span', { class: 'mx-group__note', text: 'Speed is armor. Never stand still.' })]),
        el('div', { class: 'mx-techs' }, tech),
      ]),
    );
  }

  onShow() {
    this._render();
  }

  focusTarget() {
    return this.editBtn;
  }
}

// Keyboard + mouse input with rebindable actions and pointer lock.
// Mouse deltas are accumulated from raw events and consumed once per frame, so aim
// responds on the very next rendered frame.
import { settings } from './settings.js';

const GAME_KEYS = new Set(['Tab', 'Space', 'F3', 'ControlLeft', 'ControlRight', 'AltLeft', 'Quote', 'Slash']);

export class Input {
  constructor(canvas) {
    this.canvas = canvas;
    this.held = new Set();
    this.pressedCodes = new Set();
    this.dx = 0;
    this.dy = 0;
    this.locked = false;
    this.enabled = false; // true while in a match (prevents default browser shortcuts)
    this.captureCb = null;
    this.lockListeners = new Set();
    this.toggles = { ads: false, crouch: false };
    this.debugInput = null; // automation hook for tests: { action: bool }
    this._bind();
  }

  _isTyping(e) {
    const t = e.target;
    return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  }

  _bind() {
    window.addEventListener('keydown', (e) => {
      if (this.captureCb) {
        e.preventDefault();
        const cb = this.captureCb; this.captureCb = null;
        cb(e.code === 'Escape' ? null : e.code);
        return;
      }
      if (this._isTyping(e)) return;
      if (this.enabled && (GAME_KEYS.has(e.code) || e.ctrlKey || e.code.startsWith('Digit') || e.code === 'KeyF')) {
        // Ctrl+W etc. cannot be blocked in every browser; C is the safe crouch default.
        if (!(e.metaKey)) e.preventDefault();
      }
      if (!this.held.has(e.code)) this.pressedCodes.add(e.code);
      this.held.add(e.code);
    });
    window.addEventListener('keyup', (e) => {
      this.held.delete(e.code);
    });
    window.addEventListener('blur', () => this.held.clear());

    const onDown = (e) => {
      if (this.captureCb) {
        e.preventDefault();
        const cb = this.captureCb; this.captureCb = null;
        cb('Mouse' + e.button);
        return;
      }
      if (!this.locked) return;
      const code = 'Mouse' + e.button;
      if (!this.held.has(code)) this.pressedCodes.add(code);
      this.held.add(code);
      e.preventDefault();
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('mouseup', (e) => this.held.delete('Mouse' + e.button));
    document.addEventListener('contextmenu', (e) => { if (this.enabled || this.locked) e.preventDefault(); });
    document.addEventListener('wheel', (e) => {
      if (this.captureCb) {
        const cb = this.captureCb; this.captureCb = null;
        cb(e.deltaY > 0 ? 'WheelDown' : 'WheelUp');
        return;
      }
      if (!this.locked) return;
      this.pressedCodes.add(e.deltaY > 0 ? 'WheelDown' : 'WheelUp');
    }, { passive: true });

    document.addEventListener('mousemove', (e) => {
      if (!this.locked) return;
      const mx = e.movementX || 0, my = e.movementY || 0;
      // Some platforms report rare huge spikes on lock; drop them.
      if (Math.abs(mx) > 900 || Math.abs(my) > 900) return;
      this.dx += mx;
      this.dy += my;
    });

    document.addEventListener('pointerlockchange', () => {
      const was = this.locked;
      this.locked = document.pointerLockElement === this.canvas;
      if (!this.locked) {
        // Release everything so keys do not stick while the menu is up.
        this.held.clear();
      }
      if (was !== this.locked) for (const l of this.lockListeners) l(this.locked);
    });
    document.addEventListener('pointerlockerror', () => {
      for (const l of this.lockListeners) l(false, true);
    });
  }

  requestLock() {
    if (this.locked) return;
    const c = this.canvas;
    try {
      const p = c.requestPointerLock({ unadjustedMovement: true });
      if (p && p.catch) p.catch(() => { try { c.requestPointerLock(); } catch { /* ignore */ } });
    } catch {
      try { c.requestPointerLock(); } catch { /* ignore */ }
    }
  }

  exitLock() {
    if (document.pointerLockElement) document.exitPointerLock();
  }

  onLockChange(fn) {
    this.lockListeners.add(fn);
    return () => this.lockListeners.delete(fn);
  }

  /** Capture the next key/button for rebinding. cb(code|null). */
  captureNext(cb) {
    this.captureCb = cb;
  }

  _codes(action) {
    return settings.data.controls.bindings[action] || [];
  }

  down(action) {
    if (this.debugInput && this.debugInput[action]) return true;
    if (!this.locked && !this.debugInput) return false;
    for (const c of this._codes(action)) if (this.held.has(c)) return true;
    return false;
  }

  pressed(action) {
    if (this.debugInput && this.debugInput['!' + action]) {
      this.debugInput['!' + action] = false;
      return true;
    }
    for (const c of this._codes(action)) if (this.pressedCodes.has(c)) return true;
    return false;
  }

  /** Hold-or-toggle helper for ADS and crouch. */
  stateful(action, toggleSetting) {
    if (!toggleSetting) return this.down(action);
    if (this.pressed(action)) this.toggles[action] = !this.toggles[action];
    return this.toggles[action];
  }

  consumeMouse() {
    const r = { dx: this.dx, dy: this.dy };
    this.dx = 0;
    this.dy = 0;
    return r;
  }

  endFrame() {
    this.pressedCodes.clear();
  }

  reset() {
    this.held.clear();
    this.pressedCodes.clear();
    this.dx = this.dy = 0;
    this.toggles.ads = this.toggles.crouch = false;
  }
}

export function codeLabel(code) {
  if (!code) return '—';
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  const map = {
    Mouse0: 'LMB', Mouse1: 'MMB', Mouse2: 'RMB', Mouse3: 'MB4', Mouse4: 'MB5', WheelUp: 'WHEEL ↑', WheelDown: 'WHEEL ↓',
    ShiftLeft: 'L-SHIFT', ShiftRight: 'R-SHIFT', ControlLeft: 'L-CTRL', ControlRight: 'R-CTRL', AltLeft: 'L-ALT',
    Space: 'SPACE', Tab: 'TAB', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'ESC',
    Backquote: '`', CapsLock: 'CAPS',
  };
  return map[code] || code.toUpperCase();
}

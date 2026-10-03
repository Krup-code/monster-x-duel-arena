// UI manager: owns every menu screen, screen transitions + history, menu sounds,
// keyboard navigation, toasts, and the in-game HUD / scoreboard / end screen.
import { HUD } from './ui/HUD.js';
import { Scoreboard, EndScreen } from './ui/Scoreboard.js';
import {
  el, setBusy, friendlyNetError, navMove,
  LoadingScreen, MainScreen, PlayScreen, BotSetupScreen, JoinScreen, PauseScreen, QuitScreen,
} from './ui/MainMenu.js';
import { LobbyView } from './ui/Lobby.js';
import { SettingsScreen, ControlsScreen } from './ui/Settings.js';

// Screens where Esc must not navigate back.
const NO_BACK = new Set(['main', 'loading', 'quit', 'lobby', 'pause']);

export class UI {
  constructor(root, game) {
    this.root = root;
    this.game = game;
    this.history = [];
    this._current = null;
    this.capturing = false;
    this.inviteConsumed = false;

    this.layer = el('div', { class: 'mx-layer' });
    root.append(this.layer);

    this.screens = {
      loading: new LoadingScreen(this, game),
      main: new MainScreen(this, game),
      play: new PlayScreen(this, game),
      botSetup: new BotSetupScreen(this, game),
      join: new JoinScreen(this, game),
      settings: new SettingsScreen(this, game),
      controls: new ControlsScreen(this, game),
      pause: new PauseScreen(this, game),
      quit: new QuitScreen(this, game),
    };
    this.lobby = new LobbyView(this, game);
    this.screens.lobby = this.lobby;
    for (const s of Object.values(this.screens)) this.layer.append(s.el);

    // In-game layers (HUD below menus; scoreboard + end screen above the HUD)
    this.hud = new HUD(root, game);
    this.scoreboard = new Scoreboard(root, game);
    this.end = new EndScreen(root, game);
    root.append(this.layer); // keep menus on top

    this.toasts = el('div', { class: 'mx-toasts', 'aria-live': 'polite' });
    root.append(this.toasts);

    this._bindSounds();
    this._bindKeys();
    document.addEventListener('fullscreenchange', () => {
      const fs = this.isFullscreen();
      for (const s of Object.values(this.screens)) s.onFullscreen?.(fs);
    });
  }

  get current() { return this._current; }

  isMenuOpen() { return this._current !== null && this._current !== undefined; }

  isFullscreen() { return !!document.fullscreenElement; }

  /** Show a screen by name (null hides menus). */
  show(name, data = {}) {
    if (name === 'end') {
      this._switch(null);
      this._current = 'end';
      this.end.show(data);
      this.history.length = 0;
      return;
    }
    this.end.hide();
    if (name && !this.screens[name]) { console.warn('[ui] unknown screen', name); return; }
    const prev = this._current;
    if (prev && prev !== name && prev !== 'loading' && prev !== 'end' && name !== 'loading') {
      // Main/lobby/pause are roots: they reset history.
      if (name === 'main' || name === 'lobby' || name === 'pause' || name === null) this.history.length = 0;
      else this.history.push(prev);
    }
    if (name === 'main' || name === null) this.history.length = 0;
    this._switch(name, data);
  }

  _switch(name, data = {}) {
    const prev = this._current;
    const prevScreen = prev && this.screens[prev];
    const next = name && this.screens[name];
    if (prevScreen && prevScreen !== next) {
      prevScreen.el.classList.remove('is-active');
      prevScreen.el.classList.add('is-leaving');
      prevScreen.el.setAttribute('aria-hidden', 'true');
      prevScreen.el.inert = true;
      clearTimeout(prevScreen.__leaveT);
      prevScreen.__leaveT = setTimeout(() => prevScreen.el.classList.remove('is-leaving'), 260);
      try { prevScreen.onHide?.(); } catch (e) { console.error(e); }
    }
    this._current = name || null;
    this.root.classList.toggle('has-menu', !!next);
    document.body.classList.toggle('mx-menu-open', !!next);
    if (next) {
      clearTimeout(next.__leaveT);
      next.el.classList.remove('is-leaving');
      next.el.classList.add('is-active');
      next.el.setAttribute('aria-hidden', 'false');
      next.el.inert = false;
      try { next.onShow?.(data); } catch (e) { console.error(e); }
    }
  }

  back() {
    const cur = this._current;
    if (!cur) return;
    const prev = this.history.pop();
    if (prev) { this._switch(prev); return; }
    // Default parents
    if (cur === 'settings' || cur === 'controls') {
      if (this.game.actions && this._inMatch()) this._switch('pause', {});
      else this._switch('main');
      return;
    }
    this._switch('main');
  }

  _inMatch() {
    try { return !!window.__mx?.game?.mc; } catch { return false; }
  }

  setLoading(progress, label) {
    this.screens.loading.set(progress, label);
  }

  /** Invoke a game action with error reporting. */
  act(name, ...args) {
    const fn = this.game.actions?.[name];
    if (!fn) { console.warn('[ui] missing action', name); return undefined; }
    try {
      const r = fn(...args);
      if (r && typeof r.catch === 'function') {
        r.catch((e) => {
          console.error(e);
          if (name !== 'joinMatch' && name !== 'hostMatch') this.toast(friendlyNetError(e), 'error', 4000);
        });
      }
      return r;
    } catch (e) {
      console.error(e);
      this.toast(friendlyNetError(e), 'error', 4000);
      return undefined;
    }
  }

  async hostMatch(btn) {
    if (this._hosting) return;
    this._hosting = true;
    if (btn) setBusy(btn, true, 'CREATING ROOM…');
    try {
      await this.game.actions.hostMatch();
    } catch (e) {
      // The game already navigated back and toasted.
    } finally {
      this._hosting = false;
      if (btn) setBusy(btn, false);
    }
  }

  toast(text, kind = 'info', ms = 2600) {
    const t = el('div', { class: `mx-toast mx-toast--${kind}`, role: kind === 'error' ? 'alert' : 'status' }, [
      el('span', { class: 'mx-toast__bar', 'aria-hidden': 'true' }),
      el('span', { class: 'mx-toast__text', text: String(text) }),
    ]);
    this.toasts.append(t);
    while (this.toasts.children.length > 4) this.toasts.firstChild.remove();
    requestAnimationFrame(() => t.classList.add('is-in'));
    setTimeout(() => {
      t.classList.remove('is-in');
      t.classList.add('is-out');
      setTimeout(() => t.remove(), 320);
    }, ms);
  }

  // ---------------------------------------------------------------- sounds + keys
  _sound(name) {
    try { this.game.audio?.play(name, { bus: 'ui' }); } catch { /* ignore */ }
  }

  _bindSounds() {
    let lastHover = null, lastT = 0;
    this.root.addEventListener('pointerover', (e) => {
      const b = e.target.closest?.('button, .mx-card, [role=radio], [role=tab]');
      if (!b || b === lastHover || b.disabled) return;
      lastHover = b;
      const now = performance.now();
      if (now - lastT < 45) return;
      lastT = now;
      this._sound('ui_hover');
    });
    this.root.addEventListener('pointerout', (e) => {
      if (lastHover && !lastHover.contains(e.relatedTarget)) lastHover = null;
    });
    this.root.addEventListener('click', (e) => {
      const b = e.target.closest?.('button');
      if (!b || b.disabled) return;
      const s = b.dataset.sound;
      if (s === 'none') return;
      this._sound(s === 'back' ? 'ui_back' : 'ui_click');
    }, true);
  }

  _bindKeys() {
    window.addEventListener('keydown', (e) => {
      const cur = this._current;
      if (!cur || cur === 'end' || this.capturing) return;
      const t = e.target;
      if (e.key === 'Escape') {
        if (t && t.dataset && t.dataset.esc === 'blur' && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) { t.blur(); e.preventDefault(); return; }
        const s = this.screens[cur];
        if (s?.onBack?.()) { e.preventDefault(); return; }
        if (NO_BACK.has(cur)) return;
        e.preventDefault();
        this._sound('ui_back');
        this.back();
        return;
      }
      if (t && (t.tagName === 'INPUT' && t.type !== 'range')) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        const s = this.screens[cur];
        const nav = s?.el.querySelector('[data-nav]');
        if (nav && navMove(nav, e.key === 'ArrowDown' ? 1 : -1)) e.preventDefault();
      } else if (e.key === 'Tab' && !document.activeElement?.closest?.('.mx-screen.is-active')) {
        const f = this.screens[cur]?.focusTarget?.();
        if (f) { e.preventDefault(); f.focus(); }
      }
    });
  }
}

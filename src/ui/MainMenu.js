// MONSTER-X: DUEL ARENA - menu screens (loading, main, play, bot setup, join, pause, quit)
// plus the small DOM helpers shared by every menu module (Lobby.js, Settings.js, ui.js).
//
// Every screen is a plain object with:
//   el                 root <section class="mx-screen ...">
//   onShow(data)       called each time the screen becomes current
//   onHide()           called when it stops being current
//   onBack()           optional: return true to consume a Back/Esc request
//   focusTarget()      optional: element to focus when navigated by keyboard
import { NET } from '../config.js';
import { codeLabel } from '../input.js';

// ---------------------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------------------

/** Create an element. opts: class, text, html, style, on<Event>: fn, dataset, any attribute. */
export function el(tag, opts = null, children = null) {
  const n = document.createElement(tag);
  if (opts) {
    for (const k in opts) {
      const v = opts[k];
      if (v == null || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'style') n.style.cssText = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.length > 2 && k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (children != null) appendAll(n, children);
  return n;
}

function appendAll(n, children) {
  if (Array.isArray(children)) {
    for (const c of children) if (c != null && c !== false) n.append(c);
  } else if (children !== false) n.append(children);
}

/** textContent setter that skips the DOM write when unchanged. */
export function setText(node, text) {
  const t = text == null ? '' : String(text);
  if (node.__mxText !== t) {
    node.__mxText = t;
    node.textContent = t;
  }
}

/** Attribute setter that skips the DOM write when unchanged (null removes). */
export function setAttr(node, name, value) {
  const key = '__mxA_' + name;
  const v = value == null || value === false ? null : String(value);
  if (node[key] === v) return;
  node[key] = v;
  if (v === null) node.removeAttribute(name);
  else node.setAttribute(name, v);
}

/** hidden setter that skips the DOM write when unchanged. */
export function setHidden(node, hidden) {
  const h = !!hidden;
  if (node.hidden !== h) node.hidden = h;
}

export function setDisabled(btn, disabled) {
  const d = !!disabled;
  if (btn.disabled !== d) btn.disabled = d;
}

export function clamp(v, a, b) {
  return v < a ? a : v > b ? b : v;
}

/** Map a network/join error to a friendly, uppercase line. */
export function friendlyNetError(err) {
  const msg = (err && (err.message || err.code)) || String(err || '');
  switch (msg) {
    case 'ROOM_NOT_FOUND': return 'ROOM NOT FOUND — CHECK THE CODE';
    case 'ROOM_FULL': return 'ROOM IS FULL';
    case 'ROOM_REJECTED': return 'THE HOST REJECTED THE CONNECTION';
    case 'SIGNAL_UNREACHABLE':
    case 'SIGNAL_TIMEOUT': return "CAN'T REACH MATCHMAKING — CHECK YOUR CONNECTION";
    case 'ice-failed':
    case 'connect-failed': return 'COULD NOT CONNECT TO HOST (FIREWALL/NAT). TRY AGAIN OR USE A TURN SERVER';
    default: return (msg || 'SOMETHING WENT WRONG').toUpperCase();
  }
}

/** Keycap chip for a binding code. */
export function keycap(code, extraCls = '') {
  const label = codeLabel(code);
  const wide = label.length > 3 ? ' mx-key--wide' : '';
  const mouse = code && (code.startsWith('Mouse') || code.startsWith('Wheel')) ? ' mx-key--mouse' : '';
  return el('kbd', { class: `mx-key${wide}${mouse}${extraCls ? ' ' + extraCls : ''}`, text: label });
}

/** Current binding codes for an action (max 2). */
export function bindingsFor(settings, action) {
  const b = settings.data.controls.bindings[action];
  return Array.isArray(b) ? b.slice(0, 2) : [];
}

export function primaryKeyLabel(settings, action) {
  const b = bindingsFor(settings, action);
  return b.length ? codeLabel(b[0]) : 'UNBOUND';
}

// ---------------------------------------------------------------------------------------
// Emblem: angular hexagon badge with two serrated blades forming an X (original design).
// ---------------------------------------------------------------------------------------

let emblemUid = 0;

function bladePolygon() {
  // Blade along +x, centered on the origin. Sawtooth serrations along the top edge.
  const pts = [[-54, 0], [-42, -5.5]];
  for (let x = -34; x <= 22; x += 9) pts.push([x, -5.5], [x + 7, -10.5], [x + 7, -5.5]);
  pts.push([42, -5.5], [54, 0], [42, 5.5], [-30, 5.5], [-34, 8.5], [-42, 5.5]);
  return pts.map((p) => `${p[0]},${p[1]}`).join(' ');
}
const BLADE = bladePolygon();

function hexPoints(cx, cy, r) {
  const out = [];
  for (let i = 0; i < 6; i++) {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    out.push(`${(cx + Math.cos(a) * r).toFixed(2)},${(cy + Math.sin(a) * r).toFixed(2)}`);
  }
  return out.join(' ');
}
const HEX_OUT = hexPoints(60, 60, 57);
const HEX_IN = hexPoints(60, 60, 48);
const HEX_CORE = hexPoints(60, 60, 10);

export function emblemSVG(cls = '') {
  const id = 'mxe' + ++emblemUid;
  return `<svg class="mx-emblem ${cls}" viewBox="0 0 120 120" aria-hidden="true" focusable="false">
  <defs>
    <linearGradient id="${id}b" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#151a17"/><stop offset="1" stop-color="#040504"/></linearGradient>
    <linearGradient id="${id}g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#c6ff7a"/><stop offset=".45" stop-color="#7dff1a"/><stop offset="1" stop-color="#2fae08"/></linearGradient>
    <linearGradient id="${id}w" x1="1" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#b9c4b4"/></linearGradient>
  </defs>
  <polygon points="${HEX_OUT}" fill="url(#${id}b)" stroke="#7dff1a" stroke-width="3.2" stroke-linejoin="miter"/>
  <polygon points="${HEX_IN}" fill="none" stroke="rgba(125,255,26,.32)" stroke-width="1.2"/>
  <path d="M60 3 v7 M60 110 v7 M10.6 31.5 l6 3.5 M103.4 85.5 l6 3.5 M109.4 31.5 l-6 3.5 M16.6 85.5 l-6 3.5" stroke="#7dff1a" stroke-width="2.4"/>
  <g transform="translate(60 60) rotate(45)"><polygon points="${BLADE}" fill="url(#${id}g)" stroke="#050605" stroke-width="2.6" stroke-linejoin="round"/></g>
  <g transform="translate(60 60) rotate(-45) scale(1 -1)"><polygon points="${BLADE}" fill="url(#${id}w)" stroke="#050605" stroke-width="2.6" stroke-linejoin="round"/></g>
  <polygon points="${HEX_CORE}" fill="#050605" stroke="#7dff1a" stroke-width="2.2"/>
  <polygon points="${hexPoints(60, 60, 4.2)}" fill="#a6ff4d"/>
</svg>`;
}

// ---------------------------------------------------------------------------------------
// Icons (inline SVG strings, stroke = currentColor)
// ---------------------------------------------------------------------------------------

const svg = (body, vb = '0 0 24 24') =>
  `<svg viewBox="${vb}" class="mx-ico" aria-hidden="true" focusable="false" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="square" stroke-linejoin="miter">${body}</svg>`;

export const ICONS = {
  back: svg('<path d="M15 5 8 12l7 7"/>'),
  arrow: svg('<path d="M5 12h13M13 6l6 6-6 6"/>'),
  fullscreen: svg('<path d="M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5"/>'),
  exitFullscreen: svg('<path d="M9 4v5H4M20 9h-5V4M15 20v-5h5M4 15h5v5"/>'),
  host: svg('<path d="M12 13v8M8 21h8"/><circle cx="12" cy="10" r="2"/><path d="M7.8 5.8a6 6 0 0 0 0 8.4M16.2 5.8a6 6 0 0 1 0 8.4M5 3a10 10 0 0 0 0 14M19 3a10 10 0 0 1 0 14"/>'),
  join: svg('<path d="M14 4h6v16h-6"/><path d="M3 12h11M10 8l4 4-4 4"/>'),
  bot: svg('<path d="M12 2v3"/><rect x="4" y="6" width="16" height="12" rx="1"/><path d="M8.5 11h1M14.5 11h1M9 15h6M2 11v3M22 11v3"/>'),
  target: svg('<circle cx="12" cy="12" r="8"/><circle cx="12" cy="12" r="3.5"/><path d="M12 1v5M12 18v5M1 12h5M18 12h5"/>'),
  pencil: svg('<path d="M4 20h4L19 9l-4-4L4 16v4zM13 7l4 4"/>'),
  copy: svg('<rect x="8" y="8" width="12" height="12"/><path d="M16 8V4H4v12h4"/>'),
  link: svg('<path d="M10 14a4 4 0 0 0 5.7 0l3.5-3.5a4 4 0 0 0-5.7-5.7L12 6.3"/><path d="M14 10a4 4 0 0 0-5.7 0l-3.5 3.5a4 4 0 0 0 5.7 5.7l1.5-1.5"/>'),
  check: svg('<path d="M4 12.5 9.5 18 20 6"/>'),
  play: svg('<path d="M7 4v16l13-8z"/>'),
  skull: svg('<path d="M5 14v-3a7 7 0 0 1 14 0v3l-2 2v3H7v-3z"/><path d="M9 12h1M14 12h1M11 19v-2M13 19v-2"/>'),
  signal: svg('<path d="M4 20v-4M9 20v-8M14 20V8M19 20V4"/>'),
  warn: svg('<path d="M12 3 2 21h20zM12 10v5M12 17.5v.5"/>'),
};

// ---------------------------------------------------------------------------------------
// Buttons & page shells
// ---------------------------------------------------------------------------------------

/**
 * Angular cut-corner button with an acid fill sweep on hover/focus.
 * o: { label, sub, idx, icon, variant: 'primary'|'ghost'|'danger'|'small', sound: 'click'|'back'|'none', onClick, cls, attrs }
 */
export function mxButton(o) {
  const variants = (o.variant || '').split(' ').filter(Boolean).map((v) => ` mx-btn--${v}`).join('');
  const b = el('button', { type: 'button', class: `mx-btn${variants}${o.cls ? ' ' + o.cls : ''}`, ...(o.attrs || {}) });
  if (o.sound) b.dataset.sound = o.sound;
  b.append(el('span', { class: 'mx-btn__fill', 'aria-hidden': 'true' }));
  if (o.idx != null) b.append(el('span', { class: 'mx-btn__idx', 'aria-hidden': 'true', text: String(o.idx).padStart(2, '0') }));
  if (o.icon) b.append(el('span', { class: 'mx-btn__icon', html: ICONS[o.icon] || o.icon, 'aria-hidden': 'true' }));
  const text = el('span', { class: 'mx-btn__text' });
  const label = el('span', { class: 'mx-btn__label', text: o.label });
  text.append(label);
  if (o.sub) text.append(el('span', { class: 'mx-btn__sub', text: o.sub }));
  b.append(text);
  b.__label = label;
  b.__labelText = o.label;
  if (o.onClick) b.addEventListener('click', o.onClick);
  return b;
}

export function setButtonLabel(btn, text) {
  if (btn.__label) setText(btn.__label, text);
  else setText(btn, text);
}

/** Busy state: disables, swaps the label and shows the animated stripe. */
export function setBusy(btn, busy, busyText) {
  btn.classList.toggle('is-busy', !!busy);
  setDisabled(btn, !!busy);
  setButtonLabel(btn, busy ? busyText || btn.__labelText : btn.__labelText);
}

export function screenShell(name, extra = '') {
  const s = el('section', { class: `mx-screen mx-screen--${name}${extra ? ' ' + extra : ''}`, 'data-screen': name, 'aria-hidden': 'true' });
  s.inert = true;
  return s;
}

/** Standard sub-page: dark veil, kicker + title header, scrollable body, footer with BACK. */
export function pageShell(name, { kicker, title, sub, onBack, backLabel = 'BACK' }) {
  const root = screenShell(name, 'mx-page');
  const head = el('header', { class: 'mx-page__head' }, [
    el('div', { class: 'mx-kicker' }, [el('span', { class: 'mx-kicker__bar' }), el('span', { text: kicker })]),
    el('h2', { class: 'mx-page__title', text: title }),
    sub ? el('p', { class: 'mx-page__sub', text: sub }) : null,
  ]);
  const body = el('div', { class: 'mx-page__body' });
  const back = mxButton({ label: backLabel, icon: 'back', variant: 'ghost small', sound: 'back', onClick: onBack, cls: 'mx-back' });
  const foot = el('footer', { class: 'mx-page__foot' }, [
    back,
    el('span', { class: 'mx-hint' }, [el('kbd', { class: 'mx-key', text: 'ESC' }), el('span', { text: 'BACK' })]),
  ]);
  root.append(el('div', { class: 'mx-page__veil', 'aria-hidden': 'true' }), head, body, foot);
  return { root, head, body, foot, back };
}

/** Move keyboard focus within [data-nav] containers with the arrow keys. */
export function navMove(container, dir) {
  const items = container.querySelectorAll('button:not(:disabled), input:not([type=range])');
  if (!items.length) return false;
  let idx = -1;
  for (let i = 0; i < items.length; i++) if (items[i] === document.activeElement) idx = i;
  const next = idx < 0 ? (dir > 0 ? 0 : items.length - 1) : (idx + dir + items.length) % items.length;
  items[next].focus();
  return true;
}

// ---------------------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------------------

const SEGMENTS = 32;

const TIPS = [
  (k) => `SLIDE: hold [${k('sprint')}] and tap [${k('crouch')}]. Jump out of the slide to keep the speed.`,
  (k) => `ENERGY builds from damage, kills and movement tricks. Press [${k('rush')}] when full for an ENERGY RUSH.`,
  () => 'HEADSHOTS hit hard. The VENOM DMR and ENERGY RAIL reward patience.',
  (k) => `MANTLE: hold [${k('jump')}] while running into a ledge to climb it.`,
  (k) => `WALL KICK: press [${k('jump')}] next to a wall while airborne.`,
  () => 'ROCKET JUMP: aim down, jump and fire the CHAOS LAUNCHER at your feet.',
  () => 'ARMOR soaks damage before health. Time the armor spawns and deny your opponent.',
  () => 'MEGA ENERGY overcharges you up to 150 health. It is worth the detour.',
  () => 'AIR STRAFE: hold a strafe key and turn the mouse smoothly in the same direction.',
  (k) => `Hold [${k('scoreboard')}] for the scoreboard. [${k('debug')}] opens the network panel.`,
  () => 'RARE WEAPONS respawn on fixed timers. Learn the rhythm, own the map.',
  () => 'JUMP PADS launch you across the arena. Air strafe to steer the landing.',
  () => 'Sound tells the story: footsteps, reloads and pickups give your opponent away.',
  (k) => `QUICK MELEE [${k('melee')}] finishes a weakened opponent at point-blank range.`,
];

export class LoadingScreen {
  constructor(ui, game) {
    this.ui = ui;
    this.game = game;
    this.el = screenShell('loading');
    this.segs = [];
    const bar = el('div', { class: 'mx-segbar', role: 'progressbar', 'aria-valuemin': '0', 'aria-valuemax': '100' });
    for (let i = 0; i < SEGMENTS; i++) {
      const s = el('i', { class: 'mx-segbar__seg' });
      s.style.setProperty('--i', i);
      bar.append(s);
      this.segs.push(s);
    }
    this.bar = bar;
    this.pctNum = el('span', { class: 'mx-loading__num', text: '0' });
    this.detail = el('div', { class: 'mx-loading__detail' });
    this.tipText = el('span', { class: 'mx-loading__tiptext' });
    this.tipBox = el('div', { class: 'mx-loading__tip' }, [el('span', { class: 'mx-loading__tiplabel', text: 'TIP' }), this.tipText]);

    this.el.append(
      el('div', { class: 'mx-loading__grid', 'aria-hidden': 'true' }),
      el('div', { class: 'mx-loading__center' }, [
        el('div', { class: 'mx-loading__emblem', html: emblemSVG('mx-emblem--spin') }),
        el('div', { class: 'mx-logo mx-logo--loading mx-glitch', 'data-text': 'MONSTER-X', text: 'MONSTER-X' }),
        el('div', { class: 'mx-loading__row' }, [
          el('div', { class: 'mx-loading__label', text: 'LOADING ARENA' }),
          el('div', { class: 'mx-loading__pct' }, [this.pctNum, el('span', { class: 'mx-loading__unit', text: '%' })]),
        ]),
        bar,
        this.detail,
      ]),
      this.tipBox,
    );
    this.filled = -1;
    this.pctShown = -1;
    this.tipIdx = Math.floor(Math.random() * TIPS.length);
    this.tipTimer = 0;
    this._showTip();
    this.set(0, '');
  }

  set(progress, label) {
    const p = clamp(Number.isFinite(progress) ? progress : 0, 0, 1);
    const n = Math.round(p * SEGMENTS);
    if (n !== this.filled) {
      for (let i = 0; i < SEGMENTS; i++) {
        this.segs[i].classList.toggle('is-on', i < n);
        this.segs[i].classList.toggle('is-head', i === n - 1 && n < SEGMENTS);
      }
      this.filled = n;
    }
    const pc = Math.floor(p * 100);
    if (pc !== this.pctShown) {
      this.pctShown = pc;
      setText(this.pctNum, pc);
      setAttr(this.bar, 'aria-valuenow', pc);
    }
    if (label != null) {
      const l = String(label).toUpperCase();
      setText(this.detail, l === 'LOADING ARENA' ? '' : l);
    }
  }

  _showTip() {
    const S = this.game.settings;
    const k = (a) => primaryKeyLabel(S, a);
    this.tipIdx = (this.tipIdx + 1) % TIPS.length;
    setText(this.tipText, TIPS[this.tipIdx](k));
    this.tipBox.classList.remove('is-swap');
    void this.tipBox.offsetWidth;
    this.tipBox.classList.add('is-swap');
  }

  onShow() {
    clearInterval(this.tipTimer);
    this._showTip();
    this.tipTimer = setInterval(() => this._showTip(), 4200);
  }

  onHide() {
    clearInterval(this.tipTimer);
    this.tipTimer = 0;
  }
}

// ---------------------------------------------------------------------------------------
// Main menu
// ---------------------------------------------------------------------------------------

function sanitizeName(v) {
  return String(v || '')
    .replace(/[^\p{L}\p{N} _\-.]/gu, '')
    .replace(/\s{2,}/g, ' ')
    .slice(0, 16);
}

export class MainScreen {
  constructor(ui, game) {
    this.ui = ui;
    this.game = game;
    const S = game.settings;
    this.el = screenShell('main');

    // --- brand block
    const brand = el('div', { class: 'mx-brand' }, [
      el('div', { class: 'mx-brand__emblem', html: emblemSVG() }),
      el('div', { class: 'mx-brand__text' }, [
        el('h1', { class: 'mx-logo mx-glitch', 'data-text': 'MONSTER-X', text: 'MONSTER-X' }),
        el('div', { class: 'mx-brand__sub' }, [el('span', { text: 'DUEL ARENA' }), el('span', { class: 'mx-brand__rule' })]),
        el('div', { class: 'mx-brand__tag', text: '1V1. NO EXCUSES.' }),
      ]),
    ]);

    // --- player name
    this.nameInput = el('input', {
      class: 'mx-name__input', type: 'text', maxlength: '16', placeholder: 'PLAYER', spellcheck: 'false',
      autocomplete: 'off', autocapitalize: 'characters', 'aria-label': 'Player name', 'data-esc': 'blur',
    });
    this._lastName = S.data.player.name || '';
    this.nameInput.value = this._lastName;
    let nameTimer = 0;
    this.nameInput.addEventListener('input', () => {
      const clean = sanitizeName(this.nameInput.value);
      if (clean !== this.nameInput.value) {
        const pos = this.nameInput.selectionStart;
        this.nameInput.value = clean;
        try { this.nameInput.setSelectionRange(pos - 1, pos - 1); } catch { /* ignore */ }
      }
      clearTimeout(nameTimer);
      nameTimer = setTimeout(() => this._commitName(), 450);
    });
    this.nameInput.addEventListener('change', () => { clearTimeout(nameTimer); this._commitName(); });
    this.nameInput.addEventListener('blur', () => { clearTimeout(nameTimer); this._commitName(); });
    this.nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.nameInput.blur(); }
    });
    const nameBox = el('label', { class: 'mx-name' }, [
      el('span', { class: 'mx-name__label', text: 'CALLSIGN' }),
      this.nameInput,
      el('span', { class: 'mx-name__icon', html: ICONS.pencil, 'aria-hidden': 'true' }),
    ]);

    // --- buttons
    const items = [
      { id: 'play', label: 'PLAY', sub: 'Choose your fight', variant: 'primary big', onClick: () => ui.show('play') },
      { id: 'host', label: 'HOST MATCH', sub: 'Create a room · invite a friend', onClick: (e) => ui.hostMatch(e.currentTarget) },
      { id: 'join', label: 'JOIN MATCH', sub: 'Enter a room code', onClick: () => ui.show('join') },
      { id: 'training', label: 'TRAINING', sub: 'Targets & movement course', onClick: () => ui.act('startTraining') },
      { id: 'settings', label: 'SETTINGS', sub: 'Graphics · controls · audio', onClick: () => ui.show('settings') },
      { id: 'controls', label: 'CONTROLS', sub: 'Keys & movement tech', onClick: () => ui.show('controls') },
      { id: 'quit', label: 'QUIT', variant: 'ghost', sound: 'back', onClick: () => ui.act('quit') },
    ];
    const nav = el('nav', { class: 'mx-mainnav', 'data-nav': '', 'aria-label': 'Main menu' });
    this.buttons = {};
    items.forEach((it, i) => {
      const b = mxButton({ ...it, idx: it.id === 'quit' ? null : i + 1, cls: 'mx-mainnav__btn' });
      b.style.setProperty('--i', i);
      this.buttons[it.id] = b;
      nav.append(b);
    });

    // --- invite banner (shown when the page was opened with ?room=CODE)
    this.inviteCode = el('span', { class: 'mx-invite__code' });
    this.invite = el('div', { class: 'mx-invite', hidden: true }, [
      el('div', { class: 'mx-invite__text' }, [el('span', { class: 'mx-invite__kicker', text: "YOU'VE BEEN INVITED" }), el('span', { class: 'mx-invite__room' }, ['ROOM ', this.inviteCode])]),
      mxButton({ label: 'JOIN NOW', icon: 'arrow', variant: 'primary small', onClick: () => this._joinInvite() }),
    ]);

    const col = el('div', { class: 'mx-main__col' }, [brand, nameBox, nav, this.invite]);

    // --- corner: fullscreen
    this.fsBtn = mxButton({ label: 'FULLSCREEN', icon: 'fullscreen', variant: 'ghost small', cls: 'mx-fs', onClick: () => ui.act('toggleFullscreen') });
    const corner = el('div', { class: 'mx-corner' }, [this.fsBtn]);

    // --- footer
    let backend = '';
    try { backend = (game.netInfo && game.netInfo().backend) || ''; } catch { backend = ''; }
    const ver = String(game.version || '1.0.0');
    const footer = el('footer', { class: 'mx-footer' }, [
      el('span', { class: 'mx-footer__ver', text: (/^v/i.test(ver) ? ver : 'V' + ver).toUpperCase() }),
      el('span', { class: 'mx-footer__sep' }),
      el('span', { class: 'mx-footer__net', html: ICONS.signal }),
      el('span', { class: 'mx-footer__backend', text: backend ? `P2P · ${backend}` : 'P2P · WEBRTC' }),
      el('span', { class: 'mx-footer__grow' }),
      el('span', { class: 'mx-footer__sponsor' }, ['Sponsored by the totally fictional ', el('b', { text: 'MONSTER-X ENERGY' })]),
    ]);

    const rail = el('div', { class: 'mx-rail', 'aria-hidden': 'true', text: 'MONSTER-X ENERGY // DUEL ARENA // SEASON 01 // STAY CHARGED' });

    this.el.append(el('div', { class: 'mx-main__veil', 'aria-hidden': 'true' }), col, corner, rail, footer);
    this.onFullscreen(false);
  }

  _commitName() {
    const n = sanitizeName(this.nameInput.value).trim();
    if (n === this._lastName) return;
    this._lastName = n;
    this.ui.act('setName', n);
  }

  _joinInvite() {
    const code = this.game.initialRoom;
    this.ui.inviteConsumed = true;
    this.ui.show('join', { code });
  }

  onFullscreen(fs) {
    setButtonLabel(this.fsBtn, fs ? 'EXIT FULLSCREEN' : 'FULLSCREEN');
    const ico = this.fsBtn.querySelector('.mx-btn__icon');
    const want = fs ? 'exit' : 'enter';
    if (ico && ico.__state !== want) {
      ico.__state = want;
      ico.innerHTML = fs ? ICONS.exitFullscreen : ICONS.fullscreen;
    }
  }

  onShow() {
    if (document.activeElement !== this.nameInput) {
      const n = this.game.settings.data.player.name || '';
      this._lastName = n;
      if (this.nameInput.value !== n) this.nameInput.value = n;
    }
    const code = this.game.initialRoom;
    const showInvite = !!code && !this.ui.inviteConsumed;
    this.invite.hidden = !showInvite;
    if (showInvite) setText(this.inviteCode, String(code).toUpperCase());
    // Restart the staggered entrance.
    this.el.classList.remove('is-enter');
    void this.el.offsetWidth;
    this.el.classList.add('is-enter');
  }

  focusTarget() {
    return this.buttons.play;
  }
}

// ---------------------------------------------------------------------------------------
// Play (mode select)
// ---------------------------------------------------------------------------------------

function modeCard({ icon, title, tag, desc, meta, accent, onClick, i }) {
  const b = el('button', { type: 'button', class: `mx-card${accent ? ' mx-card--' + accent : ''}` }, [
    el('span', { class: 'mx-card__fill', 'aria-hidden': 'true' }),
    el('span', { class: 'mx-card__top' }, [
      el('span', { class: 'mx-card__icon', html: ICONS[icon], 'aria-hidden': 'true' }),
      el('span', { class: 'mx-card__tag', text: tag }),
    ]),
    el('span', { class: 'mx-card__title', text: title }),
    el('span', { class: 'mx-card__desc', text: desc }),
    el('span', { class: 'mx-card__meta' }, [el('span', { text: meta }), el('span', { class: 'mx-card__go', html: ICONS.arrow })]),
  ]);
  b.style.setProperty('--i', i);
  b.addEventListener('click', onClick);
  return b;
}

export class PlayScreen {
  constructor(ui, game) {
    this.ui = ui;
    this.game = game;
    const p = pageShell('play', { kicker: 'SELECT MODE', title: 'PLAY', sub: 'Pick your arena. Every mode uses full duel rules and movement.', onBack: () => ui.back() });
    this.el = p.root;
    const grid = el('div', { class: 'mx-cards', 'data-nav': '' });
    let hostCard = null;
    hostCard = modeCard({
      i: 0, icon: 'host', title: 'ONLINE DUEL', tag: 'HOST', accent: 'p1',
      desc: 'Create a private room, then send the code or invite link to your opponent.',
      meta: 'PEER-TO-PEER · WEBRTC', onClick: () => ui.hostMatch(hostCard),
    });
    hostCard.__labelText = 'ONLINE DUEL';
    hostCard.__label = hostCard.querySelector('.mx-card__title');
    const cards = [
      hostCard,
      modeCard({
        i: 1, icon: 'join', title: 'ONLINE DUEL', tag: 'JOIN', accent: 'p2',
        desc: "Got a room code? Drop straight into your friend's arena.",
        meta: `${NET.codeLength}-CHARACTER ROOM CODE`, onClick: () => ui.show('join'),
      }),
      modeCard({
        i: 2, icon: 'bot', title: 'PRACTICE VS BOT', tag: 'OFFLINE',
        desc: 'First to 15 against an AI duelist. Four difficulty levels, both arenas.',
        meta: 'EASY · NORMAL · HARD · INSANE', onClick: () => ui.show('botSetup'),
      }),
      modeCard({
        i: 3, icon: 'target', title: 'TRAINING', tag: 'SOLO',
        desc: 'Targets, weapon racks and a movement course. Live accuracy and DPS stats.',
        meta: 'NO TIMER · NO PRESSURE', onClick: () => ui.act('startTraining'),
      }),
    ];
    this.cards = cards;
    for (const c of cards) grid.append(c);
    p.body.append(grid);
  }

  onShow() {
    this.el.classList.remove('is-enter');
    void this.el.offsetWidth;
    this.el.classList.add('is-enter');
  }

  focusTarget() {
    return this.cards[0];
  }
}

// ---------------------------------------------------------------------------------------
// Bot setup
// ---------------------------------------------------------------------------------------

const DIFFICULTIES = [
  { id: 'easy', label: 'EASY', pips: 1, desc: 'Slow reactions, forgiving aim. Learn the arena.' },
  { id: 'normal', label: 'NORMAL', pips: 2, desc: 'A fair fight. Strafes, takes cover, grabs pickups.' },
  { id: 'hard', label: 'HARD', pips: 3, desc: 'Sharp aim and map control. Punishes every mistake.' },
  { id: 'insane', label: 'INSANE', pips: 4, desc: 'Near-instant reactions. You will need every trick.' },
];
const BOT_KEY = 'monsterx-bot-setup';

export function mapThumb(id) {
  return el('span', { class: `mx-thumb mx-thumb--${id}`, 'aria-hidden': 'true' }, [
    el('span', { class: 'mx-thumb__core' }),
    el('span', { class: 'mx-thumb__scan' }),
  ]);
}

export class BotSetupScreen {
  constructor(ui, game) {
    this.ui = ui;
    this.game = game;
    const maps = Array.isArray(game.maps) ? game.maps : [];
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(BOT_KEY) || 'null'); } catch { saved = null; }
    this.difficulty = saved && DIFFICULTIES.some((d) => d.id === saved.difficulty) ? saved.difficulty : 'normal';
    this.map = saved && maps.some((m) => m.id === saved.map) ? saved.map : (maps[0] && maps[0].id) || 'blackout';

    const p = pageShell('botSetup', { kicker: 'PRACTICE VS BOT', title: 'BOT DUEL', sub: 'Full match rules: first to 15 eliminations, 8 minute clock, sudden death on a tie.', onBack: () => ui.back() });
    this.el = p.root;

    // Difficulty
    this.diffBtns = [];
    const diffWrap = el('div', { class: 'mx-diff', role: 'radiogroup', 'aria-label': 'Difficulty', 'data-nav': '' });
    for (const d of DIFFICULTIES) {
      const pips = el('span', { class: 'mx-diff__pips', 'aria-hidden': 'true' });
      for (let i = 0; i < 4; i++) pips.append(el('i', { class: i < d.pips ? 'is-on' : '' }));
      const b = el('button', { type: 'button', class: `mx-diff__opt mx-diff__opt--${d.id}`, role: 'radio', 'aria-checked': 'false' }, [
        el('span', { class: 'mx-diff__label', text: d.label }),
        pips,
        el('span', { class: 'mx-diff__desc', text: d.desc }),
      ]);
      b.addEventListener('click', () => { this.difficulty = d.id; this._sync(); });
      b.__id = d.id;
      this.diffBtns.push(b);
      diffWrap.append(b);
    }

    // Maps
    this.mapBtns = [];
    const mapWrap = el('div', { class: 'mx-maps', role: 'radiogroup', 'aria-label': 'Map', 'data-nav': '' });
    for (const m of maps) {
      const b = el('button', { type: 'button', class: 'mx-mapcard', role: 'radio', 'aria-checked': 'false' }, [
        mapThumb(m.id),
        el('span', { class: 'mx-mapcard__info' }, [
          el('span', { class: 'mx-mapcard__name', text: m.name }),
          el('span', { class: 'mx-mapcard__desc', text: m.desc || '' }),
        ]),
        el('span', { class: 'mx-mapcard__check', html: ICONS.check, 'aria-hidden': 'true' }),
      ]);
      b.addEventListener('click', () => { this.map = m.id; this._sync(); });
      b.__id = m.id;
      this.mapBtns.push(b);
      mapWrap.append(b);
    }

    this.startBtn = mxButton({ label: 'START MATCH', icon: 'play', variant: 'primary', onClick: () => this._start() });
    this.summary = el('span', { class: 'mx-bot__summary' });

    p.body.append(
      el('div', { class: 'mx-bot' }, [
        el('div', { class: 'mx-section' }, [el('h3', { class: 'mx-section__title', text: 'DIFFICULTY' }), diffWrap]),
        el('div', { class: 'mx-section' }, [el('h3', { class: 'mx-section__title', text: 'ARENA' }), mapWrap]),
      ]),
    );
    p.foot.append(el('span', { class: 'mx-page__grow' }), this.summary, this.startBtn);
    this._sync();
  }

  _sync() {
    for (const b of this.diffBtns) {
      const on = b.__id === this.difficulty;
      b.classList.toggle('is-on', on);
      setAttr(b, 'aria-checked', on ? 'true' : 'false');
    }
    for (const b of this.mapBtns) {
      const on = b.__id === this.map;
      b.classList.toggle('is-on', on);
      setAttr(b, 'aria-checked', on ? 'true' : 'false');
    }
    const d = DIFFICULTIES.find((x) => x.id === this.difficulty);
    const m = (this.game.maps || []).find((x) => x.id === this.map);
    setText(this.summary, `${d ? d.label : ''} BOT · ${m ? m.name : ''}`);
    try { localStorage.setItem(BOT_KEY, JSON.stringify({ difficulty: this.difficulty, map: this.map })); } catch { /* ignore */ }
  }

  _start() {
    this.ui.act('startBot', { difficulty: this.difficulty, map: this.map });
  }

  onShow() {
    this._sync();
  }

  focusTarget() {
    return this.startBtn;
  }
}

// ---------------------------------------------------------------------------------------
// Join
// ---------------------------------------------------------------------------------------

const CODE_ALPHABET = new Set(NET.codeAlphabet.split(''));
const CODE_MAX = Math.max(6, NET.codeLength);

export function sanitizeCode(raw) {
  let s = String(raw || '').toUpperCase();
  const m = s.match(/[?&#]ROOM=([A-Z0-9]+)/);
  if (m) s = m[1];
  let out = '';
  for (const ch of s) if (CODE_ALPHABET.has(ch)) out += ch;
  return out.slice(0, CODE_MAX);
}

export class JoinScreen {
  constructor(ui, game) {
    this.ui = ui;
    this.game = game;
    this.pending = false;
    this.token = 0;
    const p = pageShell('join', { kicker: 'ONLINE DUEL', title: 'JOIN MATCH', sub: 'Ask the host for their room code or invite link.', onBack: () => this.cancel(), backLabel: 'CANCEL' });
    this.el = p.root;
    this.backBtn = p.back;

    this.input = el('input', {
      class: 'mx-code__input', type: 'text', maxlength: String(CODE_MAX), placeholder: '·'.repeat(NET.codeLength),
      spellcheck: 'false', autocomplete: 'off', autocapitalize: 'characters', inputmode: 'text', 'aria-label': 'Room code',
    });
    this.input.addEventListener('input', () => {
      const clean = sanitizeCode(this.input.value);
      if (clean !== this.input.value) this.input.value = clean;
      this._render();
      if (!this.pending && this.statusKind === 'error') this.setStatus('', 'info');
    });
    this.input.addEventListener('paste', (e) => {
      const t = e.clipboardData && e.clipboardData.getData('text');
      if (!t) return;
      e.preventDefault();
      this.input.value = sanitizeCode(t);
      this._render();
    });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); this.submit(); }
    });

    this.joinBtn = mxButton({ label: 'JOIN', icon: 'arrow', variant: 'primary', onClick: () => this.submit() });

    this.status = el('div', { class: 'mx-status', role: 'status', 'aria-live': 'polite' }, [
      el('span', { class: 'mx-status__dot', 'aria-hidden': 'true' }),
      (this.statusText = el('span', { class: 'mx-status__text' })),
    ]);
    this.statusKind = 'info';

    this.ctaCode = el('span', { class: 'mx-cta__code' });
    this.cta = mxButton({ label: 'JOIN MATCH', variant: 'primary big', cls: 'mx-cta', onClick: () => this.submit() });
    this.cta.querySelector('.mx-btn__text').append(el('span', { class: 'mx-cta__room' }, ['ROOM ', this.ctaCode]));
    this.cta.hidden = true;

    const box = el('div', { class: 'mx-join' }, [
      this.cta,
      el('div', { class: 'mx-join__label', text: 'ENTER ROOM CODE' }),
      el('div', { class: 'mx-code' }, [this.input, el('span', { class: 'mx-code__frame', 'aria-hidden': 'true' })]),
      el('div', { class: 'mx-join__actions' }, [this.joinBtn]),
      this.status,
      el('p', { class: 'mx-join__hint', text: `Codes are ${NET.codeLength} characters and never contain O, 0, I or 1. You can also paste the whole invite link.` }),
    ]);
    p.body.append(box);
    this.setStatus('', 'info');
    this._render();
  }

  code() {
    return sanitizeCode(this.input.value);
  }

  setStatus(text, kind = 'info') {
    this.statusKind = kind || 'info';
    setText(this.statusText, text || '');
    this.status.dataset.kind = this.pending && kind !== 'error' && kind !== 'success' ? 'pending' : this.statusKind;
    this.status.classList.toggle('is-empty', !text);
  }

  _render() {
    const c = this.code();
    setDisabled(this.joinBtn, this.pending || c.length < NET.codeLength);
    setDisabled(this.cta, this.pending || c.length < NET.codeLength);
    this.input.readOnly = this.pending;
    this.el.classList.toggle('is-pending', this.pending);
    setButtonLabel(this.joinBtn, this.pending ? 'CONNECTING…' : 'JOIN');
    this.joinBtn.classList.toggle('is-busy', this.pending);
    this.cta.classList.toggle('is-busy', this.pending);
    setText(this.ctaCode, c);
    setButtonLabel(this.backBtn, this.pending ? 'CANCEL JOIN' : 'CANCEL');
  }

  async submit() {
    if (this.pending) return;
    const code = this.code();
    if (code.length < NET.codeLength) {
      this.setStatus(`ENTER THE ${NET.codeLength}-CHARACTER ROOM CODE`, 'error');
      this._shake();
      return;
    }
    const token = ++this.token;
    this.pending = true;
    this.setStatus('CONNECTING…', 'pending');
    this._render();
    try {
      await this.game.actions.joinMatch(code);
      if (token !== this.token) return;
      this.pending = false;
      this.setStatus('CONNECTED', 'success');
    } catch (e) {
      if (token !== this.token) return;
      this.pending = false;
      this.setStatus(friendlyNetError(e), 'error');
      this._shake();
    } finally {
      if (token === this.token) {
        this.pending = false;
        this._render();
      }
    }
  }

  cancel() {
    if (this.pending) {
      this.token++;
      this.pending = false;
      try { this.game.actions.cancelJoin(); } catch (e) { console.warn('[ui] cancelJoin failed', e); }
    }
    this.setStatus('', 'info');
    this._render();
    this.ui.back();
  }

  _shake() {
    const box = this.input.parentElement;
    box.classList.remove('is-shake');
    void box.offsetWidth;
    box.classList.add('is-shake');
  }

  onBack() {
    this.cancel();
    return true;
  }

  onShow(data) {
    const code = data && data.code ? sanitizeCode(data.code) : '';
    if (code) this.input.value = code;
    this.cta.hidden = !code;
    if (!this.pending && this.statusKind !== 'error') this.setStatus('', 'info');
    this._render();
    // Focus the input (or the invite CTA) so the user can type immediately.
    setTimeout(() => {
      if (this.ui.current !== 'join') return;
      const t = code ? this.cta : this.input;
      try { t.focus({ preventScroll: true }); } catch { /* ignore */ }
      if (t === this.input) this.input.select();
    }, 60);
  }

  focusTarget() {
    return this.cta.hidden ? this.input : this.cta;
  }
}

// ---------------------------------------------------------------------------------------
// Pause
// ---------------------------------------------------------------------------------------

const MODE_LABEL = { duel: 'ONLINE DUEL', bot: 'PRACTICE VS BOT', training: 'TRAINING' };

export class PauseScreen {
  constructor(ui, game) {
    this.ui = ui;
    this.game = game;
    this.data = { online: false, mode: 'duel' };
    this.el = screenShell('pause');

    this.modeText = el('span', { class: 'mx-pause__mode' });
    this.note = el('div', { class: 'mx-pause__note' }, [
      el('span', { class: 'mx-pause__noteicon', html: ICONS.warn, 'aria-hidden': 'true' }),
      el('span', { text: 'Online match is still running — your opponent can still see you.' }),
    ]);

    this.resumeBtn = mxButton({ label: 'RESUME', icon: 'play', variant: 'primary', onClick: () => {
      // Pointer lock must be requested synchronously inside this click.
      this.ui.act('resume');
    } });
    this.settingsBtn = mxButton({ label: 'SETTINGS', onClick: () => ui.show('settings') });
    this.controlsBtn = mxButton({ label: 'CONTROLS', onClick: () => ui.show('controls') });
    this.fsBtn = mxButton({ label: 'FULLSCREEN', icon: 'fullscreen', onClick: () => ui.act('toggleFullscreen') });
    this.resetBtn = mxButton({ label: 'RESET TRAINING STATS', onClick: () => {
      ui.act('resetTrainingStats');
      ui.toast('TRAINING STATS RESET', 'success', 1800);
    } });
    this.leaveBtn = mxButton({ label: 'LEAVE MATCH', variant: 'danger', onClick: () => this._confirm(true) });
    this.yesBtn = mxButton({ label: 'YES, LEAVE', variant: 'danger small', sound: 'back', onClick: () => { this._confirm(false); ui.act('leaveMatch'); } });
    this.noBtn = mxButton({ label: 'NO', variant: 'ghost small', sound: 'back', onClick: () => { this._confirm(false); this.leaveBtn.focus(); } });
    this.confirmRow = el('div', { class: 'mx-confirm', hidden: true }, [el('span', { class: 'mx-confirm__q', text: 'LEAVE?' }), this.yesBtn, this.noBtn]);

    const nav = el('nav', { class: 'mx-pause__nav', 'data-nav': '' }, [
      this.resumeBtn, this.settingsBtn, this.controlsBtn, this.fsBtn, this.resetBtn, this.leaveBtn, this.confirmRow,
    ]);

    this.el.append(
      el('div', { class: 'mx-pause__veil', 'aria-hidden': 'true' }),
      el('div', { class: 'mx-pause__panel' }, [
        el('div', { class: 'mx-kicker' }, [el('span', { class: 'mx-kicker__bar' }), this.modeText]),
        el('h2', { class: 'mx-pause__title mx-glitch', 'data-text': 'PAUSED', text: 'PAUSED' }),
        this.note,
        nav,
        el('div', { class: 'mx-pause__hint' }, ['Click ', el('b', { text: 'RESUME' }), ' to lock the mouse and get back in.']),
      ]),
    );
    this.onFullscreen(false);
  }

  _confirm(on) {
    this.leaveBtn.hidden = on;
    this.confirmRow.hidden = !on;
    if (on) setTimeout(() => this.noBtn.focus({ preventScroll: true }), 0);
  }

  onFullscreen(fs) {
    setButtonLabel(this.fsBtn, fs ? 'EXIT FULLSCREEN' : 'FULLSCREEN');
  }

  onShow(data) {
    if (data && (data.mode || data.online != null)) this.data = { online: !!data.online, mode: data.mode || 'duel' };
    const { online, mode } = this.data;
    setText(this.modeText, MODE_LABEL[mode] || 'MATCH');
    this.note.hidden = !online;
    this.resetBtn.hidden = mode !== 'training';
    setButtonLabel(this.leaveBtn, mode === 'training' ? 'EXIT TRAINING' : 'LEAVE MATCH');
    setButtonLabel(this.yesBtn, mode === 'training' ? 'YES, EXIT' : 'YES, LEAVE');
    this._confirm(false);
    this.onFullscreen(this.ui.isFullscreen());
  }

  onBack() {
    // Esc in pause is owned by the browser's pointer-lock handling; never navigate.
    return true;
  }

  focusTarget() {
    return this.resumeBtn;
  }
}

// ---------------------------------------------------------------------------------------
// Quit
// ---------------------------------------------------------------------------------------

export class QuitScreen {
  constructor(ui, game) {
    this.ui = ui;
    this.game = game;
    this.el = screenShell('quit');
    this.backBtn = mxButton({ label: 'BACK TO MENU', icon: 'back', variant: 'primary', onClick: () => ui.show('main') });
    this.el.append(
      el('div', { class: 'mx-quit' }, [
        el('div', { class: 'mx-quit__emblem', html: emblemSVG() }),
        el('h2', { class: 'mx-quit__title', text: 'THANKS FOR PLAYING' }),
        el('p', { class: 'mx-quit__text', text: 'You can close this tab now.' }),
        el('p', { class: 'mx-quit__tag', text: 'STAY CHARGED.' }),
        this.backBtn,
      ]),
    );
  }

  onShow() {}

  onBack() {
    return true;
  }

  focusTarget() {
    return this.backBtn;
  }
}

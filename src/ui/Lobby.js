// MONSTER-X: DUEL ARENA - online room lobby (host + guest views).
// The game keeps this current through ui.lobby.update(data); every write is diffed.
import { NET } from '../config.js';
import {
  el, setText, setAttr, setDisabled, setHidden, mxButton, setButtonLabel, emblemSVG, ICONS, mapThumb, screenShell,
} from './MainMenu.js';

const INVITE_PREFIX = 'Join my Monster-X 1v1:\n';

function pingClass(ping) {
  if (ping == null || !Number.isFinite(ping)) return 'none';
  if (ping <= 60) return 'good';
  if (ping <= 120) return 'ok';
  return 'bad';
}

function statusKind(text, connected) {
  const t = String(text || '').toUpperCase();
  if (/FAIL|ERROR|LOST|CLOSED|REJECT/.test(t)) return 'error';
  if (/RECONNECT|DISCONNECT/.test(t)) return 'warn';
  if (/…|\.\.\.|WAITING|CREATING|CONNECTING/.test(t)) return 'pending';
  return connected ? 'ok' : 'info';
}

class PlayerCard {
  constructor(index) {
    this.index = index;
    const side = index === 0 ? 'p1' : 'p2';
    this.el = el('div', { class: `mx-pcard mx-pcard--${side}` });
    this.role = el('span', { class: 'mx-pcard__role' });
    this.you = el('span', { class: 'mx-pcard__you', text: 'YOU' });
    this.name = el('div', { class: 'mx-pcard__name' });
    this.waitText = el('span', { class: 'mx-pcard__waittext' });
    this.wait = el('div', { class: 'mx-pcard__wait' }, [this.waitText, el('span', { class: 'mx-dots', 'aria-hidden': 'true' })]);
    this.ready = el('span', { class: 'mx-badge mx-badge--ready' });
    this.conn = el('span', { class: 'mx-badge mx-badge--conn' }, [el('i', { class: 'mx-badge__dot' }), (this.connText = el('span'))]);
    this.el.append(
      el('div', { class: 'mx-pcard__glow', 'aria-hidden': 'true' }),
      el('div', { class: 'mx-pcard__head' }, [
        el('span', { class: 'mx-pcard__side', text: `PLAYER ${index + 1}` }),
        this.role,
        this.you,
      ]),
      el('div', { class: 'mx-pcard__avatar', 'aria-hidden': 'true' }, [el('span', { text: String(index + 1) })]),
      this.name,
      this.wait,
      el('div', { class: 'mx-pcard__badges' }, [this.ready, this.conn]),
      el('div', { class: 'mx-pcard__scan', 'aria-hidden': 'true' }),
    );
  }

  render(p, data) {
    const isHostSlot = this.index === 0;
    const meConnected = data.role === 'host' || data.connected;
    const empty = !p || (!p.connected && !p.isMe && !p.name);
    this.el.classList.toggle('is-empty', empty);
    this.el.classList.toggle('is-me', !!(p && p.isMe));
    setText(this.role, isHostSlot ? 'HOST' : 'GUEST');
    setHidden(this.you, !(p && p.isMe));
    if (empty) {
      setText(this.name, '');
      setText(this.waitText, isHostSlot ? 'CONNECTING TO HOST' : 'WAITING FOR PLAYER');
      setHidden(this.wait, false);
      setHidden(this.ready, true);
      setHidden(this.conn, true);
      this.el.classList.remove('is-ready', 'is-offline');
      return;
    }
    setHidden(this.wait, true);
    setHidden(this.ready, false);
    setHidden(this.conn, false);
    setText(this.name, (p.name || `PLAYER ${this.index + 1}`).toUpperCase());
    const ready = !!p.ready;
    const connected = !!p.connected || (p.isMe && meConnected);
    this.el.classList.toggle('is-ready', ready);
    this.el.classList.toggle('is-offline', !connected);
    setText(this.ready, ready ? 'READY' : 'NOT READY');
    this.ready.classList.toggle('is-on', ready);
    setText(this.connText, connected ? 'CONNECTED' : 'DISCONNECTED');
    this.conn.classList.toggle('is-off', !connected);
  }
}

export class LobbyView {
  constructor(ui, game) {
    this.ui = ui;
    this.game = game;
    const maps = Array.isArray(game.maps) ? game.maps : [];
    this.data = {
      role: 'host', code: null, invite: null, status: '', connected: false,
      players: [null, null], ping: null, map: (maps[0] && maps[0].id) || 'blackout', canStart: false, backend: '',
    };
    this.el = screenShell('lobby', 'mx-page');

    // ---- header
    this.statusText = el('span', { class: 'mx-status__text' });
    this.status = el('div', { class: 'mx-status mx-lobby__status', role: 'status', 'aria-live': 'polite' }, [
      el('span', { class: 'mx-status__dot', 'aria-hidden': 'true' }),
      this.statusText,
    ]);
    const header = el('header', { class: 'mx-lobby__header' }, [
      el('div', { class: 'mx-lobby__brand' }, [
        el('span', { class: 'mx-lobby__emblem', html: emblemSVG() }),
        el('span', { class: 'mx-lobby__brandtext' }, [el('b', { text: 'MONSTER-X' }), ' DUEL ARENA']),
      ]),
      el('span', { class: 'mx-lobby__grow' }),
      this.status,
    ]);

    // ---- room code block
    this.codeCells = [];
    const cells = el('div', { class: 'mx-roomcode', 'aria-label': 'Room code' });
    for (let i = 0; i < Math.max(6, NET.codeLength); i++) {
      const c = el('span', { class: 'mx-roomcode__cell', text: '·' });
      c.style.setProperty('--i', i);
      cells.append(c);
      this.codeCells.push(c);
    }
    this.copyCodeBtn = mxButton({ label: 'COPY CODE', icon: 'copy', variant: 'small', onClick: () => this._copyCode() });
    this.copyInviteBtn = mxButton({ label: 'COPY INVITE', icon: 'link', variant: 'small primary', onClick: () => this._copyInvite() });
    this.inviteUrl = el('input', { class: 'mx-roomurl', type: 'text', readonly: true, spellcheck: 'false', 'aria-label': 'Invite link', tabindex: '-1', 'data-esc': 'blur' });
    this.inviteUrl.addEventListener('focus', () => this.inviteUrl.select());
    this.roomHint = el('p', { class: 'mx-room__hint' });
    const room = el('div', { class: 'mx-room' }, [
      el('div', { class: 'mx-room__main' }, [
        el('span', { class: 'mx-room__label', text: 'ROOM' }),
        cells,
      ]),
      el('div', { class: 'mx-room__actions' }, [this.copyCodeBtn, this.copyInviteBtn]),
      this.inviteUrl,
      this.roomHint,
    ]);

    // ---- player cards + VS
    this.cards = [new PlayerCard(0), new PlayerCard(1)];
    this.pingVal = el('span', { class: 'mx-ping__val', text: '—' });
    this.pingWrap = el('div', { class: 'mx-ping', dataset: { q: 'none' } }, [el('span', { class: 'mx-ping__label', text: 'PING:' }), this.pingVal]);
    const versus = el('div', { class: 'mx-versus' }, [
      el('div', { class: 'mx-versus__vs', text: 'VS' }),
      this.pingWrap,
    ]);
    const duel = el('div', { class: 'mx-duel' }, [this.cards[0].el, versus, this.cards[1].el]);

    // ---- map selector
    this.mapBtns = [];
    this.mapNote = el('span', { class: 'mx-section__note' });
    const mapList = el('div', { class: 'mx-maps mx-maps--lobby', role: 'radiogroup', 'aria-label': 'Arena' });
    for (const m of maps) {
      const b = el('button', { type: 'button', class: 'mx-mapcard', role: 'radio', 'aria-checked': 'false' }, [
        mapThumb(m.id),
        el('span', { class: 'mx-mapcard__info' }, [
          el('span', { class: 'mx-mapcard__name', text: m.name }),
          el('span', { class: 'mx-mapcard__desc', text: m.desc || '' }),
        ]),
        el('span', { class: 'mx-mapcard__check', html: ICONS.check, 'aria-hidden': 'true' }),
      ]);
      b.__id = m.id;
      b.addEventListener('click', () => this._pickMap(m.id));
      this.mapBtns.push(b);
      mapList.append(b);
    }
    const mapSection = el('div', { class: 'mx-section mx-lobby__maps' }, [
      el('h3', { class: 'mx-section__title' }, [el('span', { text: 'ARENA' }), this.mapNote]),
      mapList,
    ]);

    // ---- ready / start
    this.readyBtn = mxButton({ label: 'READY UP', sub: 'Lock in when you are set', icon: 'check', cls: 'mx-readybtn', onClick: () => this._toggleReady() });
    this.startBtn = mxButton({ label: 'START MATCH', icon: 'play', variant: 'primary', cls: 'mx-startbtn', onClick: () => this._start() });
    this.startReason = el('p', { class: 'mx-lobby__reason' });
    this.guestWait = el('div', { class: 'mx-waitplate' }, [el('span', { text: 'WAITING FOR HOST TO START' }), el('span', { class: 'mx-dots', 'aria-hidden': 'true' })]);
    const controls = el('div', { class: 'mx-section mx-lobby__ctl' }, [
      el('h3', { class: 'mx-section__title', text: 'MATCH' }),
      el('div', { class: 'mx-lobby__rules' }, [
        el('span', { text: 'FIRST TO 15' }), el('i'), el('span', { text: '8:00 CLOCK' }), el('i'), el('span', { text: 'SUDDEN DEATH ON TIE' }),
      ]),
      this.readyBtn,
      this.startBtn,
      this.guestWait,
      this.startReason,
    ]);

    // ---- footer
    this.leaveBtn = mxButton({ label: 'LEAVE', icon: 'back', variant: 'ghost small danger', sound: 'back', onClick: () => this.ui.act('leaveRoom') });
    this.backend = el('span', { class: 'mx-lobby__backend' });
    const foot = el('footer', { class: 'mx-page__foot' }, [this.leaveBtn, el('span', { class: 'mx-page__grow' }), el('span', { class: 'mx-lobby__netico', html: ICONS.signal }), this.backend]);

    this.el.append(
      el('div', { class: 'mx-page__veil', 'aria-hidden': 'true' }),
      header,
      el('div', { class: 'mx-page__body mx-lobby' }, [
        room,
        duel,
        el('div', { class: 'mx-lobby__bottom' }, [mapSection, controls]),
      ]),
      foot,
    );
    this._render();
  }

  /** Full or partial lobby state from the game. */
  update(data) {
    if (!data || typeof data !== 'object') return;
    for (const k in data) this.data[k] = data[k];
    this._render();
  }

  /** Status line on the JOIN screen (used by the game while a join is in progress). */
  setJoinStatus(text, kind = 'info') {
    const join = this.ui.screens && this.ui.screens.join;
    if (join) join.setStatus(text, kind);
  }

  _myIndex() {
    const ps = this.data.players || [];
    for (let i = 0; i < 2; i++) if (ps[i] && ps[i].isMe) return i;
    return this.data.role === 'guest' ? 1 : 0;
  }

  _render() {
    const d = this.data;
    const isHost = d.role !== 'guest';
    const ps = Array.isArray(d.players) ? d.players : [];

    // Status + backend
    setText(this.statusText, d.status || (d.connected ? 'CONNECTED' : ''));
    const kind = statusKind(d.status, d.connected);
    if (this.status.dataset.kind !== kind) this.status.dataset.kind = kind;
    let backend = d.backend;
    if (!backend) {
      try { backend = (this.game.netInfo && this.game.netInfo().backend) || ''; } catch { backend = ''; }
    }
    setText(this.backend, backend ? `SIGNALING · ${backend}` : '');

    // Room code
    const code = d.code ? String(d.code).toUpperCase() : '';
    const len = Math.max(NET.codeLength, code.length);
    for (let i = 0; i < this.codeCells.length; i++) {
      const c = this.codeCells[i];
      setHidden(c, i >= len);
      setText(c, code ? code[i] || '' : '·');
    }
    this.el.classList.toggle('is-nocode', !code);
    setDisabled(this.copyCodeBtn, !code);
    let invite = d.invite;
    if (!invite && code) {
      try { invite = this.game.actions.inviteLink(); } catch { invite = null; }
    }
    setDisabled(this.copyInviteBtn, !invite);
    if (this.inviteUrl.value !== (invite || '')) this.inviteUrl.value = invite || '';
    setHidden(this.inviteUrl, !invite);
    setText(this.roomHint, !code
      ? 'Setting up your room…'
      : isHost
        ? 'Send the code or invite link to your opponent. The room stays open while you wait.'
        : 'You are in the room. Ready up when you are set.');

    // Players
    this.cards[0].render(ps[0], d);
    this.cards[1].render(ps[1], d);

    // Ping
    const ping = d.ping;
    const q = pingClass(ping);
    if (this.pingWrap.dataset.q !== q) this.pingWrap.dataset.q = q;
    setText(this.pingVal, q === 'none' ? '—' : `${Math.round(ping)}ms`);

    // Maps
    const selected = d.map;
    for (const b of this.mapBtns) {
      const on = b.__id === selected;
      b.classList.toggle('is-on', on);
      setAttr(b, 'aria-checked', on ? 'true' : 'false');
      setDisabled(b, !isHost);
      b.classList.toggle('is-readonly', !isHost);
    }
    setText(this.mapNote, isHost ? 'YOU PICK THE ARENA' : 'HOST PICKS THE ARENA');

    // Ready / start
    const mi = this._myIndex();
    const me = ps[mi];
    const ready = !!(me && me.ready);
    const opp = ps[1 - mi];
    const oppHere = !!(opp && opp.connected);
    setButtonLabel(this.readyBtn, ready ? 'READY ✓' : 'READY UP');
    const sub = this.readyBtn.querySelector('.mx-btn__sub');
    if (sub) setText(sub, ready ? 'Click to stand down' : 'Lock in when you are set');
    this.readyBtn.classList.toggle('is-on', ready);
    setAttr(this.readyBtn, 'aria-pressed', ready ? 'true' : 'false');
    setDisabled(this.readyBtn, !isHost && !d.connected);

    setHidden(this.startBtn, !isHost);
    setHidden(this.guestWait, isHost);
    setDisabled(this.startBtn, !d.canStart);
    this.startBtn.classList.toggle('is-armed', !!d.canStart);
    let reason = '';
    if (isHost && !d.canStart) {
      if (!oppHere) reason = 'WAITING FOR AN OPPONENT TO JOIN';
      else if (!ready || !(opp && opp.ready)) reason = 'BOTH PLAYERS MUST BE READY';
      else reason = 'GETTING READY…';
    } else if (isHost) reason = 'ALL SET — START WHEN YOU ARE';
    else if (!oppHere) reason = 'HOST CONNECTION LOST';
    setText(this.startReason, reason);
    this.startReason.classList.toggle('is-go', isHost && !!d.canStart);
  }

  _pickMap(id) {
    if (this.data.role === 'guest' || this.data.map === id) return;
    this.data.map = id;
    this._render();
    this.ui.act('selectMap', id);
  }

  _toggleReady() {
    const mi = this._myIndex();
    const ps = this.data.players || [];
    const me = ps[mi];
    const next = !(me && me.ready);
    if (me) {
      // Optimistic; the next update() from the game is authoritative.
      ps[mi] = { ...me, ready: next };
      this._render();
    }
    this.ui.act('setReady', next);
  }

  _start() {
    if (!this.data.canStart || this.data.role === 'guest') return;
    this.ui.act('startMatch');
  }

  async _copyCode() {
    const code = this.data.code;
    if (!code) return;
    let ok = false;
    try { ok = await this.game.actions.copyText(String(code)); } catch { ok = false; }
    if (ok) this.ui.toast('ROOM CODE COPIED', 'success');
    else this.ui.toast(`COPY FAILED — YOUR CODE IS ${code}`, 'error', 4200);
  }

  async _copyInvite() {
    let url = this.data.invite;
    if (!url) {
      try { url = this.game.actions.inviteLink(); } catch { url = null; }
    }
    if (!url) {
      this.ui.toast('INVITE LINK NOT READY YET', 'error');
      return;
    }
    let ok = false;
    try { ok = await this.game.actions.copyText(INVITE_PREFIX + url); } catch { ok = false; }
    if (ok) this.ui.toast('INVITE LINK COPIED — SEND IT TO YOUR OPPONENT', 'success');
    else {
      this.ui.toast('COPY FAILED — SELECT THE LINK BELOW AND COPY IT', 'error', 4200);
      try { this.inviteUrl.focus(); this.inviteUrl.select(); } catch { /* ignore */ }
    }
  }

  onShow() {
    this._render();
    this.el.classList.remove('is-enter');
    void this.el.offsetWidth;
    this.el.classList.add('is-enter');
  }

  onBack() {
    // Esc does not leave a room by accident; use the LEAVE button.
    return true;
  }

  focusTarget() {
    return this.readyBtn;
  }
}

// NetSession: room lifecycle (host / join), WebRTC link management, ping + clock sync,
// packet stats, disconnect detection and the 15 second reconnection window.
//
// Events: 'status' (text), 'connected', 'disconnected' (reconnecting), 'reconnected',
//         'closed' ({reason}), 'message' (reliable obj), 'state' (ArrayBuffer snapshot)
import { NET, PROTOCOL_VERSION } from './config.js';
import { PeerLink } from './network/webrtc.js';
import { generateRoomCode, signalingBackend } from './network/rooms.js';
import { ClockSync, LossTracker, RateCounter, PKT, encodePing, decodePing } from './network/sync.js';

const now = () => performance.now();

export class NetSession {
  constructor({ name = 'PLAYER' } = {}) {
    this.name = name;
    this.role = null; // 'host' | 'guest'
    this.code = null;
    this.state = 'idle';
    this.signal = null;
    this.link = null;
    this.clock = new ClockSync();
    this.loss = new LossTracker();
    this.sent = new RateCounter();
    this.recv = new RateCounter();
    this.handlers = {};
    this.peerName = '';
    this.guestToken = null;
    this.myToken = null;
    this.lastRecv = 0;
    this.pingTimer = null;
    this.watchTimer = null;
    this.reconnectDeadline = 0;
    this.reconnectTimer = null;
    this.closed = false;
    this.rttStats = null;
    this.pendingGuest = null;
    try { this.debug = new URLSearchParams(location.search).has('netdebug'); } catch { this.debug = false; }
  }

  on(evt, fn) { (this.handlers[evt] ||= []).push(fn); return this; }
  _log(...a) { if (this.debug) console.log('[net]', this.role, ...a); }
  off(evt, fn) { this.handlers[evt] = (this.handlers[evt] || []).filter((f) => f !== fn); }
  emit(evt, ...a) { for (const fn of this.handlers[evt] || []) { try { fn(...a); } catch (e) { console.error(e); } } }
  status(text) { this.statusText = text; this.emit('status', text); }

  get backendLabel() { return this.signal?.label || ''; }
  get connected() { return this.state === 'connected' && this.link?.isOpen; }
  /** Host-clock time in ms (host: local clock). */
  now() { return this.role === 'guest' ? now() + this.clock.offset : now(); }
  get rtt() { return this.rttStats ?? this.clock.rtt; }
  get iceState() { return this.link?.pc?.iceConnectionState || 'new'; }
  get pcState() { return this.link?.pc?.connectionState || 'new'; }

  // ----------------------------------------------------------------- host
  async host() {
    this.role = 'host';
    this.state = 'creating';
    this.signal = signalingBackend();
    this.signal.onMessage((m, src) => this._hostSignal(m, src));
    this.status('CREATING ROOM…');
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = generateRoomCode();
      try {
        await this.signal.host(code);
        this.code = code;
        this.state = 'waiting';
        this.status('WAITING FOR PLAYER…');
        return code;
      } catch (e) {
        if (e.message !== 'ID_TAKEN') throw e;
      }
    }
    throw new Error('Could not allocate a room code');
  }

  _hostSignal(m, src) {
    if (this.closed) return;
    if (m.k === 'hello') {
      if (m.v !== PROTOCOL_VERSION) {
        this.signal.replyTo(src, { k: 'welcome', accept: false, reason: 'version' });
        return;
      }
      const sameGuest = !!this.guestToken && m.token === this.guestToken;
      this._log('hello from', src, 'state', this.state, 'sameGuest', sameGuest);
      let accept = false;
      if (sameGuest && (this.state === 'connected' || this.state === 'reconnecting')) {
        // The same player is re-handshaking (network drop or page reload): resume the match.
        if (this.state === 'connected') this._enterReconnecting('peer-rejoin');
        accept = true;
      } else if (this.state === 'waiting' || (this.state === 'connecting' && sameGuest)) {
        accept = true;
        this.state = 'connecting';
        this.status('CONNECTING…');
      }
      if (!accept) {
        this.signal.replyTo(src, { k: 'welcome', accept: false, reason: 'full' });
        return;
      }
      this.guestToken = m.token;
      this.peerName = m.name || 'PLAYER 2';
      this.signal.pair(src);
      this.signal.replyTo(src, { k: 'welcome', accept: true, name: this.name, v: PROTOCOL_VERSION });
      this._newLink(false);
      return;
    }
    if (m.k === 'bye') { if (this.link || this.state === 'reconnecting') this._peerLeft('left'); return; }
    if ((m.k === 'sdp' || m.k === 'ice') && this.link) this.link.handleSignal(m);
  }

  // ----------------------------------------------------------------- guest
  async join(code) {
    this.role = 'guest';
    this.code = code;
    this.state = 'joining';
    // Persist the resume token per room so a page reload can rejoin a running match.
    const key = 'mx-token-' + code;
    try { this.myToken = sessionStorage.getItem(key); } catch { this.myToken = null; }
    if (!this.myToken) {
      this.myToken = Math.random().toString(36).slice(2, 12);
      try { sessionStorage.setItem(key, this.myToken); } catch { /* ignore */ }
    }
    this.signal = signalingBackend();
    this.signal.onMessage((m) => this._guestSignal(m));
    this.status('FINDING ROOM…');
    const welcome = await this.signal.join(code, { name: this.name, token: this.myToken, v: PROTOCOL_VERSION });
    this.peerName = welcome.name || 'PLAYER 1';
    this.state = 'connecting';
    this.status('CONNECTING…');
    this._newLink(true);
    await this.link.start();
  }

  _guestSignal(m) {
    if (this.closed) return;
    if (m.k === 'bye') { this._peerLeft('left'); return; }
    if (m.k === 'welcome') {
      // Reconnection welcome: start one fresh handshake (ignore duplicates while it negotiates).
      if (this.state === 'reconnecting' && m.accept && !this._attemptInFlight()) {
        this.attemptAt = now();
        this._newLink(true);
        this.link.start();
      }
      return;
    }
    if ((m.k === 'sdp' || m.k === 'ice') && this.link) this.link.handleSignal(m);
  }

  // ----------------------------------------------------------------- link
  _newLink(initiator) {
    this._log('new link', initiator ? '(offerer)' : '(answerer)', 'state', this.state);
    if (this.link) { const old = this.link; this.link = null; old.close(); }
    const link = new PeerLink({ initiator, sendSignal: (msg) => this.signal.send(msg) });
    this.link = link;
    link.on('open', () => {
      if (this.link !== link) return;
      const wasReconnecting = this.state === 'reconnecting';
      this.state = 'connected';
      this.lastRecv = now();
      this.loss.reset();
      this._startPing();
      this.status('CONNECTED');
      this.emit(wasReconnecting ? 'reconnected' : 'connected');
      if (this.role === 'host') this.signal.setStatus?.('playing');
    });
    link.on('close', (reason) => {
      if (this.link !== link || this.closed) return;
      this._linkLost(reason);
    });
    link.on('message', (data, fast) => this._onData(data, fast));
    link.on('state', (s) => { this._log('pc', s); this.emit('pcstate', s); });
    // Fail fast if ICE never completes.
    setTimeout(() => {
      if (this.link === link && !link.opened && !this.closed && this.state === 'connecting') {
        console.warn('[net] connection attempt timed out');
        if (this.role === 'guest') {
          this.emit('closed', { reason: 'ice-failed' });
          this.leave(false);
        } else this._resetToWaiting();
      }
    }, 20000);
  }

  _onData(data, fast) {
    this.lastRecv = now();
    this.recv.tick();
    if (fast) {
      if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return;
      const type = new DataView(data).getUint8(0);
      if (type === PKT.PING) {
        const p = decodePing(data);
        this.link?.sendFast(encodePing(PKT.PONG, p.a, now()));
      } else if (type === PKT.PONG) {
        const p = decodePing(data);
        const t1 = now();
        if (this.role === 'guest') this.clock.addSample(p.a, p.b, t1);
        else this.clock.addSample(p.a, p.b, t1); // host: offset unused, rtt used
      } else if (type === PKT.STATE) {
        this.emit('state', data);
      }
      return;
    }
    if (data && data.t === '__bye') { this._peerLeft('left'); return; }
    this.emit('message', data);
  }

  _startPing() {
    clearInterval(this.pingTimer);
    clearInterval(this.watchTimer);
    const ping = () => this.link?.sendFast(encodePing(PKT.PING, now()));
    ping();
    this.pingTimer = setInterval(async () => {
      ping();
      if (this.link) {
        const r = await this.link.selectedRtt();
        if (r != null) this.rttStats = this.rttStats == null ? r : this.rttStats * 0.6 + r * 0.4;
      }
    }, 500);
    this.watchTimer = setInterval(() => {
      if (this.state === 'connected' && now() - this.lastRecv > NET.timeoutMs) this._linkLost('timeout');
    }, 500);
  }

  _linkLost(reason) {
    if (this.closed || this.state === 'reconnecting') return;
    console.warn('[net] link lost:', reason);
    clearInterval(this.pingTimer);
    clearInterval(this.watchTimer);
    if (this.state !== 'connected') {
      // Never connected: a failed attempt.
      if (this.role === 'host') this._resetToWaiting();
      else { this.emit('closed', { reason: 'connect-failed' }); this.leave(false); }
      return;
    }
    this._enterReconnecting(reason);
    if (this.role === 'guest') this._guestReconnectLoop();
  }

  _enterReconnecting(reason) {
    clearInterval(this.pingTimer);
    clearInterval(this.watchTimer);
    this.state = 'reconnecting';
    this.reconnectDeadline = now() + NET.reconnectWindow * 1000 + (this.role === 'guest' ? 0 : 3000);
    this.status('RECONNECTING…');
    this.emit('disconnected', { reason });
    clearInterval(this.reconnectTimer);
    this.reconnectTimer = setInterval(() => {
      if (this.state !== 'reconnecting') { clearInterval(this.reconnectTimer); return; }
      if (now() > this.reconnectDeadline) {
        clearInterval(this.reconnectTimer);
        this._peerLeft('timeout');
      }
    }, 250);
  }

  _resetToWaiting() {
    if (this.link) { const l = this.link; this.link = null; l.close(); }
    this.state = 'waiting';
    this.guestToken = null;
    this.signal?.pair?.(null);
    this.status('WAITING FOR PLAYER…');
  }

  /** True while a reconnection handshake is still negotiating (and not yet stale). */
  _attemptInFlight() {
    return !!this.link && !this.link.closed && !this.link.opened && now() - (this.attemptAt || 0) < 7000;
  }

  async _guestReconnectLoop() {
    this.attemptAt = 0;
    while (this.state === 'reconnecting' && !this.closed && now() < this.reconnectDeadline) {
      // Only knock again when no handshake is in flight; re-sending would make the host
      // tear down a half-negotiated connection and start over.
      if (!this._attemptInFlight()) {
        try {
          const ok = this.signal.send({ k: 'hello', name: this.name, token: this.myToken, v: PROTOCOL_VERSION });
          this._log('reconnect hello', ok ? 'sent' : 'NOT SENT (signaling down)');
        } catch (e) { this._log('reconnect hello failed', e?.message); }
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  get reconnectRemaining() {
    return Math.max(0, (this.reconnectDeadline - now()) / 1000);
  }

  _peerLeft(reason) {
    clearInterval(this.pingTimer);
    clearInterval(this.watchTimer);
    clearInterval(this.reconnectTimer);
    if (this.link) { const l = this.link; this.link = null; l.close(); }
    if (this.role === 'host' && !this.closed) {
      // Keep the room open for a new opponent.
      this.state = 'waiting';
      this.guestToken = null;
      this.peerName = '';
      this.signal.pair?.(null);
      this.signal.releaseGuest?.();
      this.signal.setStatus?.('open');
      this.status('WAITING FOR PLAYER…');
      this.emit('closed', { reason, roomOpen: true });
    } else if (!this.closed) {
      this.emit('closed', { reason });
      this.leave(false);
    }
  }

  // ----------------------------------------------------------------- send
  send(type, data = {}) {
    const ok = this.link?.sendReliable({ t: type, ...data });
    if (ok) this.sent.tick();
    return ok;
  }

  sendState(buf) {
    const ok = this.link?.sendFast(buf);
    if (ok) this.sent.tick();
    return ok;
  }

  stats() {
    return {
      rtt: this.rtt,
      loss: this.loss.loss,
      sent: this.sent.update(),
      recv: this.recv.update(),
      pc: this.pcState,
      ice: this.iceState,
      code: this.code,
      role: this.role,
      backend: this.backendLabel,
    };
  }

  leave(notify = true) {
    if (this.closed) return;
    this.closed = true;
    if (notify) { try { this.link?.sendReliable({ t: '__bye' }); } catch { /* ignore */ } }
    clearInterval(this.pingTimer);
    clearInterval(this.watchTimer);
    clearInterval(this.reconnectTimer);
    setTimeout(() => {
      try { this.link?.close(); } catch { /* ignore */ }
      try { this.signal?.close(); } catch { /* ignore */ }
    }, notify ? 150 : 0);
    this.state = 'closed';
  }
}

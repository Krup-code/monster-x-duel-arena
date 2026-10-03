// Zero-config signaling over a PeerJS-compatible broker (default: the free public
// 0.peerjs.com cloud server, or your own `npx peerjs --port 9000`). We only use the
// broker's WebSocket relay to exchange room handshakes, SDP and ICE; all gameplay goes
// over the direct WebRTC DataChannels.
//
// Protocol (peerjs-server v1): connect wss://host/path/peerjs?key=K&id=ID&token=T,
// receive {type:'OPEN'}; send {type, dst, payload}; receive {type, src, payload};
// messages to an offline id come back as {type:'EXPIRE', src:dst}.

import { NET } from '../config.js';

function randToken() {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}

export function peerjsConfig() {
  const env = import.meta.env || {};
  const params = new URLSearchParams(location.search);
  const host = params.get('signal') || env.VITE_PEERJS_HOST || '0.peerjs.com';
  const local = /^(localhost|127\.0\.0\.1)$/.test(host);
  return {
    host,
    port: Number(params.get('signalPort') || env.VITE_PEERJS_PORT || (local ? 9000 : 443)),
    path: env.VITE_PEERJS_PATH || '/',
    key: env.VITE_PEERJS_KEY || 'peerjs',
    secure: params.has('signalInsecure') ? false : env.VITE_PEERJS_SECURE ? env.VITE_PEERJS_SECURE !== 'false' : !local,
  };
}

class BrokerSocket {
  constructor(cfg) {
    this.cfg = cfg;
    this.ws = null;
    this.id = null;
    this.token = randToken();
    this.onMessage = () => {};
    this.onLost = () => {};
    this.hb = null;
    this.closedByUser = false;
    this.reconnects = 0;
  }

  url(id) {
    const c = this.cfg;
    const path = c.path.endsWith('/') ? c.path : c.path + '/';
    return `${c.secure ? 'wss' : 'ws'}://${c.host}:${c.port}${path}peerjs?key=${encodeURIComponent(c.key)}&id=${encodeURIComponent(id)}&token=${this.token}&version=1.5.4`;
  }

  open(id) {
    this.id = id;
    return new Promise((resolve, reject) => {
      let settled = false;
      let opened = false;
      const ws = new WebSocket(this.url(id));
      this.ws = ws;
      const timer = setTimeout(() => {
        if (!settled) { settled = true; try { ws.close(); } catch { /* ignore */ } reject(new Error('SIGNAL_TIMEOUT')); }
      }, 10000);
      ws.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.type === 'OPEN') {
          if (!settled) { settled = true; opened = true; clearTimeout(timer); this._startHeartbeat(); resolve(); }
          return;
        }
        if (m.type === 'ID-TAKEN') {
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error('ID_TAKEN')); }
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        if (m.type === 'ERROR') {
          if (!settled) { settled = true; clearTimeout(timer); reject(new Error('SIGNAL_ERROR: ' + (m.payload?.msg || ''))); }
          return;
        }
        this.onMessage(m);
      };
      ws.onerror = () => {
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('SIGNAL_UNREACHABLE')); }
      };
      ws.onclose = () => {
        if (this.ws === ws) clearInterval(this.hb);
        if (!settled) { settled = true; clearTimeout(timer); reject(new Error('SIGNAL_CLOSED')); return; }
        // Only a socket that was actually up (and is still current) triggers a reconnect; failed
        // attempts are retried by the reconnect loop itself.
        if (opened && this.ws === ws && !this.closedByUser) this._reconnect();
      };
    });
  }

  async _reconnect() {
    if (this._reconnecting) return;
    this._reconnecting = true;
    try {
      while (!this.closedByUser) {
        if (this.reconnects > 20) { this.onLost(); return; }
        this.reconnects++;
        await new Promise((r) => setTimeout(r, Math.min(4000, 500 * this.reconnects)));
        if (this.closedByUser) return;
        try {
          await this.open(this.id);
          this.reconnects = 0;
          return;
        } catch { /* retry */ }
      }
    } finally {
      this._reconnecting = false;
    }
  }

  _startHeartbeat() {
    clearInterval(this.hb);
    this.hb = setInterval(() => this.raw({ type: 'HEARTBEAT' }), 5000);
  }

  raw(obj) {
    if (this.ws && this.ws.readyState === 1) { this.ws.send(JSON.stringify(obj)); return true; }
    return false;
  }

  send(dst, type, payload) {
    return this.raw({ type, dst, payload });
  }

  close() {
    this.closedByUser = true;
    clearInterval(this.hb);
    try { this.ws?.close(); } catch { /* ignore */ }
  }
}

// The public broker only relays messages shaped like genuine PeerJS signaling: OFFER/ANSWER
// need a real SDP (optional `metadata` may carry anything) and CANDIDATE needs a candidate
// object. So every message is wrapped in that shape:
//   {k:'sdp'}   -> OFFER/ANSWER with the real SDP
//   {k:'ice'}   -> CANDIDATE with the real candidate
//   {k:'hello'} -> OFFER (real throwaway SDP) with the handshake in metadata.mx, so a missing
//                  room still comes back as EXPIRE (= ROOM NOT FOUND)
//   other       -> CANDIDATE-shaped carrier with the message in payload.mx
const CARRIER_CANDIDATE = { candidate: 'candidate:0 1 udp 1 127.0.0.1 9 typ host', sdpMid: '0', sdpMLineIndex: 0 };
let carrierSdp = null;
async function throwawayOfferSdp() {
  if (carrierSdp) return carrierSdp;
  const pc = new RTCPeerConnection();
  try {
    pc.createDataChannel('mx');
    const offer = await pc.createOffer();
    carrierSdp = { type: 'offer', sdp: offer.sdp };
  } finally {
    pc.close();
  }
  return carrierSdp;
}

/**
 * Room-level signaling over the broker.
 *   host(code): claim peer id PREFIX+code (fails if taken)
 *   join(code): register a random id, HELLO the host, wait for WELCOME
 * send(obj) / onMessage(cb) carry {k:...} handshake + webrtc messages to the paired peer.
 */
export class PeerJSSignaling {
  constructor(cfg = peerjsConfig()) {
    this.kind = 'peerjs';
    this.cfg = cfg;
    this.sock = new BrokerSocket(cfg);
    this.peer = null; // remote peer id we're paired with
    this.handlers = [];
    this.isHost = false;
    this.connId = 'dc_' + randToken().slice(0, 10);
    this.sock.onMessage = (m) => this._onBroker(m);
    this.sock.onLost = () => this._emit({ k: 'signal-lost' });
  }

  get label() { return `PeerJS broker (${this.cfg.host})`; }

  onMessage(fn) { this.handlers.push(fn); }
  _emit(msg, src) { for (const fn of this.handlers) fn(msg, src); }

  async host(code) {
    this.isHost = true;
    await this.sock.open(NET.peerPrefix + code);
  }

  async join(code, hello) {
    this.isHost = false;
    this.peer = NET.peerPrefix + code;
    await throwawayOfferSdp();
    await this.sock.open(NET.peerPrefix + 'g-' + randToken().slice(0, 10));
    return new Promise((resolve, reject) => {
      // A refused or unanswered join was never paired, so close() must not send the host a 'bye'.
      const fail = (err) => { cleanup(); this.peer = null; reject(err); };
      const timer = setTimeout(() => fail(new Error('ROOM_NOT_FOUND')), 12000);
      const onMsg = (msg) => {
        if (msg.k === 'expire') fail(new Error('ROOM_NOT_FOUND'));
        else if (msg.k === 'welcome') {
          if (msg.accept) { cleanup(); resolve(msg); }
          else fail(new Error(msg.reason === 'full' ? 'ROOM_FULL' : 'ROOM_REJECTED'));
        }
      };
      const cleanup = () => { clearTimeout(timer); this.handlers = this.handlers.filter((h) => h !== onMsg); };
      this.handlers.push(onMsg);
      this.send({ k: 'hello', ...hello });
    });
  }

  _encode(obj) {
    const base = { type: 'data', connectionId: this.connId };
    if (obj.k === 'sdp') {
      return [obj.d.type === 'offer' ? 'OFFER' : 'ANSWER', {
        ...base, sdp: obj.d, label: this.connId, reliable: false, serialization: 'binary', browser: 'chrome', metadata: { mx: { k: 'sdp' } },
      }];
    }
    if (obj.k === 'ice') return ['CANDIDATE', { ...base, candidate: obj.c, mx: { k: 'ice' } }];
    if (obj.k === 'hello' && carrierSdp) {
      return ['OFFER', { ...base, sdp: carrierSdp, label: this.connId, reliable: false, serialization: 'binary', browser: 'chrome', metadata: { mx: obj } }];
    }
    return ['CANDIDATE', { ...base, candidate: CARRIER_CANDIDATE, mx: obj }];
  }

  _decode(m) {
    const p = m.payload;
    if (!p || typeof p !== 'object') return null;
    const mx = p.metadata?.mx || p.mx;
    if (!mx || typeof mx !== 'object') return null; // not one of ours (a stray PeerJS client)
    if (mx.k === 'sdp') return p.sdp ? { k: 'sdp', d: p.sdp } : null;
    if (mx.k === 'ice') return p.candidate ? { k: 'ice', c: p.candidate } : null;
    return mx;
  }

  /** Host: reply to a specific guest id (used before pairing). */
  replyTo(dst, obj) {
    const [type, payload] = this._encode(obj);
    return this.sock.send(dst, type, payload);
  }

  pair(peerId) { this.peer = peerId; }

  send(obj) {
    if (!this.peer) return false;
    const [type, payload] = this._encode(obj);
    return this.sock.send(this.peer, type, payload);
  }

  _onBroker(m) {
    if (m.type === 'EXPIRE') { this._emit({ k: 'expire' }, m.src); return; }
    if (m.type === 'LEAVE' && !m.payload) { if (m.src === this.peer) this._emit({ k: 'bye' }, m.src); return; }
    const msg = this._decode(m);
    if (msg) this._emit(msg, m.src);
  }

  async refresh() { /* broker rooms live as long as the host socket */ }

  close() {
    if (this.peer) this.send({ k: 'bye' });
    this.sock.close();
  }
}

// RTCPeerConnection wrapper with two DataChannels:
//   "reliable"  ordered + reliable  -> damage, kills, pickups, match state (JSON)
//   "fast"      unordered, 0 retransmits -> player snapshots, pings (binary)
// Signaling messages ({k:'sdp'|'ice'}) are passed through a caller-provided function.

export function iceServers() {
  const list = [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ];
  const env = import.meta.env || {};
  if (env.VITE_TURN_URLS) {
    list.push({
      urls: String(env.VITE_TURN_URLS).split(',').map((s) => s.trim()).filter(Boolean),
      username: env.VITE_TURN_USERNAME || undefined,
      credential: env.VITE_TURN_CREDENTIAL || undefined,
    });
  }
  // Runtime override for testing a TURN server without rebuilding:
  //   ?turn=turn:host:3478&turnUser=u&turnPass=p   (add &relay=1 to force relayed traffic)
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  if (q?.get('turn')) {
    list.push({
      urls: q.get('turn').split(',').map((s) => s.trim()).filter(Boolean),
      username: q.get('turnUser') || undefined,
      credential: q.get('turnPass') || undefined,
    });
  }
  return list;
}

export function iceTransportPolicy() {
  const q = typeof location !== 'undefined' ? new URLSearchParams(location.search) : null;
  return q?.get('relay') === '1' ? 'relay' : 'all';
}

export class PeerLink {
  constructor({ initiator, sendSignal }) {
    this.initiator = initiator;
    this.sendSignal = sendSignal;
    this.pc = new RTCPeerConnection({ iceServers: iceServers(), iceTransportPolicy: iceTransportPolicy(), iceCandidatePoolSize: 2 });
    this.reliable = null;
    this.fast = null;
    this.pendingIce = [];
    this.remoteSet = false;
    this.opened = false;
    this.closed = false;
    this.handlers = { open: [], close: [], message: [], state: [] };
    const pc = this.pc;
    pc.onicecandidate = (e) => {
      if (e.candidate) this.sendSignal({ k: 'ice', c: e.candidate.toJSON() });
    };
    pc.onconnectionstatechange = () => {
      this._emit('state', pc.connectionState);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') this._close('pc-' + pc.connectionState);
    };
    pc.oniceconnectionstatechange = () => this._emit('state', pc.iceConnectionState);
    pc.ondatachannel = (e) => this._setupChannel(e.channel);
    if (initiator) {
      this._setupChannel(pc.createDataChannel('reliable', { ordered: true }));
      this._setupChannel(pc.createDataChannel('fast', { ordered: false, maxRetransmits: 0 }));
    }
  }

  on(evt, fn) { this.handlers[evt].push(fn); return this; }
  _emit(evt, ...args) { for (const fn of this.handlers[evt]) { try { fn(...args); } catch (e) { console.error(e); } } }

  async start() {
    if (!this.initiator) return;
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);
    this.sendSignal({ k: 'sdp', d: { type: this.pc.localDescription.type, sdp: this.pc.localDescription.sdp } });
  }

  async handleSignal(msg) {
    if (this.closed) return;
    const pc = this.pc;
    try {
      if (msg.k === 'sdp') {
        await pc.setRemoteDescription(msg.d);
        this.remoteSet = true;
        for (const c of this.pendingIce.splice(0)) await pc.addIceCandidate(c).catch(() => {});
        if (msg.d.type === 'offer') {
          const ans = await pc.createAnswer();
          await pc.setLocalDescription(ans);
          this.sendSignal({ k: 'sdp', d: { type: pc.localDescription.type, sdp: pc.localDescription.sdp } });
        }
      } else if (msg.k === 'ice') {
        if (!this.remoteSet) this.pendingIce.push(msg.c);
        else await pc.addIceCandidate(msg.c).catch(() => {});
      }
    } catch (e) {
      console.warn('[webrtc] signal error', e);
    }
  }

  _setupChannel(ch) {
    ch.binaryType = 'arraybuffer';
    if (ch.label === 'reliable') this.reliable = ch;
    else if (ch.label === 'fast') this.fast = ch;
    ch.onopen = () => this._checkOpen();
    ch.onclose = () => this._close('channel-closed');
    ch.onerror = (e) => console.warn('[webrtc] channel error', ch.label, e?.error?.message || e);
    ch.onmessage = (e) => {
      if (ch.label === 'reliable') {
        let obj;
        try { obj = JSON.parse(e.data); } catch { return; }
        this._emit('message', obj, false);
      } else {
        this._emit('message', e.data, true);
      }
    };
  }

  _checkOpen() {
    if (this.opened) return;
    if (this.reliable?.readyState === 'open' && this.fast?.readyState === 'open') {
      this.opened = true;
      this._emit('open');
    }
  }

  _close(reason) {
    if (this.closed) return;
    this.closed = true;
    try { this.pc.close(); } catch { /* ignore */ }
    this._emit('close', reason);
  }

  get isOpen() {
    return this.opened && !this.closed && this.reliable?.readyState === 'open';
  }

  sendReliable(obj) {
    if (!this.isOpen) return false;
    try { this.reliable.send(JSON.stringify(obj)); return true; } catch { return false; }
  }

  sendFast(buf) {
    const ch = this.fast;
    if (!this.isOpen || !ch || ch.readyState !== 'open') return false;
    // Never queue stale movement packets behind a congested buffer.
    if (ch.bufferedAmount > 64 * 1024) return false;
    try { ch.send(buf); return true; } catch { return false; }
  }

  async selectedRtt() {
    try {
      const stats = await this.pc.getStats();
      let rtt = null;
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.nominated && r.state === 'succeeded' && typeof r.currentRoundTripTime === 'number') rtt = r.currentRoundTripTime * 1000;
      });
      return rtt;
    } catch { return null; }
  }

  close() { this._close('local'); }
}

// Room codes + signaling backend selection.
import { NET } from '../config.js';
import { PeerJSSignaling, peerjsConfig } from './signaling-peerjs.js';
import { FirebaseSignaling, firebaseConfig } from './signaling-firebase.js';

/** Cryptographically random room code from an unambiguous alphabet (no O/0/I/1). */
export function generateRoomCode(len = NET.codeLength) {
  const A = NET.codeAlphabet;
  const bytes = new Uint32Array(len);
  crypto.getRandomValues(bytes);
  let s = '';
  for (let i = 0; i < len; i++) s += A[bytes[i] % A.length];
  return s;
}

export function normalizeCode(raw) {
  return String(raw || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export function isValidCode(code) {
  if (code.length < 5 || code.length > 6) return false;
  for (const ch of code) if (!NET.codeAlphabet.includes(ch)) return false;
  return true;
}

export function signalingBackend() {
  const params = new URLSearchParams(location.search);
  const forced = params.get('signaling') || (import.meta.env || {}).VITE_SIGNALING;
  const fbCfg = firebaseConfig();
  if (forced !== 'peerjs' && fbCfg) return new FirebaseSignaling(fbCfg);
  return new PeerJSSignaling(peerjsConfig());
}

export function inviteLink(code) {
  const url = new URL(location.href);
  url.search = '';
  url.hash = '';
  url.searchParams.set('room', code);
  // Keep a custom signaling server in the invite so both sides use the same broker.
  const cur = new URLSearchParams(location.search);
  for (const k of ['signal', 'signalPort', 'signalInsecure', 'signaling', 'turn', 'turnUser', 'turnPass', 'relay']) if (cur.has(k)) url.searchParams.set(k, cur.get(k));
  return url.toString();
}

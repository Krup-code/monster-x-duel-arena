// Firebase Realtime Database signaling (optional; enabled when VITE_FIREBASE_* env vars are set).
// Used ONLY for room creation, room codes, SDP offers/answers, ICE candidates and status.
//
// rooms/{CODE}
//   meta:    { hostUid, createdAt, expiresAt, status, v }
//   guest:   { uid, joinedAt }
//   toHost/{pushId}:  { m: JSON string, t }
//   toGuest/{pushId}: { m: JSON string, t }
//
// The host's connection registers onDisconnect().remove() so abandoned rooms vanish,
// rooms carry an expiresAt (60 min, refreshed while active) and any client may delete
// expired rooms (see firebase/database.rules.json). Anonymous auth scopes writes.

import { NET } from '../config.js';

export function firebaseConfig() {
  const env = import.meta.env || {};
  if (!env.VITE_FIREBASE_API_KEY || !env.VITE_FIREBASE_DATABASE_URL) return null;
  return {
    apiKey: env.VITE_FIREBASE_API_KEY,
    authDomain: env.VITE_FIREBASE_AUTH_DOMAIN,
    databaseURL: env.VITE_FIREBASE_DATABASE_URL,
    projectId: env.VITE_FIREBASE_PROJECT_ID,
    appId: env.VITE_FIREBASE_APP_ID,
  };
}

let fb = null;
async function loadFirebase(cfg) {
  if (fb) return fb;
  const [{ initializeApp }, db, auth] = await Promise.all([
    import('firebase/app'),
    import('firebase/database'),
    import('firebase/auth'),
  ]);
  const app = initializeApp(cfg, 'monsterx');
  const database = db.getDatabase(app);
  const a = auth.getAuth(app);
  const cred = await auth.signInAnonymously(a);
  fb = { db, database, uid: cred.user.uid };
  return fb;
}

export class FirebaseSignaling {
  constructor(cfg) {
    this.kind = 'firebase';
    this.cfg = cfg;
    this.handlers = [];
    this.unsubs = [];
    this.code = null;
    this.isHost = false;
    this.refreshTimer = null;
  }

  get label() { return 'Firebase Realtime Database'; }

  onMessage(fn) { this.handlers.push(fn); }
  _emit(msg) { for (const fn of this.handlers) fn(msg, 'peer'); }

  async _init() {
    this.f = await loadFirebase(this.cfg);
    return this.f;
  }

  _ref(path) { return this.f.db.ref(this.f.database, `rooms/${this.code}${path ? '/' + path : ''}`); }

  async _cleanupExpired() {
    try {
      const { db, database } = this.f;
      const q = db.query(db.ref(database, 'rooms'), db.orderByChild('meta/expiresAt'), db.endAt(Date.now()), db.limitToFirst(20));
      const snap = await db.get(q);
      const jobs = [];
      snap.forEach((child) => { jobs.push(db.remove(child.ref).catch(() => {})); });
      await Promise.all(jobs);
    } catch { /* rules may deny; harmless */ }
  }

  _listen(box) {
    const { db } = this.f;
    const r = this._ref(box);
    const unsub = db.onChildAdded(r, (snap) => {
      const v = snap.val();
      db.remove(snap.ref).catch(() => {});
      if (!v || typeof v.m !== 'string') return;
      try { this._emit(JSON.parse(v.m)); } catch { /* ignore */ }
    });
    this.unsubs.push(unsub);
  }

  async host(code) {
    await this._init();
    this.isHost = true;
    this.code = code;
    const { db, uid } = this.f;
    this._cleanupExpired();
    const now = Date.now();
    const res = await db.runTransaction(this._ref('meta'), (cur) => {
      if (cur && cur.expiresAt > now) return undefined; // taken -> abort
      return { hostUid: uid, createdAt: now, expiresAt: now + NET.roomTTLMinutes * 60000, status: 'open', v: 1 };
    });
    if (!res.committed) throw new Error('ID_TAKEN');
    await db.onDisconnect(this._ref('')).remove();
    this._listen('toHost');
    this.refreshTimer = setInterval(() => {
      db.update(this._ref('meta'), { expiresAt: Date.now() + NET.roomTTLMinutes * 60000 }).catch(() => {});
    }, 10 * 60000);
  }

  async join(code, hello) {
    await this._init();
    this.isHost = false;
    this.code = code;
    const { db, uid } = this.f;
    const meta = (await db.get(this._ref('meta'))).val();
    if (!meta || meta.expiresAt < Date.now()) throw new Error('ROOM_NOT_FOUND');
    const claim = await db.runTransaction(this._ref('guest'), (cur) => {
      if (cur && cur.uid !== uid) return undefined;
      return { uid, joinedAt: Date.now() };
    });
    if (!claim.committed) throw new Error('ROOM_FULL');
    await db.onDisconnect(this._ref('guest')).remove();
    this._listen('toGuest');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('ROOM_NOT_FOUND')); }, 12000);
      const onMsg = (msg) => {
        if (msg.k !== 'welcome') return;
        cleanup();
        if (msg.accept) resolve(msg);
        else reject(new Error(msg.reason === 'full' ? 'ROOM_FULL' : 'ROOM_REJECTED'));
      };
      const cleanup = () => { clearTimeout(timer); this.handlers = this.handlers.filter((h) => h !== onMsg); };
      this.handlers.push(onMsg);
      this.send({ k: 'hello', ...hello });
    });
  }

  replyTo(_dst, obj) { this.send(obj); }
  pair() { /* single guest slot */ }

  send(obj) {
    if (!this.f || !this.code) return false;
    const { db } = this.f;
    db.push(this._ref(this.isHost ? 'toGuest' : 'toHost'), { m: JSON.stringify(obj), t: Date.now() }).catch((e) => console.warn('[firebase] send failed', e));
    return true;
  }

  async setStatus(status) {
    if (!this.isHost || !this.f) return;
    await this.f.db.update(this._ref('meta'), { status }).catch(() => {});
  }

  /** Host: free the guest slot so a new player can join (after the guest left). */
  async releaseGuest() {
    if (!this.isHost || !this.f) return;
    await this.f.db.remove(this._ref('guest')).catch(() => {});
  }

  async refresh() {}

  close() {
    clearInterval(this.refreshTimer);
    for (const u of this.unsubs) try { u(); } catch { /* ignore */ }
    this.unsubs = [];
    if (!this.f || !this.code) return;
    const { db } = this.f;
    if (this.isHost) db.remove(this._ref('')).catch(() => {});
    else {
      this.send({ k: 'bye' });
      db.remove(this._ref('guest')).catch(() => {});
    }
  }
}

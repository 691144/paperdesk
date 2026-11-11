/* PaperDesk sync core: three-way merge of desks, notes and links, plus the
   sync loop. No DOM or network code lives here, so it runs in the browser
   and in Node tests alike.

   Sync file format (version 1):
     { app: 'PaperDesk', format: 1, savedAt, doc }
     doc = { order: [boardId], boards: {id: meta}, notes: {id: note}, links: {id: link} }
   Each entity carries _t (last change time, ms). Notes carry _b (board id) and
   _o (position in the board's note list). Links carry _b. Large data: URLs in
   a note are stored as separate blob files and referenced as "pdblob:<sha256>". */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PDSyncCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const VIEW_KEYS = ['zoom', 'panX', 'panY'];      // per-device view, never synced
  const NOTE_LOCAL_KEYS = ['playing'];               // transient UI state
  const META_LOCAL_KEYS = ['blobUrl'];               // session-only object URLs
  const TEXT_KEYS = ['title', 'body', 'tasks', 'url'];
  const BLOB_PREFIX = 'pdblob:';
  const BLOB_MIN = 2048;
  const KINDS = ['boards', 'notes', 'links'];

  /* ---------- helpers ---------- */
  function canon(v) {
    if (v === null || typeof v !== 'object') return JSON.stringify(v === undefined ? null : v);
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    return '{' + Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
  }
  function bare(e) { if (!e) return e; const { _t, ...rest } = e; return rest; }
  const key = (e) => (e === undefined ? undefined : canon(bare(e)));
  function same(a, b) { if (a === undefined || b === undefined) return a === b; return key(a) === key(b); }
  function strHash(s) {
    let h1 = 0x811c9dc5, h2 = 5381;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = (Math.imul(h2, 33) + c) | 0; }
    return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0') + s.length.toString(16);
  }
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const emptyDoc = () => ({ order: [], boards: {}, notes: {}, links: {} });
  function docKey(doc) { const d = {}; for (const k of KINDS) { d[k] = {}; for (const id in doc[k]) d[k][id] = bare(doc[k][id]); } d.order = doc.order; return canon(d); }
  const sameDoc = (a, b) => docKey(a) === docKey(b);

  async function sha256(text) {
    const c = (typeof crypto !== 'undefined' && crypto.subtle) ? crypto : (typeof require === 'function' ? require('crypto').webcrypto : null);
    const buf = await c.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const isBlobValue = (v) => typeof v === 'string' && v.length >= BLOB_MIN && v.startsWith('data:');

  /* ---------- blob store (hash <-> data URL) ---------- */
  class BlobStore {
    constructor(hash = sha256) { this.hash = hash; this.byHash = new Map(); this.byValue = new Map(); }
    async ref(value) {
      let h = this.byValue.get(value);
      if (!h) { h = await this.hash(value); this.byValue.set(value, h); this.byHash.set(h, value); }
      return BLOB_PREFIX + h;
    }
    has(h) { return this.byHash.has(h); }
    get(h) { return this.byHash.get(h); }
    put(h, value) { this.byHash.set(h, value); this.byValue.set(value, h); }
  }
  function refsOf(doc) {
    const out = new Set();
    for (const id in doc.notes) {
      const n = doc.notes[id];
      const scan = (v) => { if (typeof v === 'string' && v.startsWith(BLOB_PREFIX)) out.add(v.slice(BLOB_PREFIX.length)); };
      scan(n.url); if (n.meta) Object.values(n.meta).forEach(scan);
    }
    return out;
  }

  /* ---------- change tracker: gives every entity a "last changed" time ---------- */
  class Tracker {
    constructor(seen = {}) { this.seen = seen; }
    stamp(kind, id, entity, now) {
      const h = strHash(key(entity)); const k = kind + ':' + id; const rec = this.seen[k];
      if (!rec || rec.h !== h) this.seen[k] = { h, t: now };
      entity._t = this.seen[k].t;
    }
    accept(doc) {
      const seen = {};
      for (const kind of KINDS) for (const id in doc[kind]) seen[kind + ':' + id] = { h: strHash(key(doc[kind][id])), t: doc[kind][id]._t || 0 };
      this.seen = seen;
    }
  }

  /* ---------- boards <-> doc ---------- */
  async function normalize(boards, { tracker, blobs, now = Date.now() } = {}) {
    const doc = emptyDoc();
    for (const b of boards) {
      doc.order.push(b.id);
      const meta = {};
      for (const k in b) if (k !== 'notes' && k !== 'links' && !VIEW_KEYS.includes(k)) meta[k] = clone(b[k]);
      doc.boards[b.id] = meta;
      let i = 0;
      for (const n of b.notes || []) {
        const e = {};
        for (const k in n) if (!NOTE_LOCAL_KEYS.includes(k) && n[k] !== undefined) e[k] = clone(n[k]);
        if (e.meta) for (const k of META_LOCAL_KEYS) delete e.meta[k];
        if (blobs) {
          if (isBlobValue(e.url)) e.url = await blobs.ref(e.url);
          if (e.meta) for (const k in e.meta) if (isBlobValue(e.meta[k])) e.meta[k] = await blobs.ref(e.meta[k]);
        }
        e._b = b.id; e._o = i++;
        doc.notes[n.id] = e;
      }
      for (const l of b.links || []) doc.links[l.id] = { ...clone(l), _b: b.id };
    }
    if (tracker) for (const kind of KINDS) for (const id in doc[kind]) tracker.stamp(kind, id, doc[kind][id], now);
    return doc;
  }

  function denormalize(doc, localBoards = [], blobs) {
    const localB = new Map(localBoards.map((b) => [b.id, b]));
    const localN = new Map(); for (const b of localBoards) for (const n of b.notes || []) localN.set(n.id, n);
    const ids = doc.order.filter((id) => doc.boards[id]);
    for (const id in doc.boards) if (!ids.includes(id)) ids.push(id);
    const out = ids.map((id) => {
      const { _t, ...m } = doc.boards[id]; const lb = localB.get(id);
      return { ...clone(m), zoom: lb?.zoom ?? 1, panX: lb?.panX ?? 0, panY: lb?.panY ?? 0, notes: [], links: [] };
    });
    if (!out.length) return out;
    const byId = new Map(out.map((b) => [b.id, b]));
    const unref = (v) => (typeof v === 'string' && v.startsWith(BLOB_PREFIX) && blobs?.has(v.slice(BLOB_PREFIX.length)) ? blobs.get(v.slice(BLOB_PREFIX.length)) : v);
    const notes = Object.entries(doc.notes).sort((a, b) => (a[1]._o ?? 0) - (b[1]._o ?? 0));
    for (const [id, e] of notes) {
      const { _t, _b, _o, ...n } = clone(e);
      n.id = id;
      if (n.url !== undefined) n.url = unref(n.url);
      if (n.meta) for (const k in n.meta) n.meta[k] = unref(n.meta[k]);
      const ln = localN.get(id);
      if (ln?.meta?.blobUrl && n.meta && (n.meta.dataUrl === ln.meta.dataUrl)) n.meta.blobUrl = ln.meta.blobUrl;
      (byId.get(_b) || out[0]).notes.push(n);
    }
    const noteIds = new Set(Object.keys(doc.notes));
    for (const [id, e] of Object.entries(doc.links)) {
      if (!noteIds.has(e.src) || !noteIds.has(e.dst)) continue;
      const { _t, _b, ...l } = clone(e); l.id = id;
      (byId.get(_b) || out[0]).links.push(l);
    }
    return out;
  }

  /* ---------- three-way merge ---------- */
  function mergeFields(b, l, r) {
    const lWins = (l._t || 0) > (r._t || 0) || ((l._t || 0) === (r._t || 0) && key(l) >= key(r));
    const res = {}; const conflicts = [];
    const keys = new Set([...Object.keys(l), ...Object.keys(r)]); keys.delete('_t');
    for (const k of keys) {
      const bv = b ? b[k] : undefined, lv = l[k], rv = r[k];
      let v;
      if (canon(lv) === canon(rv)) v = lv;
      else if (b && canon(lv) === canon(bv)) v = rv;
      else if (b && canon(rv) === canon(bv)) v = lv;
      else { v = lWins ? lv : rv; conflicts.push(k); }
      if (v !== undefined) res[k] = clone(v);
    }
    res._t = Math.max(l._t || 0, r._t || 0);
    return { res, conflicts, loser: lWins ? r : l };
  }

  function merge3(base, local, remote) {
    base = base || emptyDoc();
    const doc = emptyDoc(); let conflicts = 0;
    for (const kind of KINDS) {
      const B = base[kind] || {}, L = local[kind] || {}, R = remote[kind] || {};
      for (const id of new Set([...Object.keys(B), ...Object.keys(L), ...Object.keys(R)])) {
        const b = B[id], l = L[id], r = R[id];
        let out;
        if (same(l, r)) out = l && r ? ((l._t || 0) >= (r._t || 0) ? l : r) : l;
        else if (same(l, b)) out = r;            // only the other device changed (or deleted) it
        else if (same(r, b)) out = l;            // only this device changed (or deleted) it
        else if (!l) out = r;                    // an edit beats a delete
        else if (!r) out = l;
        else {
          const m = mergeFields(b, l, r); out = m.res;
          if (m.conflicts.length) conflicts++;
          if (kind === 'notes' && m.conflicts.some((k) => TEXT_KEYS.includes(k))) {
            const lo = m.loser; const cid = id + '~' + strHash(key(lo)).slice(0, 10);
            if (!doc.notes[cid] && !L[cid] && !R[cid]) {
              doc.notes[cid] = { ...clone(lo), title: 'Conflict copy · ' + (lo.title || 'Untitled'), x: (lo.x || 0) + 24, y: (lo.y || 0) + 24, _o: (lo._o || 0) + 0.5, _t: lo._t || 0 };
            }
          }
        }
        if (out) doc[kind][id] = clone(out);
      }
    }
    // board order: this device's order, then boards that only exist elsewhere
    const seen = new Set();
    for (const id of [...(local.order || []), ...(remote.order || []), ...Object.keys(doc.boards)]) if (doc.boards[id] && !seen.has(id)) { seen.add(id); doc.order.push(id); }
    // a note whose desk was deleted elsewhere moves to the first desk
    const first = doc.order[0];
    for (const id in doc.notes) if (!doc.boards[doc.notes[id]._b] && first) doc.notes[id]._b = first;
    for (const id in doc.links) {
      const lk = doc.links[id];
      if (!doc.notes[lk.src] || !doc.notes[lk.dst]) delete doc.links[id];
      else if (!doc.boards[lk._b] && first) lk._b = first;
    }
    return { doc, conflicts };
  }

  /* ---------- sync loop ---------- */
  class ConflictError extends Error { constructor() { super('The cloud copy changed while saving'); this.code = 'conflict'; } }
  class AuthError extends Error { constructor(m) { super(m || 'Sign-in needed'); this.code = 'auth'; } }

  /** kv: { get(k), set(k, v) } with JSON values. */
  class SyncEngine {
    constructor({ provider, kv, getBoards, applyBoards, blobs = new BlobStore(), now = () => Date.now() }) {
      Object.assign(this, { provider, kv, getBoards, applyBoards, blobs, now });
      this.tracker = new Tracker(kv.get('seen') || {});
      this.uploaded = new Set(kv.get('uploaded') || []);
      this.running = null; this.again = false;
    }
    sync() {
      if (this.running) { this.again = true; return this.running; }
      this.running = (async () => {
        try {
          let result;
          do { this.again = false; result = await this._once(); } while (this.again);
          return result;
        } finally { this.running = null; }
      })();
      return this.running;
    }
    async _once() {
      const base = this.kv.get('base');
      const local = await normalize(this.getBoards(), { tracker: this.tracker, blobs: this.blobs, now: this.now() });
      let merged, conflicts = 0, uploaded = false, remoteDoc = null;
      for (let attempt = 0; ; attempt++) {
        const remote = await this.provider.read();
        remoteDoc = remote ? remote.doc : null;
        if (remoteDoc) ({ doc: merged, conflicts } = merge3(base, local, remoteDoc));
        else merged = local;
        for (const h of refsOf(merged)) {
          if (this.uploaded.has(h) || !this.blobs.has(h)) continue;
          await this.provider.writeBlob(h, this.blobs.get(h)); this.uploaded.add(h);
        }
        if (remoteDoc && sameDoc(merged, remoteDoc)) break;
        try { await this.provider.write(merged, remote ? remote.version : null); uploaded = true; break; }
        catch (e) { if (e.code !== 'conflict' || attempt >= 4) throw e; }
      }
      for (const h of refsOf(merged)) {
        if (this.blobs.has(h)) continue;
        const v = await this.provider.readBlob(h);
        if (v != null) { this.blobs.put(h, v); this.uploaded.add(h); }
      }
      this.kv.set('base', merged);
      this.kv.set('uploaded', [...this.uploaded]);
      // keep any edits made on this device while the sync was running
      const now2 = await normalize(this.getBoards(), { tracker: this.tracker, blobs: this.blobs, now: this.now() });
      const final = sameDoc(now2, local) ? merged : merge3(local, now2, merged).doc;
      const changedHere = !sameDoc(final, now2);
      if (changedHere) this.applyBoards(denormalize(final, this.getBoards(), this.blobs));
      this.tracker.accept(final);
      this.kv.set('seen', this.tracker.seen);
      if (!sameDoc(final, merged)) this.again = true;
      return { uploaded, downloaded: changedHere, conflicts };
    }
  }

  return { canon, strHash, sha256, normalize, denormalize, merge3, sameDoc, refsOf, BlobStore, Tracker, SyncEngine, ConflictError, AuthError, BLOB_PREFIX, emptyDoc };
});

// Run with: node --test tests
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../web/sync-core.js');

const note = (id, o = {}) => ({ id, type: 'text', title: id, body: '', x: 0, y: 0, w: 200, h: 120, badges: [], tasks: [], meta: {}, ...o });
const desk = (id, notes = [], o = {}) => ({ id, title: id, viewMode: 'freeform', zoom: 1, panX: 0, panY: 0, strokes: [], notes, links: [], ...o });
const clone = (v) => JSON.parse(JSON.stringify(v));
const find = (boards, id) => { for (const b of boards) for (const n of b.notes) if (n.id === id) return n; return null; };

/** In-memory "cloud drive" with versions, like Drive/OneDrive. */
class FakeDrive {
  constructor() { this.file = null; this.version = 0; this.blobs = new Map(); this.writes = 0; this.blobWrites = 0; this.beforeWrite = null; }
  provider() {
    return {
      read: async () => (this.file ? { doc: clone(this.file), version: this.version } : null),
      write: async (doc, version) => {
        if (this.beforeWrite) { const f = this.beforeWrite; this.beforeWrite = null; await f(); }
        if ((this.file ? this.version : null) !== version) throw new C.ConflictError();
        this.file = clone(doc); this.version++; this.writes++;
      },
      readBlob: async (h) => this.blobs.get(h) ?? null,
      writeBlob: async (h, v) => { this.blobs.set(h, v); this.blobWrites++; },
    };
  }
}
function device(drive, boards, clock) {
  const store = new Map();
  const dev = { boards };
  dev.engine = new C.SyncEngine({
    provider: drive.provider(),
    kv: { get: (k) => (store.has(k) ? clone(store.get(k)) : null), set: (k, v) => store.set(k, clone(v)) },
    getBoards: () => dev.boards,
    applyBoards: (b) => { dev.boards = b; },
    now: () => clock.t,
  });
  return dev;
}

test('normalize/denormalize round trip keeps content and this device\'s view', async () => {
  const boards = [desk('d1', [note('a', { meta: { blobUrl: 'blob:x' } }), note('b')], { zoom: 2, panX: 5 })];
  boards[0].links.push({ id: 'l1', src: 'a', dst: 'b', group: 'G', label: '' });
  const doc = await C.normalize(boards, {});
  assert.equal(doc.boards.d1.zoom, undefined, 'view is not synced');
  assert.equal(doc.notes.a.meta.blobUrl, undefined, 'session URLs are not synced');
  const back = C.denormalize(doc, boards);
  assert.equal(back[0].zoom, 2);
  assert.deepEqual(back[0].notes.map((n) => n.id), ['a', 'b']);
  assert.equal(back[0].links[0].id, 'l1');
});

test('edits to different notes on two devices are both kept', async () => {
  const base = await C.normalize([desk('d', [note('a'), note('b')])], {});
  const l = clone(base); l.notes.a.title = 'A local'; l.notes.a._t = 10;
  const r = clone(base); r.notes.b.title = 'B remote'; r.notes.b._t = 11;
  const { doc, conflicts } = C.merge3(base, l, r);
  assert.equal(doc.notes.a.title, 'A local');
  assert.equal(doc.notes.b.title, 'B remote');
  assert.equal(conflicts, 0);
});

test('different fields of the same note merge; same field goes to the newer edit with a conflict copy', async () => {
  const base = await C.normalize([desk('d', [note('a', { body: 'old' })])], {});
  const l = clone(base); l.notes.a.x = 300; l.notes.a._t = 10;
  const r = clone(base); r.notes.a.title = 'renamed'; r.notes.a._t = 20;
  let m = C.merge3(base, l, r).doc;
  assert.equal(m.notes.a.x, 300); assert.equal(m.notes.a.title, 'renamed');
  const l2 = clone(base); l2.notes.a.body = 'mine'; l2.notes.a._t = 30;
  const r2 = clone(base); r2.notes.a.body = 'theirs'; r2.notes.a._t = 40;
  const res = C.merge3(base, l2, r2);
  assert.equal(res.doc.notes.a.body, 'theirs', 'newer edit wins');
  const copies = Object.values(res.doc.notes).filter((n) => n.title.startsWith('Conflict copy'));
  assert.equal(copies.length, 1); assert.equal(copies[0].body, 'mine', 'the other version is kept as a copy');
});

test('an edit beats a delete; an untouched note follows the delete', async () => {
  const base = await C.normalize([desk('d', [note('a'), note('b')])], {});
  const l = clone(base); delete l.notes.a; delete l.notes.b;
  const r = clone(base); r.notes.a.title = 'edited'; r.notes.a._t = 5;
  const { doc } = C.merge3(base, l, r);
  assert.equal(doc.notes.a.title, 'edited');
  assert.equal(doc.notes.b, undefined);
});

test('a note on a desk deleted elsewhere moves to the first desk; dangling links are dropped', async () => {
  const boards = [desk('d1'), desk('d2', [note('a'), note('b')])];
  boards[1].links.push({ id: 'l', src: 'a', dst: 'b', group: 'G' });
  const base = await C.normalize(boards, {});
  const l = clone(base); l.notes.a.title = 'kept'; l.notes.a._t = 9;
  const r = clone(base); delete r.boards.d2; r.order = ['d1']; delete r.notes.a; delete r.notes.b; delete r.links.l;
  const { doc } = C.merge3(base, l, r);
  assert.equal(doc.notes.a._b, 'd1');
  assert.equal(doc.notes.b, undefined);
  assert.equal(doc.links.l, undefined);
});

test('two devices sync through the drive without losing either side', async () => {
  const drive = new FakeDrive(); const clock = { t: 1000 };
  const start = [desk('d', [note('a'), note('b')])];
  const A = device(drive, clone(start), clock), B = device(drive, clone(start), clock);
  await A.engine.sync(); await B.engine.sync();
  clock.t = 2000; find(A.boards, 'a').title = 'from A';
  clock.t = 3000; find(B.boards, 'b').title = 'from B'; B.boards[0].notes.push(note('c'));
  await A.engine.sync(); await B.engine.sync(); await A.engine.sync();
  for (const dev of [A, B]) {
    assert.equal(find(dev.boards, 'a').title, 'from A');
    assert.equal(find(dev.boards, 'b').title, 'from B');
    assert.ok(find(dev.boards, 'c'));
  }
  const w = drive.writes; await A.engine.sync(); await B.engine.sync();
  assert.equal(drive.writes, w, 'nothing to upload when both are up to date');
});

test('the same text edited on both devices ends up identical on both, with one conflict copy', async () => {
  const drive = new FakeDrive(); const clock = { t: 1 };
  const A = device(drive, [desk('d', [note('a', { body: 'v0' })])], clock);
  await A.engine.sync();
  const B = device(drive, [desk('d', [])], clock);
  await B.engine.sync();
  clock.t = 10; find(A.boards, 'a').body = 'A text';
  clock.t = 20; find(B.boards, 'a').body = 'B text';
  await A.engine.sync(); await B.engine.sync(); await A.engine.sync(); await B.engine.sync();
  const ids = (dev) => dev.boards[0].notes.map((n) => n.id + '=' + n.body).sort();
  assert.deepEqual(ids(A), ids(B));
  assert.equal(find(A.boards, 'a').body, 'B text');
  assert.equal(A.boards[0].notes.filter((n) => n.title.startsWith('Conflict copy')).length, 1);
});

test('attachments travel as separate blob files, uploaded once', async () => {
  const drive = new FakeDrive(); const clock = { t: 1 };
  const big = 'data:image/png;base64,' + 'A'.repeat(5000);
  const A = device(drive, [desk('d', [note('img', { type: 'image', meta: { dataUrl: big } })])], clock);
  const B = device(drive, [desk('d', [])], clock);
  await A.engine.sync();
  assert.ok(!JSON.stringify(drive.file).includes('AAAA'), 'the sync file holds a reference, not the data');
  assert.equal(drive.blobWrites, 1);
  await B.engine.sync();
  assert.equal(find(B.boards, 'img').meta.dataUrl, big);
  clock.t = 5; find(A.boards, 'img').title = 'renamed';
  await A.engine.sync();
  assert.equal(drive.blobWrites, 1, 'unchanged attachment is not uploaded again');
});

test('a save collision re-merges instead of overwriting', async () => {
  const drive = new FakeDrive(); const clock = { t: 1 };
  const A = device(drive, [desk('d', [note('a'), note('b')])], clock);
  await A.engine.sync();
  const B = device(drive, [desk('d', [])], clock); await B.engine.sync();
  clock.t = 5; find(A.boards, 'a').title = 'A';
  clock.t = 6; find(B.boards, 'b').title = 'B';
  drive.beforeWrite = () => B.engine.sync();   // B saves while A is mid-sync
  await A.engine.sync();
  assert.equal(find(A.boards, 'a').title, 'A'); assert.equal(find(A.boards, 'b').title, 'B');
  const cloud = C.denormalize(drive.file, []);
  assert.equal(find(cloud, 'a').title, 'A'); assert.equal(find(cloud, 'b').title, 'B');
});

test('edits made while a sync is running are kept', async () => {
  const drive = new FakeDrive(); const clock = { t: 1 };
  const A = device(drive, [desk('d', [note('a')])], clock);
  await A.engine.sync();
  const B = device(drive, [desk('d', [])], clock); await B.engine.sync();
  clock.t = 5; find(B.boards, 'a').x = 400; await B.engine.sync();
  const prov = A.engine.provider; const read = prov.read;
  prov.read = async () => { const r = await read(); clock.t = 9; find(A.boards, 'a').title = 'typed during sync'; prov.read = read; return r; };
  await A.engine.sync();
  assert.equal(find(A.boards, 'a').title, 'typed during sync');
  assert.equal(find(A.boards, 'a').x, 400);
  assert.equal(find(C.denormalize(drive.file, []), 'a').title, 'typed during sync', 'and uploaded in a follow-up pass');
});

test('first connect of a second device merges both desks instead of replacing one', async () => {
  const drive = new FakeDrive(); const clock = { t: 1 };
  const A = device(drive, [desk('d', [note('a')])], clock); await A.engine.sync();
  clock.t = 2;
  const B = device(drive, [desk('d', [note('b')]), desk('e', [note('c')])], clock); await B.engine.sync();
  await A.engine.sync();
  for (const dev of [A, B]) { assert.ok(find(dev.boards, 'a')); assert.ok(find(dev.boards, 'b')); assert.ok(find(dev.boards, 'c')); }
});

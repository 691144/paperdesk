/* PaperDesk model storage: AI model files live in the browser's private file
   system (OPFS) for this site. Unlike the Cache API, which can refuse single
   files of a few hundred MB, it holds files of any size; downloads stream
   straight to disk and are read back without extra copies. A small ".ok"
   marker is written last, so a cut-off download never counts as finished. */
const DIR = 'paperdesk-models';
const nameOf = (url) => String(url).replace(/^https?:\/\//, '').replace(/[^A-Za-z0-9._-]+/g, '_').slice(-180);
const keyOf = (k) => (typeof k === 'string' ? k : k?.url || String(k));

async function dir() { const root = await navigator.storage.getDirectory(); return root.getDirectoryHandle(DIR, { create: true }); }

export async function has(url) {
  try { await (await dir()).getFileHandle(nameOf(url) + '.ok'); return true; } catch { return false; }
}
export async function file(url) {
  if (!(await has(url))) return null;
  try { return await (await (await dir()).getFileHandle(nameOf(url))).getFile(); } catch { return null; }
}
export async function remove(url) {
  const d = await dir();
  for (const n of [nameOf(url) + '.ok', nameOf(url)]) { try { await d.removeEntry(n); } catch { /* not there */ } }
}
/** Bytes used by finished model files whose URL contains `part` (all when empty). */
export async function bytes(part = '') {
  let n = 0; const d = await dir(), want = nameOf(part);
  for await (const [name, h] of d.entries()) if (h.kind === 'file' && !name.endsWith('.ok') && name.includes(want)) n += (await h.getFile()).size;
  return n;
}

/** Streams a body into the store; onBytes(n) reports progress. */
export async function write(url, stream, onBytes) {
  const d = await dir(), name = nameOf(url);
  try { await d.removeEntry(name + '.ok'); } catch { /* new file */ }
  const fh = await d.getFileHandle(name, { create: true });
  const reader = stream.getReader();
  if (fh.createWritable) {
    const w = await fh.createWritable();
    try {
      for (;;) { const { done, value } = await reader.read(); if (done) break; await w.write(value); onBytes?.(value.length); }
      await w.close();
    } catch (e) { try { await w.abort(); } catch { /* closed */ } throw e; }
  } else {
    // Safari before createWritable: synchronous handles (workers only).
    const h = await fh.createSyncAccessHandle(); let at = 0;
    try {
      h.truncate(0);
      for (;;) { const { done, value } = await reader.read(); if (done) break; h.write(value, { at }); at += value.length; onBytes?.(value.length); }
      h.flush();
    } finally { h.close(); }
  }
  await d.getFileHandle(name + '.ok', { create: true });
}

export async function sizeOf(url) {
  try { const r = await fetch(url, { method: 'HEAD' }); return Number(r.headers.get('content-length')) || 0; } catch { return 0; }
}
export async function download(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status}) for ${url.split('/').pop()}`);
  await write(url, res.body, onBytes);
}

/** A Web Cache–like object for transformers.js (env.customCache). */
export const cache = {
  async match(key) { const f = await file(keyOf(key)); return f ? new Response(f, { headers: { 'content-length': String(f.size) } }) : undefined; },
  async put(key, response) { try { if (response?.body) await write(keyOf(key), response.body); } catch (e) { console.warn('PaperDesk could not store', keyOf(key), e); } },
};

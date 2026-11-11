/* PaperDesk speech-to-text: Whisper in a background thread (transformers.js on
   WebGPU, or WebAssembly where there is no GPU). Audio never leaves the device;
   only the model files are downloaded (once) from Hugging Face, into the
   private file store (ai-store.js). */
import { pipeline, env, Tensor } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
import * as store from './ai-store.js';

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = store.cache;
const HF = 'https://huggingface.co/';
const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };
let asr = null, key = '';
const post = (m) => self.postMessage(m);

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'load') { await load(data, id); post({ id, type: 'done' }); }
    else if (type === 'detect') post({ id, type: 'done', result: await detect(data.audio, data.langs) });
    else if (type === 'transcribe') post({ id, type: 'done', result: await transcribe(data) });
    else if (type === 'unload') { await dispose(); post({ id, type: 'done' }); }
  } catch (e) {
    post({ id, type: 'error', error: String(e?.message || e) });
  }
};

async function dispose() { try { await asr?.dispose?.(); } catch { /* already gone */ } asr = null; key = ''; }

async function load({ model, dtype, device, approxBytes = 0 }, id) {
  const k = `${model}|${JSON.stringify(dtype)}|${device}`;
  if (asr && key === k) return;
  await dispose();
  // The big model files are downloaded here, streamed to disk with exact progress.
  const urls = Object.entries(dtype).map(([f, d]) => `${HF}${model}/resolve/main/onnx/${f}${SUFFIX[d]}.onnx`);
  const need = [];
  for (const u of urls) if (!(await store.has(u))) need.push(u);
  if (need.length) {
    const sizes = await Promise.all(need.map(store.sizeOf));
    const total = sizes.reduce((a, b) => a + b, 0) || approxBytes;
    let loaded = 0;
    for (const u of need) await store.download(u, (n) => { loaded += n; post({ id, type: 'progress', loaded: Math.min(loaded, total), total, text: 'Downloading the speech model' }); });
  }
  post({ id, type: 'progress', text: 'Preparing the speech model' });
  asr = await pipeline('automatic-speech-recognition', model, { dtype, device });
  key = k;
  // One short run compiles the GPU programs, so the first real phrase is quick.
  await asr(new Float32Array(16000), { language: 'en', task: 'transcribe' });
}

/** Picks the most likely language among `langs` (e.g. ['en', 'el']) from the first 30 s. */
async function detect(audio, langs) {
  const cfg = asr.model.generation_config || {};
  const ids = (langs || []).map((l) => [l, cfg.lang_to_id?.[`<|${l}|>`]]).filter(([, i]) => i != null);
  if (ids.length < 2) return ids[0]?.[0] || null;
  const { input_features } = await asr.processor(audio.subarray(0, 16000 * 30));
  const sot = cfg.decoder_start_token_id ?? 50258;
  const out = await asr.model({ input_features, decoder_input_ids: new Tensor('int64', BigInt64Array.from([BigInt(sot)]), [1, 1]) });
  const logits = out.logits, V = logits.dims[logits.dims.length - 1], base = logits.data.length - V;
  let best = ids[0][0], bv = -Infinity;
  for (const [l, i] of ids) { const v = Number(logits.data[base + i]); if (v > bv) { bv = v; best = l; } }
  return best;
}

async function transcribe({ audio, language, task = 'transcribe' }) {
  const out = await asr(audio, { language: language || 'en', task, return_timestamps: true });
  const chunks = (out.chunks || []).map((c) => ({ s: c.timestamp?.[0] ?? 0, e: c.timestamp?.[1] ?? null, t: String(c.text || '').trim() })).filter((c) => c.t);
  return { text: String(out.text || '').trim(), chunks };
}

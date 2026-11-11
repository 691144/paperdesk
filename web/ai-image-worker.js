/* PaperDesk image AI: SD-Turbo (one-step Stable Diffusion) with ONNX Runtime on
   WebGPU, in a background thread. Model files are downloaded once from Hugging
   Face and kept in this browser's cache; prompts and pictures stay on the device. */
import * as ort from 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/ort.webgpu.bundle.min.mjs';
import { AutoTokenizer, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.1/dist/transformers.min.js';
import * as store from './ai-store.js';

env.allowLocalModels = false;
env.useBrowserCache = false;
env.useCustomCache = true;
env.customCache = store.cache;
ort.env.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.31.0-dev.20260914-8d85527a0/dist/';
const BASE = 'https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/main/';
const PARTS = {
  text_encoder: { size: 681393168, dims: { batch_size: 1 } },
  unet: { size: 1733430199, dims: { batch_size: 1, num_channels: 4, height: 64, width: 64, sequence_length: 77 } },
  vae_decoder: { size: 99094314, dims: { batch_size: 1, num_channels_latent: 4, height_latent: 64, width_latent: 64 } },
};
const SIGMA = 14.6146, VAE_SCALE = 0.18215;
let sess = null, tok = null;
const post = (m) => self.postMessage(m);

self.onmessage = async ({ data }) => {
  const { id, type } = data;
  try {
    if (type === 'load') { await load(id); post({ id, type: 'done' }); }
    else if (type === 'generate') post({ id, type: 'done', result: await generate(data) });
    else if (type === 'delete') { await unload(); for (const name of Object.keys(PARTS)) await store.remove(BASE + name + '/model.onnx'); post({ id, type: 'done' }); }
    else if (type === 'unload') { await unload(); post({ id, type: 'done' }); }
  } catch (e) {
    post({ id, type: 'error', error: String(e?.message || e) });
  }
};

async function unload() { if (sess) for (const s of Object.values(sess)) { try { await s.release(); } catch { /* gone */ } } sess = null; }

/** Downloads a model file into the private file store (with progress), then returns its bytes. */
async function fetchModel(name, onBytes) {
  const url = BASE + name + '/model.onnx';
  if (await store.has(url)) onBytes(PARTS[name].size);
  else await store.download(url, onBytes);
  const f = await store.file(url);
  if (!f) throw new Error(`The ${name.replace('_', ' ')} file could not be stored. Free some space and try again.`);
  return new Uint8Array(await f.arrayBuffer());
}

async function load(id) {
  if (sess) return;
  if (!navigator.gpu) throw new Error('Pictures need WebGPU, which this browser does not offer.');
  const total = Object.values(PARTS).reduce((s, p) => s + p.size, 0);
  let loaded = 0;
  const onBytes = (n) => { loaded += n; post({ id, type: 'progress', loaded: Math.min(loaded, total), total, text: 'Downloading the picture model' }); };
  tok = tok || await AutoTokenizer.from_pretrained('Xenova/clip-vit-base-patch16');
  const opts = (dims) => ({
    executionProviders: ['webgpu'], enableMemPattern: false, enableCpuMemArena: false, freeDimensionOverrides: dims,
    extra: { session: { disable_prepacking: '1', use_device_allocator_for_initializers: '1', use_ort_model_bytes_directly: '1', use_ort_model_bytes_for_initializers: '1' } },
  });
  const s = {};
  for (const name of Object.keys(PARTS)) {
    const bytes = await fetchModel(name, onBytes);
    post({ id, type: 'progress', loaded, total, text: `Preparing ${name.replace('_', ' ')}` });
    s[name] = await ort.InferenceSession.create(bytes, opts(PARTS[name].dims));
  }
  sess = s;
}

function rng(seed) {
  let a = seed >>> 0;
  const next = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  return () => { const u = Math.max(1e-12, next()), v = next(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
}

async function generate({ prompt, seed = (Math.random() * 2 ** 31) | 0, id }) {
  await load(id);
  const t0 = performance.now();
  // CLIP tokens: start, words, end, then padded with 0 ("!") as SD 2.x expects.
  const enc = await tok(String(prompt || '').slice(0, 400), { add_special_tokens: true, return_tensor: false });
  let ids = Array.from(enc.input_ids, Number);
  if (ids.length > 77) ids = [...ids.slice(0, 76), ids[ids.length - 1]];
  while (ids.length < 77) ids.push(0);
  const te = sess.text_encoder;
  let teOut;
  try { teOut = await te.run({ input_ids: new ort.Tensor('int32', Int32Array.from(ids), [1, 77]) }); }
  catch { teOut = await te.run({ input_ids: new ort.Tensor('int64', BigInt64Array.from(ids.map(BigInt)), [1, 77]) }); }
  const hidden = teOut.last_hidden_state || teOut[te.outputNames[0]];
  post({ id, type: 'progress', text: 'Painting' });

  const n = 4 * 64 * 64, rand = rng(seed), latent = new Float32Array(n), input = new Float32Array(n), div = Math.sqrt(SIGMA * SIGMA + 1);
  for (let i = 0; i < n; i++) { latent[i] = rand() * SIGMA; input[i] = latent[i] / div; }
  const feed = { sample: new ort.Tensor('float32', input, [1, 4, 64, 64]), encoder_hidden_states: hidden };
  let unetOut;
  try { unetOut = await sess.unet.run({ ...feed, timestep: new ort.Tensor('int64', BigInt64Array.from([999n]), [1]) }); }
  catch { unetOut = await sess.unet.run({ ...feed, timestep: new ort.Tensor('float32', Float32Array.from([999]), [1]) }); }
  const eps = (unetOut.out_sample || unetOut[sess.unet.outputNames[0]]).data;
  // One Euler step to the clean latent, then into the VAE's scale.
  const x0 = new Float32Array(n);
  for (let i = 0; i < n; i++) x0[i] = (latent[i] - SIGMA * eps[i]) / VAE_SCALE;
  post({ id, type: 'progress', text: 'Finishing' });
  const vae = await sess.vae_decoder.run({ latent_sample: new ort.Tensor('float32', x0, [1, 4, 64, 64]) });
  const px = (vae.sample || vae[sess.vae_decoder.outputNames[0]]).data;
  const W = 512, H = 512, img = new ImageData(W, H), plane = W * H;
  for (let i = 0; i < plane; i++) {
    for (let ch = 0; ch < 3; ch++) img.data[i * 4 + ch] = Math.max(0, Math.min(255, Math.round((px[ch * plane + i] / 2 + 0.5) * 255)));
    img.data[i * 4 + 3] = 255;
  }
  const cv = new OffscreenCanvas(W, H); cv.getContext('2d').putImageData(img, 0, 0);
  const blob = await cv.convertToBlob({ type: 'image/jpeg', quality: 0.9 });
  return { blob, seed, ms: Math.round(performance.now() - t0) };
}

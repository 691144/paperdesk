/* PaperDesk AI, all on this device.
   - Speech to text: Whisper (transformers.js) in ai-asr-worker.js.
   - Writing help, checklists, charts, diagrams, drawings and 3D specs: a small
     language model (WebLLM, WebGPU) in ai-llm-worker.js.
   - Pictures: SD-Turbo (ONNX Runtime, WebGPU) in ai-image-worker.js.
   Models download once from Hugging Face and stay in this browser's storage.
   Notes, recordings and prompts never leave the device. */
(function () {
  'use strict';
  const A = window.PaperDeskApp, R = window.PDAIRender, FX = window.PaperDeskFeatures || {};
  if (!A || !R) return;
  const { $, $$, esc, icon, toast, S, save, pushUndo, findNote, activeBoard, renderAll } = A;
  const WEBLLM = 'https://cdn.jsdelivr.net/npm/@mlc-ai/web-llm@0.2.86/+esm';
  const RATE = 16000;

  /* ------------------------------------------------------------ note types */
  Object.assign(A.TYPES, {
    chart: { label: 'Chart', icon: 'chart', app: 'Charts' },
    sketch: { label: 'Sketch', icon: 'shapes', app: 'Drawing' },
    image: { label: 'Picture', icon: 'image', app: 'Image viewer' },
    model3d: { label: '3D model', icon: 'cube', app: '3D viewer' },
  });

  /* ------------------------------------------------------------ settings */
  const ls = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  const cfg = Object.assign({ speech: '', text: '', image: '', langs: ['en', 'el'], lang: 'auto', tipShown: false }, ls.get('pd.ai', {}));
  const saveCfg = () => ls.set('pd.ai', cfg);

  /* ------------------------------------------------------------ device */
  const dev = { checked: false, gpu: false, f16: false, vendor: '', mobile: /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent), mem: navigator.deviceMemory || 8 };
  const devReady = (async () => {
    try {
      const ad = await navigator.gpu?.requestAdapter({ powerPreference: 'high-performance' });
      if (ad) { dev.gpu = true; dev.f16 = ad.features.has('shader-f16'); dev.vendor = ad.info?.vendor || ''; }
    } catch { /* no WebGPU */ }
    dev.checked = true;
  })();

  /* ------------------------------------------------------------ models */
  const SPEECH = [
    { id: 'whisper-turbo', name: 'Whisper large-v3 turbo', repo: 'onnx-community/whisper-large-v3-turbo', mb: 1610, gpu: true, f16: true,
      dtype: () => ({ encoder_model: 'fp16', decoder_model_merged: 'q4' }), about: 'The most accurate choice for English, Greek and about 95 other languages. Best on laptops and desktops.' },
    { id: 'whisper-turbo-compact', name: 'Whisper large-v3 turbo, compact', repo: 'onnx-community/whisper-large-v3-turbo', mb: 565, gpu: true,
      dtype: () => (dev.f16 ? { encoder_model: 'q4f16', decoder_model_merged: 'q4f16' } : { encoder_model: 'q4', decoder_model_merged: 'q4' }), about: 'Nearly as accurate with a third of the download. Good for phones and tablets.' },
    { id: 'whisper-small', name: 'Whisper small', repo: 'onnx-community/whisper-small', mb: 250, gpu: false,
      dtype: () => ({ encoder_model: 'q8', decoder_model_merged: 'q8' }), about: 'Works without WebGPU, on the processor. Slower, and less accurate in Greek.' },
  ];
  const TEXT = [
    { id: 'Qwen3.5-4B-q4f16_1-MLC', name: 'Qwen 3.5 4B', mb: 2390, gpu: true, about: 'Best writing, diagrams and 3D models. Needs a recent laptop or desktop with a good graphics chip.' },
    { id: 'Qwen3.5-2B-q4f16_1-MLC', name: 'Qwen 3.5 2B', mb: 1083, gpu: true, about: 'A good balance of speed and quality. Its 3D models and drawings stay simple.' },
    { id: 'Qwen3.5-0.8B-q4f16_1-MLC', name: 'Qwen 3.5 0.8B', mb: 447, gpu: true, about: 'Fastest and smallest; for phones and older computers. Simpler results.' },
  ];
  const IMAGE = [
    { id: 'sd-turbo', name: 'SD-Turbo', mb: 2514, gpu: true, about: 'Pictures at 512 × 512 in one step. Stability AI licence for non-commercial use (fine for personal notes).' },
  ];
  const KINDS = { speech: SPEECH, text: TEXT, image: IMAGE };
  const KIND_NAME = { speech: 'Speech to text', text: 'Writing and making', image: 'Pictures' };
  const modelOf = (kind) => KINDS[kind].find((m) => m.id === cfg[kind]) || null;
  const usable = (m) => !m.gpu || (dev.gpu && (!m.f16 || dev.f16));
  function suggested(kind) {
    if (kind === 'speech') return dev.gpu && dev.f16 && !dev.mobile ? 'whisper-turbo' : dev.gpu ? 'whisper-turbo-compact' : 'whisper-small';
    if (kind === 'text') return !dev.gpu ? '' : dev.mobile || dev.mem <= 4 ? 'Qwen3.5-0.8B-q4f16_1-MLC' : 'Qwen3.5-2B-q4f16_1-MLC';
    return dev.gpu ? 'sd-turbo' : '';
  }
  const fmtMB = (mb) => (mb >= 1000 ? `${(mb / 1000).toFixed(1)} GB` : `${Math.round(mb)} MB`);

  /* ------------------------------------------------------------ what is downloaded */
  const inst = { speech: {}, text: {}, image: {} };
  const SUFFIX = { fp32: '', fp16: '_fp16', q8: '_quantized', int8: '_int8', uint8: '_uint8', q4: '_q4', q4f16: '_q4f16', bnb4: '_bnb4' };
  const SD_URLS = ['text_encoder', 'unet', 'vae_decoder'].map((p) => `https://huggingface.co/schmuell/sd-turbo-ort-web/resolve/main/${p}/model.onnx`);
  let storeMod = null;
  const store = () => storeMod || (storeMod = import(new URL('ai-store.js', location.href).href));
  const speechUrls = (m) => Object.entries(m.dtype()).map(([f, d]) => `https://huggingface.co/${m.repo}/resolve/main/onnx/${f}${SUFFIX[d]}.onnx`);
  let webllmMod = null;
  const webllm = () => webllmMod || (webllmMod = import(WEBLLM).catch((e) => { webllmMod = null; throw e; }));
  async function refreshInstalled() {
    await devReady;
    try {
      const S = await store();
      for (const m of SPEECH) inst.speech[m.id] = (await Promise.all(speechUrls(m).map(S.has))).every(Boolean);
      inst.image['sd-turbo'] = (await Promise.all(SD_URLS.map(S.has))).every(Boolean);
    } catch { /* no private file system here */ }
    if (dev.gpu) {
      try { const W = await webllm(); for (const m of TEXT) inst.text[m.id] = await W.hasModelInCache(m.id); }
      catch { /* offline the first time: unknown */ }
    }
  }
  async function deleteModel(kind, m) {
    if (kind === 'speech') {
      if (eng.speechKey.startsWith(m.id)) { await eng.speech?.call('unload').catch(() => {}); eng.speechKey = ''; }
      const S = await store(); for (const u of speechUrls(m)) await S.remove(u);
    } else if (kind === 'text') {
      if (eng.textId === m.id) { await eng.text?.unload().catch(() => {}); eng.textId = ''; }
      const W = await webllm(); await W.deleteModelAllInfoInCache(m.id);
    } else {
      await eng.image?.call('unload').catch(() => {}); eng.imageReady = false;
      const S = await store(); for (const u of SD_URLS) await S.remove(u);
    }
    inst[kind][m.id] = false;
    if (cfg[kind] === m.id) { cfg[kind] = ''; saveCfg(); }
  }

  /* ------------------------------------------------------------ progress */
  const prog = { speech: null, text: null, image: null };
  function setProg(kind, p) {
    if (p && p.total) p.pct = Math.min(1, p.loaded / p.total);
    prog[kind] = p ? { ...(prog[kind] || {}), ...p } : null;
    renderStatus();
    if (dlg?.open && (st.view === 'models' || st.view === 'run')) updateLive();
  }
  function progText(kind) {
    const p = prog[kind]; if (!p) return '';
    const pct = p.pct != null ? ` ${Math.round(p.pct * 100)}%` : '';
    const size = p.total ? ` · ${fmtMB(p.loaded / 1e6)} of ${fmtMB(p.total / 1e6)}` : '';
    return `${p.text || 'Loading'}${pct}${size}`;
  }
  let statusEl = null;
  function renderStatus() {
    if (!statusEl) {
      statusEl = document.createElement('button');
      statusEl.id = 'ai-status'; statusEl.type = 'button'; statusEl.className = 'float';
      statusEl.addEventListener('click', () => open({ view: st.busy ? 'run' : 'models' }));
      document.body.appendChild(statusEl);
    }
    const kind = ['speech', 'text', 'image'].find((k) => prog[k]);
    if (!kind && !live.size) { statusEl.hidden = true; return; }
    statusEl.hidden = false;
    const p = kind ? prog[kind] : null;
    statusEl.innerHTML = `${icon(kind ? 'sparkle' : 'mic', 's16')}<span>${esc(kind ? progText(kind) : 'Transcribing as you speak')}</span>${p?.pct != null ? `<i style="--p:${Math.round(p.pct * 100)}%"></i>` : ''}`;
  }

  /* ------------------------------------------------------------ engines */
  function rpc(url) {
    const w = new Worker(new URL(url, location.href), { type: 'module' });
    let seq = 0; const pend = new Map();
    const fail = (msg) => { for (const p of pend.values()) p.reject(new Error(msg)); pend.clear(); };
    w.onmessage = ({ data }) => {
      const p = pend.get(data.id); if (!p) return;
      if (data.type === 'progress') { p.onProgress?.(data); return; }
      pend.delete(data.id);
      if (data.type === 'error') p.reject(new Error(data.error)); else p.resolve(data.result);
    };
    w.onerror = (e) => { e.preventDefault?.(); fail(e.message || 'The AI helper stopped. Check the connection for the first download, then try again.'); };
    const api = {
      dead: false,
      /** timeoutMs: if the graphics chip stops answering, give up and restart the helper next time. */
      call(type, payload = {}, onProgress, transfer, timeoutMs = 0) {
        const id = ++seq;
        return new Promise((resolve, reject) => {
          let timer = 0;
          const done = (fn) => (v) => { clearTimeout(timer); fn(v); };
          pend.set(id, { resolve: done(resolve), reject: done(reject), onProgress: (p) => { if (timeoutMs) { clearTimeout(timer); timer = setTimeout(stuck, timeoutMs); } onProgress?.(p); } });
          const stuck = () => { api.dead = true; w.terminate(); fail(STUCK); };
          if (timeoutMs) timer = setTimeout(stuck, timeoutMs);
          w.postMessage({ id, type, ...payload }, transfer || []);
        });
      },
      terminate() { api.dead = true; w.terminate(); fail('Stopped'); },
    };
    return api;
  }
  const STUCK = 'The graphics chip stopped responding, so this was cancelled. Try a shorter text or a smaller model in Models & settings. If AI keeps getting stuck, restart the browser.';
  class NeedSetup extends Error { constructor(kind) { super(`${KIND_NAME[kind]} needs a one-time model download.`); this.kind = kind; this.name = 'NeedSetup'; } }
  const eng = { speech: null, speechKey: '', speechLoading: null, text: null, textId: '', textLoading: null, image: null, imageReady: false, imageLoading: null };
  function persist() { navigator.storage?.persist?.().catch(() => {}); }
  /** Before a download: is there room in this browser's storage for the model? */
  async function roomFor(kind, m) {
    if (!inst[kind][m.id]) await refreshInstalled().catch(() => {});
    if (inst[kind][m.id]) return;
    const e = await navigator.storage?.estimate?.().catch(() => null);
    if (!e?.quota) return;
    const free = e.quota - (e.usage || 0);
    if (free < m.mb * 1e6 * 1.05) throw new Error(`Not enough storage for ${m.name}: it needs ${fmtMB(m.mb)}, and this browser allows PaperDesk ${fmtMB(Math.max(0, free) / 1e6)} more. Delete a model you don't use in Models & settings, or free up disk space.`);
  }

  async function ensureSpeech() {
    await devReady;
    const m = modelOf('speech'); if (!m) throw new NeedSetup('speech');
    const device = m.gpu && dev.gpu ? 'webgpu' : 'wasm', key = `${m.id}|${device}`;
    if (eng.speech?.dead) { eng.speech = null; eng.speechKey = ''; }
    if (eng.speechKey === key) return;
    if (eng.speechLoading) return eng.speechLoading;
    setProg('speech', { text: 'Starting the speech model' });
    eng.speechLoading = (async () => {
      await roomFor('speech', m); persist();
      eng.speech = eng.speech || rpc('ai-asr-worker.js');
      await eng.speech.call('load', { model: m.repo, dtype: m.dtype(), device, approxBytes: m.mb * 1e6 }, (p) => setProg('speech', p));
    })()
      .then(() => { eng.speechKey = key; inst.speech[m.id] = true; })
      .catch((e) => { eng.speech?.terminate(); eng.speech = null; throw e; })
      .finally(() => { eng.speechLoading = null; setProg('speech', null); });
    return eng.speechLoading;
  }
  async function ensureText() {
    await devReady;
    const m = modelOf('text'); if (!m) throw new NeedSetup('text');
    if (!dev.gpu) throw new Error('Writing help needs WebGPU (Chrome, Edge, or Safari 26 and later).');
    if (eng.text && eng.textId === m.id) return eng.text;
    if (eng.textLoading) return eng.textLoading;
    setProg('text', { text: 'Starting the language model' });
    eng.textLoading = (async () => {
      await roomFor('text', m); persist();
      const W = await webllm();
      const cb = (r) => setProg('text', { pct: r.progress, text: /fetch|download|param/i.test(r.text || '') ? 'Downloading the language model' : 'Preparing the language model' });
      if (!eng.text) { eng.textWorker = new Worker(new URL('ai-llm-worker.js', location.href), { type: 'module' }); eng.text = await W.CreateWebWorkerMLCEngine(eng.textWorker, m.id, { initProgressCallback: cb }); }
      else { eng.text.setInitProgressCallback?.(cb); await eng.text.reload(m.id); }
      eng.textId = m.id; inst.text[m.id] = true;
      return eng.text;
    })().finally(() => { eng.textLoading = null; setProg('text', null); });
    return eng.textLoading;
  }
  async function ensureImage() {
    await devReady;
    if (!modelOf('image')) throw new NeedSetup('image');
    if (!dev.gpu) throw new Error('Pictures need WebGPU (Chrome, Edge, or Safari 26 and later).');
    if (eng.image?.dead) { eng.image = null; eng.imageReady = false; }
    if (eng.imageReady) return;
    if (eng.imageLoading) return eng.imageLoading;
    setProg('image', { text: 'Starting the picture model' });
    eng.imageLoading = (async () => {
      await roomFor('image', IMAGE[0]); persist();
      eng.image = eng.image || rpc('ai-image-worker.js');
      await eng.image.call('load', {}, (p) => setProg('image', p));
    })()
      .then(() => { eng.imageReady = true; inst.image['sd-turbo'] = true; })
      .catch((e) => { eng.image?.terminate(); eng.image = null; throw e; })
      .finally(() => { eng.imageLoading = null; setProg('image', null); });
    return eng.imageLoading;
  }

  let useGrammar = true;
  /** Chat with the language model. Streams through onText; schema gives JSON. */
  async function chat(messages, { schema = null, maxTokens = 700, temperature = 0.4, onText, penalty = 0 } = {}) {
    const e = await ensureText();
    const req = { messages, stream: true, max_tokens: maxTokens, temperature, top_p: 0.9, extra_body: { enable_thinking: false } };
    // Lists: a mild penalty keeps small models from repeating items.
    if (penalty) { req.presence_penalty = penalty; req.frequency_penalty = penalty / 2; }
    // JSON answers follow a grammar for compact JSON (no indentation tokens, so they arrive sooner).
    if (schema) req.response_format = useGrammar ? { type: 'grammar', grammar: R.schemaToGrammar(schema) } : { type: 'json_object', schema: JSON.stringify(schema) };
    // Watchdog: if the graphics chip stops answering, cancel and start a fresh engine next time.
    let timer = 0, onStuck;
    const stuck = new Promise((_, rej) => { onStuck = rej; });
    stuck.catch(() => {});
    const arm = (ms) => { clearTimeout(timer); timer = setTimeout(() => { resetText(); onStuck(new Error(STUCK)); }, ms); };
    arm(45000 + messages.reduce((n, x) => n + x.content.length, 0) * 30);
    const race = (p) => Promise.race([p, stuck]);
    let out = '', chunks;
    try {
      try { chunks = await race(e.chat.completions.create(req)); }
      catch (err) {
        if (!schema || !useGrammar || err.message === STUCK) throw err;
        useGrammar = false; req.response_format = { type: 'json_object', schema: JSON.stringify(schema) };
        chunks = await race(e.chat.completions.create(req));
      }
      const it = chunks[Symbol.asyncIterator]();
      for (;;) {
        const { value: ch, done } = await race(it.next());
        if (done) break;
        arm(30000);
        const d = ch.choices?.[0]?.delta?.content || '';
        if (d) { out += d; onText?.(R.stripThink(out)); }
        if (st.stop) { st.stop = false; await e.interruptGenerate(); throw Object.assign(new Error('Stopped'), { name: 'AbortError' }); }
        // Small models sometimes loop, repeating the same lines: stop there and keep what came before.
        if (out.length > 500 && out.length % 40 < d.length) {
          const tail = out.slice(-140);
          if (out.slice(0, -140).includes(tail)) { await e.interruptGenerate(); out = out.slice(0, out.length - 140); break; }
        }
      }
    } finally { clearTimeout(timer); }
    return out;
  }
  function resetText() {
    try { eng.textWorker?.terminate(); } catch { /* gone */ }
    Object.assign(eng, { text: null, textId: '', textWorker: null, textLoading: null });
  }
  async function chatJSON(messages, schema, opts = {}) {
    // Compact JSON is fewer tokens, so it arrives sooner.
    const m = messages.map((x, i) => (i === messages.length - 1 ? { ...x, content: `${x.content}\n\nReply with compact JSON on one line.` } : x));
    const raw = await chat(m, { ...opts, schema });
    const j = R.parseJSON(raw);
    if (!j) throw new Error('The model\'s answer could not be read. Try again, or choose a bigger model in AI settings.');
    return j;
  }

  /* ------------------------------------------------------------ prompts */
  const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const today = () => { const d = new Date(); return `${isoDay(d)} (${d.toLocaleDateString('en', { weekday: 'long' })})`; };
  // Small models are poor at date arithmetic: give them the next two weeks to read from.
  const nextDays = () => Array.from({ length: 14 }, (_, i) => { const d = new Date(); d.setDate(d.getDate() + i + 1); return `${d.toLocaleDateString('en', { weekday: 'long' })} ${isoDay(d)}`; }).join(', ');
  const SYS = () => `You are the assistant inside PaperDesk, an app for quick notes on a desk. Today is ${today()}. Reply in the same language as the user's text (for example Greek or English) unless asked to translate. Be concise and practical. Output only what is asked: no introductions, no explanations.`;
  // The instructions are English, so small models drift into English: say it plainly when the user's text is Greek.
  const greek = (text) => { const g = (text.match(/[Ͱ-Ͽἀ-῿]/g) || []).length, l = (text.match(/[A-Za-z]/g) || []).length; return g >= 20 && (g * 3 >= l || g >= 300); };
  const msgs = (user, { hint = true } = {}) => [{ role: 'system', content: SYS() }, { role: 'user', content: hint && greek(user) ? `${user}\n\nWrite the answer in Greek (Ελληνικά).` : user }];
  function noteText(n, max = 3000) {
    const parts = [n.title && `Title: ${n.title}`, n.body && n.body.trim(), (n.tasks || []).map((t) => `- [${t.done ? 'x' : ' '}] ${t.title}`).join('\n'), n.url && !/^data:/.test(n.url) ? n.url : '', n.meta?.chart ? `Chart data:\n${R.chartToCSV(n.meta.chart)}` : ''];
    return parts.filter(Boolean).join('\n').slice(0, max);
  }
  function notesText(notes, max = 4500) {
    let out = '';
    for (const n of notes) { const t = noteText(n, 1500); if (!t) continue; const add = `### ${A.TYPES[n.type]?.label || 'Note'}\n${t}\n\n`; if (out.length + add.length > max) break; out += add; }
    return out.trim();
  }
  const S_STR = { type: 'string' };
  const SCHEMA = {
    kind: { type: 'object', properties: { kind: { type: 'string', enum: ['note', 'checklist', 'chart', 'diagram', 'drawing', 'image', 'model3d', 'reminder'] } }, required: ['kind'] },
    note: { type: 'object', properties: { title: S_STR, body: S_STR }, required: ['title', 'body'] },
    checklist: { type: 'object', properties: { title: S_STR, tasks: { type: 'array', items: S_STR } }, required: ['title', 'tasks'] },
    chart: { type: 'object', properties: { title: S_STR, type: { type: 'string', enum: R.CHART_TYPES }, unit: S_STR, labels: { type: 'array', items: S_STR }, series: { type: 'array', items: { type: 'object', properties: { name: S_STR, values: { type: 'array', items: { type: 'number' } } }, required: ['name', 'values'] } } }, required: ['title', 'type', 'labels', 'series'] },
    diagram: { type: 'object', properties: { title: S_STR, layout: { type: 'string', enum: ['down', 'right', 'mindmap'] }, nodes: { type: 'array', items: { type: 'object', properties: { id: S_STR, label: S_STR, shape: { type: 'string', enum: ['rect', 'ellipse', 'diamond'] } }, required: ['id', 'label'] } }, edges: { type: 'array', items: { type: 'object', properties: { from: S_STR, to: S_STR, label: S_STR }, required: ['from', 'to'] } } }, required: ['title', 'layout', 'nodes', 'edges'] },
    drawing: { type: 'object', properties: { title: S_STR, shapes: { type: 'array', items: { type: 'object', properties: { shape: { type: 'string', enum: ['rect', 'ellipse', 'triangle', 'diamond', 'star', 'line', 'arrow', 'text'] }, x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, x2: { type: 'number' }, y2: { type: 'number' }, color: S_STR, fill: { type: 'boolean' }, label: S_STR }, required: ['shape', 'x', 'y'] } } }, required: ['title', 'shapes'] },
    scene: { type: 'object', properties: { title: S_STR, parts: { type: 'array', items: { type: 'object', properties: { name: S_STR, shape: { type: 'string', enum: R.PRIMS }, size: { type: 'array', items: { type: 'number' } }, position: { type: 'array', items: { type: 'number' } }, rotation: { type: 'array', items: { type: 'number' } }, color: S_STR }, required: ['shape', 'size', 'position', 'color'] } } }, required: ['title', 'parts'] },
    dates: { type: 'object', properties: { items: { type: 'array', items: { type: 'object', properties: { kind: { type: 'string', enum: ['reminder', 'event'] }, title: S_STR, date: S_STR, time: S_STR }, required: ['kind', 'title', 'date'] } } }, required: ['items'] },
  };
  // Upper bounds keep answers short enough for small models and slower graphics chips.
  (() => {
    const p = (s) => s.properties, three = { minItems: 3, maxItems: 3 };
    p(SCHEMA.checklist).tasks.maxItems = 25;
    Object.assign(p(SCHEMA.chart).labels, { maxItems: 24 }); Object.assign(p(SCHEMA.chart).series, { maxItems: 6 }); p(SCHEMA.chart).series.items.properties.values.maxItems = 24;
    p(SCHEMA.diagram).nodes.maxItems = 16; p(SCHEMA.diagram).edges.maxItems = 24;
    p(SCHEMA.drawing).shapes.maxItems = 20;
    p(SCHEMA.scene).parts.maxItems = 12;
    for (const k of ['size', 'position', 'rotation']) Object.assign(p(SCHEMA.scene).parts.items.properties[k], three);
    p(SCHEMA.dates).items.maxItems = 12;
  })();
  const P = {
    chart: 'Make a chart. labels are the categories. series is usually ONE series whose values list one number per label, in the same order. Use several series only to compare groups (for example 2025 and 2026). Use the numbers given; only if there are none, invent realistic numbers and end the title with " (example)". Choose the type: bar to compare, line or area for change over time, pie or doughnut for parts of a whole, hbar for long labels. Example: {"title":"Monthly costs","type":"bar","unit":"EUR","labels":["Rent","Food","Transport"],"series":[{"name":"Cost","values":[900,400,120]}]}',
    diagram: 'Make a diagram as nodes and edges. Short labels (max 5 words). Use layout "down" for processes and flowcharts, "right" for timelines, "mindmap" for ideas around one topic. Use shape "diamond" for decisions and "ellipse" for start and end. Keep it under 14 nodes. Node ids are short words.',
    drawing: 'Make a simple drawing from basic shapes on a 100 × 100 grid (x to the right, y down). rect, ellipse, triangle, diamond and star use x, y (top-left corner), w and h. line and arrow go from x, y to x2, y2. text puts label at x, y. Colours: black, red, blue, green, orange, yellow, brown, gray, purple. Use fill true for solid areas. Use 4 to 15 shapes and never repeat a shape. Example, a sailing boat: {"title":"Sailing boat","shapes":[{"shape":"rect","x":0,"y":75,"w":100,"h":25,"color":"blue","fill":true},{"shape":"rect","x":25,"y":62,"w":50,"h":12,"color":"brown","fill":true},{"shape":"line","x":50,"y":15,"x2":50,"y2":62,"color":"black"},{"shape":"triangle","x":50,"y":18,"w":22,"h":40,"color":"orange","fill":true},{"shape":"text","x":50,"y":92,"label":"Sea","color":"black"}]}',
    scene: 'Make a simple 3D model from primitive parts. Units are metres, y is up and the floor is y = 0. position is the centre of a part. size is [width, height, depth]: for sphere, cylinder, cone and capsule use [diameter, height, diameter]; torus uses [diameter, diameter, tube thickness]. rotation is in degrees [x, y, z]. color is a hex colour like "#8B5A2B". Use 3 to 12 parts, each one different, and make the parts touch. Example, a snowman: {"title":"Snowman","parts":[{"name":"body","shape":"sphere","size":[0.8,0.8,0.8],"position":[0,0.4,0],"rotation":[0,0,0],"color":"#F4F4F4"},{"name":"head","shape":"sphere","size":[0.5,0.5,0.5],"position":[0,1.0,0],"rotation":[0,0,0],"color":"#F4F4F4"},{"name":"nose","shape":"cone","size":[0.08,0.25,0.08],"position":[0,1.0,0.3],"rotation":[90,0,0],"color":"#E8792B"},{"name":"hat","shape":"cylinder","size":[0.35,0.3,0.35],"position":[0,1.35,0],"rotation":[0,0,0],"color":"#222222"}]}',
    dates: () => { const t = new Date(); t.setDate(t.getDate() + 1); return `Find every date or time in the text and turn each into a reminder (kind "reminder", for things to do) or a calendar event (kind "event", for meetings and appointments). date is YYYY-MM-DD; time is HH:MM (24-hour) or "". Today is ${today()}. For words like "tomorrow" or "next Friday", read the date from this list of the coming days: ${nextDays()}. Example: "call Anna tomorrow at 9" gives {"items":[{"kind":"reminder","title":"Call Anna","date":"${isoDay(t)}","time":"09:00"}]}. Return {"items":[]} only when the text has no date or time at all.`; },
  };

  /* ------------------------------------------------------------ the AI panel */
  const st = { view: 'home', prompt: '', kind: 'auto', at: null, busy: false, stop: false, title: '', out: '', error: '', result: null, notice: '', question: '' };
  let dlg = null;
  function mount() {
    dlg = document.createElement('dialog');
    dlg.id = 'ai-dlg'; dlg.setAttribute('aria-label', 'AI');
    dlg.innerHTML = '<div class="sd ai"></div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('input', onInput);
    dlg.addEventListener('change', onChange);
    dlg.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && e.target.id === 'ai-q') { e.preventDefault(); create(); } if (e.key === 'Enter' && e.target.id === 'ai-ask') { e.preventDefault(); askDesk(); } });
    dlg.addEventListener('cancel', (e) => { if (st.busy) { e.preventDefault(); st.stop = true; } });
    dlg.addEventListener('mousedown', (e) => { if (e.target === dlg && !st.busy) dlg.close(); });
  }
  function open({ view = 'home', at = null, kind = null } = {}) {
    if (!dlg) mount();
    if (!st.busy) Object.assign(st, { view, error: '', notice: view === 'home' ? '' : st.notice });
    if (at) st.at = at; else if (view === 'home') st.at = null;
    if (kind) st.kind = kind;
    render();
    if (!dlg.open) dlg.showModal();
    if (st.view === 'models') refreshInstalled().then(() => { if (st.view === 'models') render(); });
    setTimeout(() => (st.view === 'home' ? $('#ai-q', dlg) : $('.sd-foot .primary', dlg))?.focus(), 30);
  }
  const head = (title, back) => `<div class="sd-head">${back ? `<button type="button" class="ib back" data-act="${back}" aria-label="Back">${icon('arrow-l')}</button>` : `<span class="sd-mono" style="--c:var(--accent)">${icon('sparkle')}</span>`}<h2>${esc(title)}</h2><button type="button" class="ib" data-act="close" aria-label="Close">${icon('x')}</button></div>`;
  const CREATE_KINDS = [['auto', 'Auto'], ['note', 'Note'], ['checklist', 'Checklist'], ['chart', 'Chart'], ['diagram', 'Diagram'], ['drawing', 'Drawing'], ['image', 'Picture'], ['model3d', '3D'], ['reminder', 'Reminders']];
  function modelsLine() {
    const bits = ['speech', 'text', 'image'].map((k) => { const m = modelOf(k); return m ? `${KIND_NAME[k]}: ${m.name}` : null; }).filter(Boolean);
    return bits.length ? esc(bits.join(' · ')) : 'Nothing downloaded yet';
  }
  function viewHome() {
    const sel = A.selectedIds().map(findNote).filter(Boolean), scope = sel.length > 1 ? `the ${sel.length} selected notes` : 'this desk';
    const none = !cfg.speech && !cfg.text && !cfg.image;
    return head('AI on this device') + `<div class="sd-body">
      ${none ? `<div class="ai-setup">${icon('sparkle', 's20')}<div class="t"><b>Set up once</b><p>Choose which AI models to download. They run on this device, so your notes, recordings and prompts stay private, and AI keeps working offline.</p></div><button type="button" class="btn primary" data-act="models">Choose models</button></div>` : ''}
      ${st.notice ? `<p class="sd-warn">${esc(st.notice)}</p>` : ''}
      <label class="sd-field" for="ai-q">Create
        <textarea class="field ai-q" id="ai-q" rows="3" placeholder="Describe what you want, e.g. “packing list for a weekend in Crete”, “bar chart: rent 900, food 400, transport 120”, “flowchart for a refund”, “a lighthouse at dusk”, “3D model of a desk lamp”">${esc(st.prompt)}</textarea></label>
      <div class="sd-cats" role="group" aria-label="What to make">${CREATE_KINDS.map(([k, l]) => `<button type="button" class="sd-pill" data-kind="${k}" aria-pressed="${st.kind === k}">${esc(l)}</button>`).join('')}</div>
      <h3>For ${esc(scope)}</h3>
      <div class="sd-choice">
        <button type="button" class="btn" data-act="desk-summary">${icon('list', 's16')}Summarize</button>
        <button type="button" class="btn" data-act="desk-tasks">${icon('checklist', 's16')}Collect open tasks</button>
        <button type="button" class="btn" data-act="desk-dates">${icon('alarm', 's16')}Find dates</button>
        <button type="button" class="btn" data-act="ask">${icon('help', 's16')}Ask a question…</button>
      </div>
      <h3>Speech to text</h3>
      <div class="sd-choice"><button type="button" class="btn" data-act="dictate">${icon('mic', 's16')}Dictate a note</button><span class="sd-note ai-inline">Voice memos record with a live transcript; older ones have <b>Transcribe</b> in their AI menu.</span></div>
    </div>
    <div class="sd-foot"><span class="grow">${modelsLine()}</span><button type="button" class="btn ghost" data-act="models">Models &amp; settings</button><button type="button" class="btn primary" data-act="create">Create <span class="kbd">${A.MOD}↵</span></button></div>`;
  }
  function viewAsk() {
    return head('Ask about this desk', 'home') + `<div class="sd-body">
      <label class="sd-field" for="ai-ask">Your question<input class="field" id="ai-ask" value="${esc(st.question)}" placeholder="e.g. What is due this week? Who do I need to email?" autocomplete="off"/></label>
      <p class="sd-note">The answer uses ${A.selectedIds().length > 1 ? 'the selected notes' : 'the notes on this desk'}, read on this device.</p>
    </div><div class="sd-foot"><span class="grow"></span><button type="button" class="btn primary" data-act="ask-go">Ask</button></div>`;
  }
  function viewRun() {
    return head(st.title || 'Working…') + `<div class="sd-body">
      <div class="ai-live" id="ai-live">${liveHtml()}</div>
      <div class="ai-stream" id="ai-stream">${esc(st.out)}</div>
    </div><div class="sd-foot"><span class="grow">Runs on this device. The first time, the model downloads once.</span><button type="button" class="btn" data-act="stop">Stop</button></div>`;
  }
  function liveHtml() {
    const kind = ['speech', 'text', 'image'].find((k) => prog[k]);
    if (!kind) return st.phase ? `<div class="ai-phase">${esc(st.phase)}</div>` : '';
    const p = prog[kind];
    return `<div class="ai-phase">${esc(progText(kind))}</div>${p.pct != null ? `<span class="sd-progress"><i style="width:${Math.round(p.pct * 100)}%"></i></span>` : '<span class="sd-progress busy"><i></i></span>'}`;
  }
  function updateLive() {
    const el = $('#ai-live', dlg); if (el) el.innerHTML = liveHtml();
    if (st.view === 'models') for (const k of Object.keys(prog)) { const row = $(`[data-prog="${k}"]`, dlg); if (row) row.innerHTML = prog[k] ? `<span class="ai-phase">${esc(progText(k))}</span>${prog[k].pct != null ? `<span class="sd-progress"><i style="width:${Math.round(prog[k].pct * 100)}%"></i></span>` : ''}` : ''; }
  }
  function viewResult() {
    const r = st.result;
    return head(r.title || 'Result', 'home') + `<div class="sd-body">${r.html}</div>
      <div class="sd-foot"><span class="grow">${esc(r.foot || 'Made on this device. Undo (Ctrl Z) takes it back.')}</span>${(r.actions || []).map((a, i) => `<button type="button" class="btn ${a.primary ? 'primary' : 'ghost'}" data-res="${i}">${esc(a.label)}</button>`).join('')}</div>`;
  }
  function viewError() {
    return head('Something went wrong', 'home') + `<div class="sd-body"><p class="sd-err">${esc(st.error)}</p>
      <p class="sd-note">If a model could not download, check the connection and try again. If the device ran out of memory, choose a smaller model in Models &amp; settings.</p></div>
      <div class="sd-foot"><span class="grow"></span><button type="button" class="btn ghost" data-act="models">Models &amp; settings</button><button type="button" class="btn primary" data-act="retry">Try again</button></div>`;
  }
  function viewModels() {
    const gpuLine = !dev.checked ? 'Checking this device…' : dev.gpu ? `WebGPU is available${dev.vendor ? ` (${esc(dev.vendor)} graphics${dev.f16 ? ', 16-bit' : ''})` : ''}: models run on the graphics chip.` : 'This browser has no WebGPU, so only speech to text (Whisper small) can run here. Chrome, Edge and Safari 26 or later have WebGPU.';
    const section = (kind) => `<h3>${esc(KIND_NAME[kind])}</h3>
      ${kind === 'speech' ? `<p class="sd-note">Used for dictation and for transcribing voice memos. Whisper large-v3 turbo is the best version for both English and Greek.</p>` : kind === 'text' ? '<p class="sd-note">Writes and rewrites notes, makes checklists, charts, diagrams, drawings and 3D models, finds dates, and answers questions about your desk.</p>' : '<p class="sd-note">Makes simple pictures from a description (English works best; other languages are translated first when a language model is set up).</p>'}
      <div class="ai-models">${KINDS[kind].map((m) => {
        const ok = usable(m), on = cfg[kind] === m.id, have = inst[kind][m.id], rec = suggested(kind) === m.id;
        return `<div class="ai-model${on ? ' on' : ''}${ok ? '' : ' off'}"><div class="t"><b>${esc(m.name)}${rec ? ' <span class="sd-badge auto">Recommended here</span>' : ''}${on ? ' <span class="sd-badge">In use</span>' : ''}</b><small>${esc(m.about)}</small>
          <small>${fmtMB(m.mb)} download${have ? ' · downloaded' : ''}${ok ? '' : ' · needs WebGPU' + (m.f16 ? ' with 16-bit support' : '')}</small></div>
          <div class="acts">${ok ? `${on && have ? '' : `<button type="button" class="btn ${on ? 'primary' : ''}" data-use="${kind}:${m.id}">${have ? 'Use' : on ? 'Download' : 'Use and download'}</button>`}${have ? `<button type="button" class="ib sm" data-del="${kind}:${m.id}" aria-label="Delete ${esc(m.name)}" title="Delete from this device">${icon('trash', 's16')}</button>` : ''}` : ''}</div></div>`;
      }).join('')}${cfg[kind] ? `<button type="button" class="btn ghost sm-off" data-off="${kind}">Turn off ${esc(KIND_NAME[kind].toLowerCase())}</button>` : ''}</div>
      <div class="ai-prog" data-prog="${kind}"></div>`;
    return head('AI models and settings', 'home') + `<div class="sd-body">
      ${st.notice ? `<p class="sd-warn">${esc(st.notice)}</p>` : ''}
      <p>${gpuLine}</p>
      <p class="sd-note">Models download once from Hugging Face (the AI code from jsDelivr) and stay in this browser. After that, AI works offline. Your notes, recordings and prompts never leave this device.</p>
      ${section('speech')}
      <div class="sd-field">Languages you speak <small>Whisper picks between these for each recording. Choose “Any language” to let it detect from all languages.</small>
        <div class="sd-choice">${[['en', 'English'], ['el', 'Ελληνικά'], ['de', 'Deutsch'], ['fr', 'Français'], ['es', 'Español'], ['it', 'Italiano']].map(([c, l]) => `<label class="sd-check"><input type="checkbox" data-lang="${c}" ${cfg.langs.includes(c) ? 'checked' : ''}/> <span>${l}</span></label>`).join('')}
        <label class="sd-check"><input type="checkbox" data-anylang ${cfg.lang === 'any' ? 'checked' : ''}/> <span>Any language</span></label></div></div>
      ${section('text')}
      ${section('image')}
      <p class="sd-note" id="ai-storage"></p>
    </div><div class="sd-foot"><span class="grow">Downloads continue in the background; you can close this.</span><button type="button" class="btn primary" data-act="home">Done</button></div>`;
  }
  function render() {
    if (!dlg) return;
    const box = $('.sd', dlg);
    box.innerHTML = { home: viewHome, ask: viewAsk, run: viewRun, result: viewResult, error: viewError, models: viewModels }[st.view]();
    if (st.view === 'models') {
      updateLive();
      navigator.storage?.estimate?.().then((e) => { const el = $('#ai-storage', dlg); if (el && e?.quota) el.textContent = `This browser is using ${fmtMB(e.usage / 1e6)} of the ${fmtMB(e.quota / 1e6)} it allows PaperDesk.`; }).catch(() => {});
    }
    if (st.view === 'result') st.result.mount?.(box);
  }

  async function onClick(e) {
    const t = e.target.closest('[data-act],[data-kind],[data-res],[data-use],[data-del],[data-off]');
    if (!t) return;
    if (t.dataset.kind) { st.kind = t.dataset.kind; $$('[data-kind]', dlg).forEach((b) => b.setAttribute('aria-pressed', b.dataset.kind === st.kind)); return; }
    if (t.dataset.res) { const a = st.result?.actions?.[+t.dataset.res]; if (a) { const keep = await a.run(); if (!keep) dlg.close(); } return; }
    if (t.dataset.use) { const [kind, id] = t.dataset.use.split(':'); cfg[kind] = id; saveCfg(); render(); download(kind); return; }
    if (t.dataset.del) {
      const [kind, id] = t.dataset.del.split(':'), m = KINDS[kind].find((x) => x.id === id);
      if (!(await A.confirmDialog(`Delete ${m.name} from this device?`, `This frees about ${fmtMB(m.mb)}. You can download it again later.`, 'Delete', true))) return open({ view: 'models' });
      try { await deleteModel(kind, m); toast(`${m.name} deleted from this device`); } catch (err) { toast(err.message); }
      return open({ view: 'models' });
    }
    if (t.dataset.off) { cfg[t.dataset.off] = ''; saveCfg(); render(); return; }
    switch (t.dataset.act) {
      case 'close': if (!st.busy) dlg.close(); break;
      case 'home': st.view = 'home'; st.notice = ''; render(); break;
      case 'models': st.view = 'models'; render(); refreshInstalled().then(() => { if (st.view === 'models') render(); }); break;
      case 'create': create(); break;
      case 'stop': st.stop = true; break;
      case 'retry': if (st.lastTask) run(st.lastTask); break;
      case 'desk-summary': deskSummary(); break;
      case 'desk-tasks': deskTasks(); break;
      case 'desk-dates': deskDates(); break;
      case 'ask': st.view = 'ask'; render(); setTimeout(() => $('#ai-ask', dlg)?.focus(), 20); break;
      case 'ask-go': askDesk(); break;
      case 'dictate': dlg.close(); dictate(); break;
      default: break;
    }
  }
  function onInput(e) {
    if (e.target.id === 'ai-q') st.prompt = e.target.value;
    if (e.target.id === 'ai-ask') st.question = e.target.value;
  }
  function onChange(e) {
    const el = e.target;
    if (el.dataset.lang) { const set = new Set(cfg.langs); el.checked ? set.add(el.dataset.lang) : set.delete(el.dataset.lang); cfg.langs = [...set]; if (!cfg.langs.length) cfg.langs = ['en']; saveCfg(); }
    if (el.dataset.anylang !== undefined) { cfg.lang = el.checked ? 'any' : 'auto'; saveCfg(); }
  }
  async function download(kind) {
    try {
      if (kind === 'speech') await ensureSpeech(); else if (kind === 'text') await ensureText(); else await ensureImage();
      toast(`${modelOf(kind)?.name || 'Model'} is ready on this device`);
    } catch (e) { st.notice = e.message; if (!(dlg?.open && st.view === 'models')) toast(`Download failed: ${e.message}`); }
    if (dlg?.open && st.view === 'models') render();
  }

  /** Runs a task in the panel: shows progress and streaming text, then the result view. */
  async function run(task) {
    if (!dlg) mount();
    if (st.busy) { toast('AI is busy with another request'); return; }
    Object.assign(st, { busy: true, stop: false, title: task.title, out: '', phase: task.phase || '', view: 'run', lastTask: task });
    render(); if (!dlg.open) dlg.showModal();
    try {
      const res = await task.exec({ onText: (t) => { st.out = t; const el = $('#ai-stream', dlg); if (el) { el.textContent = t; el.scrollTop = el.scrollHeight; } }, phase: (p) => { st.phase = p; updateLive(); } });
      st.busy = false;
      if (!res) { dlg.close(); return; }
      st.result = res; st.view = 'result';
    } catch (e) {
      st.busy = false;
      if (e.name === 'AbortError') { st.view = 'home'; }
      else if (e.name === 'NeedSetup') { st.notice = `${e.message} Choose a model below; it downloads once and then works offline.`; st.view = 'models'; refreshInstalled().then(() => { if (st.view === 'models') render(); }); }
      else { st.error = e.message || String(e); st.view = 'error'; }
    }
    render();
  }

  /* ------------------------------------------------------------ placing results */
  function placeNear(src) {
    if (src) return { x: src.x + src.w + 36, y: src.y };
    if (st.at) { const p = st.at; st.at = null; return { x: Math.round(p.x - 140), y: Math.round(p.y - 90) }; }
    return {};
  }
  const aiMeta = (extra = {}) => ({ ai: { model: modelOf('text')?.name || '', at: Date.now(), ...extra } });
  function addText(title, body, src) {
    const lines = body.split('\n').reduce((s, l) => s + Math.max(1, Math.ceil(l.length / 38)), 0);
    return A.addNote({ type: 'text', title, body, w: 300, h: Math.max(150, Math.min(440, 96 + lines * 19)), meta: aiMeta(), ...placeNear(src) });
  }
  function addChecklist(title, tasks, src) {
    return A.addNote({ type: 'checklist', title, tasks: tasks.map((t) => ({ title: String(t).replace(/^\s*[-*•\d.)\]]+\s*(\[.\]\s*)?/, '').trim(), done: false })).filter((t) => t.title), w: 290, h: Math.max(170, Math.min(560, 104 + tasks.length * 27)), meta: aiMeta(), ...placeNear(src) });
  }
  function addChart(spec, src, body = '') {
    const c = R.normalizeChart(spec);
    return A.addNote({ type: 'chart', title: c.title || 'Chart', body, w: 360, h: 270, meta: { chart: c, ...aiMeta() }, ...placeNear(src) });
  }
  function addSketch(title, sk, src) {
    const w = Math.max(240, Math.min(520, sk.width + 24)), h = Math.max(180, Math.min(460, sk.height + 84));
    return A.addNote({ type: 'sketch', title, body: '', w, h, meta: { sketch: { strokes: sk.strokes, w: sk.width, h: sk.height }, ...aiMeta() }, ...placeNear(src) });
  }
  function drawOnPaper(sk) {
    const b = activeBoard(); if (b.isGroup) { toast('Open a desk to draw on its paper'); return; }
    const c = A.viewCenter(), ox = c.x - sk.width / 2, oy = c.y - sk.height / 2;
    pushUndo();
    (b.strokes = b.strokes || []).push(...sk.strokes.map((s) => ({ ...s, points: s.points.map(([x, y]) => [Math.round((x + ox) * 10) / 10, Math.round((y + oy) * 10) / 10]), ...(s.kind === 'text' ? { x: Math.round((s.x + ox) * 10) / 10, y: Math.round((s.y + oy) * 10) / 10 } : {}) })));
    renderAll(); save(); toast('Drawn on the paper · the eraser and Undo work on it', true);
  }
  const sketchSvg = (sk, cls = 'ai-sketch') => `<svg class="${cls}" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sk.w || sk.width} ${sk.h || sk.height}" preserveAspectRatio="xMidYMid meet">${A.inkLayer(sk.strokes)}</svg>`;
  const textArea = (v) => `<textarea class="field ai-out" id="ai-out" rows="10">${esc(v)}</textarea>`;
  const outVal = () => $('#ai-out', dlg)?.value ?? st.out;
  async function copy(text) { try { await navigator.clipboard.writeText(text); toast('Copied'); } catch { toast('The browser blocked copying'); } return true; }

  /* ------------------------------------------------------------ create from a prompt */
  function guessKind(q) {
    const s = q.toLowerCase();
    if (/\b3d\b|\b3-d\b|three[- ]dimensional|τρισδιάστατ|\bglb\b/.test(s)) return 'model3d';
    if (/\b(picture|image|photo|photograph|illustration|painting|portrait|wallpaper|logo)\b|εικόνα|φωτογραφ|ζωγραφι|πίνακα ζωγραφικής/.test(s)) return 'image';
    if (/\b(chart|graph|plot|histogram|pie)\b|γράφημα|ραβδόγραμμα|πίτα/.test(s)) return 'chart';
    if (/\b(flow ?chart|diagram|mind ?map|workflow|org chart|hierarchy|process map|decision tree)\b|διάγραμμα|νοητικό χάρτη|ροή εργασ/.test(s)) return 'diagram';
    if (/\b(sketch|draw|doodle)\b|σκίτσο|σχέδιο|σχεδίασε|ζωγράφισε/.test(s)) return 'drawing';
    if (/\b(remind|reminder|appointment|meeting)\b|υπενθύμ|ραντεβού|συνάντηση/.test(s)) return 'reminder';
    if (/\b(list|checklist|to-?dos?|tasks|steps|packing|shopping|plan)\b|λίστα|εργασίες|βήματα|ψώνια|σχέδιο δράσης/.test(s)) return 'checklist';
    return '';
  }
  function create() {
    const q = (st.prompt || $('#ai-q', dlg)?.value || '').trim();
    if (!q) { $('#ai-q', dlg)?.focus(); return; }
    const at = st.at;
    run({
      title: 'Creating…',
      exec: async (io) => {
        let kind = st.kind === 'auto' ? guessKind(q) : st.kind;
        if (!kind) { io.phase('Working out what to make'); kind = (await chatJSON(msgs(`What should be made for this request? "note" for writing, "checklist" for lists and plans, "chart" for numbers, "diagram" for processes and relationships, "drawing" for a simple sketch, "image" for a picture, "model3d" for a 3D object, "reminder" for dates and appointments.\n\nRequest: ${q}`), SCHEMA.kind, { maxTokens: 20, temperature: 0 })).kind || 'note'; }
        st.at = at;
        return makers[kind] ? makers[kind](q, io) : makers.note(q, io);
      },
    });
  }
  const makers = {
    async note(q, io) {
      io.phase('Writing');
      const j = await chatJSON(msgs(`Write a note for this request. Give it a short title. The body can use short paragraphs or "- " bullet lines.\n\nRequest: ${q}`), SCHEMA.note, { onText: io.onText, maxTokens: 800 });
      return textResult(String(j.title || 'Note'), String(j.body || ''), null, 'new');
    },
    async checklist(q, io) {
      io.phase('Making the list');
      const j = await chatJSON(msgs(`Make a checklist for this request: a short title and 3 to 20 concrete tasks, each a few words, in a sensible order. Every task must be different.\n\nRequest: ${q}`), SCHEMA.checklist, { penalty: 0.5, onText: io.onText, maxTokens: 700 });
      return checklistResult(String(j.title || 'Checklist'), (j.tasks || []).map(String), null);
    },
    async chart(q, io) {
      io.phase('Making the chart');
      const j = await chatJSON(msgs(`${P.chart}\n\nRequest: ${q}`), SCHEMA.chart, { onText: io.onText, maxTokens: 700, temperature: 0.2 });
      return chartResult(j, null);
    },
    async diagram(q, io) {
      io.phase('Drawing the diagram');
      const j = await chatJSON(msgs(`${P.diagram}\n\nRequest: ${q}`), SCHEMA.diagram, { onText: io.onText, maxTokens: 900, temperature: 0.3 });
      return sketchResult(String(j.title || 'Diagram'), R.sketchToStrokes(j), null);
    },
    async drawing(q, io) {
      io.phase('Drawing');
      const j = await chatJSON(msgs(`${P.drawing}\n\nDraw: ${q}`), SCHEMA.drawing, { penalty: 0.3, onText: io.onText, maxTokens: 700, temperature: 0.4 });
      return sketchResult(String(j.title || 'Drawing'), R.sketchToStrokes({ shapes: j.shapes }, { width: 300, height: 220 }), null);
    },
    async image(q, io) { return imageResult(q, io); },
    async model3d(q, io, { freeform = false } = {}) {
      // Common objects come from ready-made shapes (instant); anything else is designed by the language model.
      const tpl = freeform ? null : R.sceneTemplate(q);
      if (tpl) return sceneResult(tpl, q, { template: true });
      io.phase('Designing the 3D model');
      const j = await chatJSON(msgs(`${P.scene}\n\nModel: ${q}`), SCHEMA.scene, { penalty: 0.3, onText: io.onText, maxTokens: 900, temperature: 0.3 });
      return sceneResult(R.normalizeScene(j), q);
    },
    async reminder(q, io) {
      io.phase('Finding dates');
      const j = await chatJSON(msgs(`${P.dates()}\n\nText: ${q}`), SCHEMA.dates, { onText: io.onText, maxTokens: 500, temperature: 0 });
      return datesResult(j.items || [], null);
    },
  };

  /* ------------------------------------------------------------ result builders */
  function textResult(title, body, src, mode) {
    const n = src, onNote = n && (mode === 'replace' || mode === 'append');
    // Secondary actions first; the primary one sits last (rightmost).
    const acts = [{ label: 'Copy', run: () => copy(outVal()) }, { label: 'Add as a new note', primary: !onNote, run: () => { addText(title, outVal(), n); toast('Note added', true); } }];
    if (onNote && mode === 'replace') acts.push({ label: 'Replace the note text', primary: true, run: () => { pushUndo(); n.body = outVal(); n.meta = { ...(n.meta || {}), ...aiMeta() }; renderAll(); save(); toast('Note updated', true); } });
    if (onNote && mode === 'append') acts.push({ label: 'Add to the note', primary: true, run: () => { pushUndo(); n.body = (n.body ? n.body.replace(/\s*$/, '') + '\n\n' : '') + outVal(); renderAll(); save(); toast('Added to the note', true); } });
    return { title, html: textArea(body), actions: acts };
  }
  function checklistResult(title, tasks, src) {
    const seen = new Set();
    tasks = tasks.map((t) => String(t).trim()).filter((t) => { const k = t.toLowerCase(); if (!t || seen.has(k)) return false; seen.add(k); return true; });
    const acts = [{ label: 'Copy', run: () => copy(tasks.map((t) => `- [ ] ${t}`).join('\n')) }];
    if (src?.type === 'checklist') acts.push({ label: 'Add to this checklist', run: () => { pushUndo(); src.tasks.push(...tasks.map((t) => ({ title: t, done: false }))); renderAll(); save(); toast(`${tasks.length} tasks added`, true); } });
    acts.push({ label: 'Add checklist', primary: true, run: () => { addChecklist(title, tasks, src); toast('Checklist added', true); } });
    return { title, html: `<ul class="ai-tasks">${tasks.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>${tasks.length ? '' : '<p class="sd-note">No tasks found.</p>'}`, actions: acts };
  }
  function chartResult(spec, src) {
    const c = R.normalizeChart(spec);
    if (!c.series.length) throw new Error('The model did not return any numbers for the chart. Try describing the data, e.g. “rent 900, food 400”.');
    return { title: c.title || 'Chart', html: `<div class="ai-chart-big">${R.chartSvg(c, { w: 560, h: 320 })}</div><p class="sd-note">You can change the chart type and the numbers later in Quick Look (Space).</p>`, actions: [{ label: 'Add chart', primary: true, run: () => { addChart(c, src); toast('Chart added', true); } }] };
  }
  function sketchResult(title, sk, src) {
    if (!sk.strokes.length) throw new Error('The model did not draw anything. Try again or describe it differently.');
    return { title, html: `<div class="ai-sketch-big">${sketchSvg({ strokes: sk.strokes, w: sk.width, h: sk.height })}</div>`,
      actions: [{ label: 'Draw on the paper', run: () => drawOnPaper(sk) }, { label: 'Add as a note', primary: true, run: () => { addSketch(title, sk, src); toast('Sketch added', true); } }] };
  }
  function datesResult(items, src) {
    const ok = items.filter((i) => /^\d{4}-\d{2}-\d{2}$/.test(i.date || ''));
    const label = (i) => `${i.kind === 'event' ? 'Event' : 'Reminder'} · ${i.date}${i.time ? ' ' + i.time : ''} · ${i.title}`;
    return {
      title: ok.length ? `${ok.length} date${ok.length === 1 ? '' : 's'} found` : 'No dates found',
      html: ok.length ? `<ul class="ai-tasks">${ok.map((i) => `<li>${esc(label(i))}</li>`).join('')}</ul>` : '<p>No dates or times were found.</p>',
      actions: ok.length ? [{ label: `Create ${ok.length === 1 ? 'it' : 'them'}`, primary: true, run: () => {
        let p = placeNear(src);
        for (const i of ok) {
          const time = /^\d{1,2}:\d{2}$/.test(i.time || '') ? i.time.padStart(5, '0') : '';
          if (i.kind === 'event') A.addNote({ type: 'calendar', title: i.title, body: time ? `At ${time}` : 'All day', w: 260, h: 136, meta: { date: i.date, ...(time ? { time } : {}), ...aiMeta() }, ...p });
          else A.addNote({ type: 'alarm', title: i.title, body: '', w: 276, h: 184, meta: { dateIso: i.date, time24: time || '09:00', armed: true, ...aiMeta() }, ...p });
          if (p.y != null) p = { x: p.x, y: p.y + 200 };
        }
        toast(`${ok.length} added`, true);
      } }] : [],
    };
  }

  /* ------------------------------------------------------------ note actions */
  const TEXT_TASKS = {
    summarize: ['Summary', 'Summarize this note in 1 to 3 short sentences.', 'new'],
    improve: ['Improved', 'Rewrite this note so it is clear and well organised. Keep the meaning, the language and any lists.', 'replace'],
    shorter: ['Shorter', 'Make this note about half as long, keeping the key points and the language.', 'replace'],
    fix: ['Corrected', 'Correct the spelling, grammar and punctuation of this note. Change nothing else.', 'replace'],
    'to-en': ['In English', 'Translate this note into English.', 'replace'],
    'to-el': ['Στα ελληνικά', 'Translate this note into Greek (Ελληνικά).', 'replace'],
    continue: ['Continued', 'Continue writing this note with a few more sentences in the same style and language. Output only the new text.', 'append'],
  };
  function noteItems(n) {
    const hasAudio = (n.type === 'voice' || n.type === 'audio') && (n.meta?.audioDataUrl || n.meta?.dataUrl || /^(data:|blob:)/.test(n.url || ''));
    const textual = !['image', 'model3d', 'sketch'].includes(n.type);
    const items = [];
    if (hasAudio) items.push({ label: n.meta?.transcript ? 'Transcribe again' : 'Transcribe (speech to text)', icon: 'mic', action: () => transcribeNote(n) });
    if (textual) items.push(
      { label: 'Summarize', icon: 'list', action: () => noteText2(n, 'summarize') },
      { label: 'Improve writing', icon: 'sparkle', action: () => noteText2(n, 'improve') },
      { label: 'Make shorter', icon: 'type', action: () => noteText2(n, 'shorter') },
      { label: 'Fix spelling and grammar', icon: 'check', action: () => noteText2(n, 'fix') },
      { label: 'Translate to English', icon: 'globe', action: () => noteText2(n, 'to-en') },
      { label: 'Translate to Greek', icon: 'globe', action: () => noteText2(n, 'to-el') },
      { label: 'Continue writing', icon: 'pen', action: () => noteText2(n, 'continue') },
      { label: 'Suggest a title', icon: 'type', action: () => suggestTitle(n) },
      { label: n.type === 'checklist' ? 'Break tasks into steps' : 'Turn into a checklist', icon: 'checklist', action: () => (n.type === 'checklist' ? breakSteps(n) : toChecklist(n)) },
      { label: 'Find dates → reminders', icon: 'alarm', action: () => noteDates(n) },
      { label: 'Make a chart from this', icon: 'chart', action: () => noteChart(n) },
      { label: 'Draw a diagram of this', icon: 'shapes', action: () => noteDiagram(n) },
    );
    if (n.type === 'image') items.push({ label: 'New variation', icon: 'refresh', action: () => imageVariation(n) });
    if (n.type === 'model3d') items.push({ label: 'Turn in 3D', icon: 'cube', action: () => open3D(n) });
    if (n.type === 'sketch') items.push({ label: 'Draw on the paper', icon: 'pen', action: () => drawOnPaper({ strokes: n.meta.sketch.strokes, width: n.meta.sketch.w, height: n.meta.sketch.h }) });
    items.push({ label: 'AI models and settings…', icon: 'more', action: () => open({ view: 'models' }) });
    return items;
  }
  function noteMenu(n, anchor) { A.showMenu(anchor, [{ lbl: 'AI on this device' }, ...noteItems(n)]); }
  const need = (n) => { const t = noteText(n); if (!t.trim()) { toast('This note has no text to work with'); return null; } return t; };
  function noteText2(n, key) {
    const t = need(n); if (!t) return;
    const [title, instr, mode] = TEXT_TASKS[key];
    const hint = key !== 'to-en';
    run({ title: `${title}…`, phase: 'Writing', exec: async (io) => {
      // Long notes (such as transcripts) go through in parts, so each request stays small.
      const pieces = R.splitText(mode === 'replace' ? (n.body || t) : noteText(n, 60000), 2200);
      let out;
      if (pieces.length === 1) out = R.cleanText(await chat(msgs(`${instr}\n\n---\n${pieces[0]}`, { hint }), { onText: io.onText, maxTokens: 1200 }));
      else if (key === 'summarize') {
        const sums = [];
        for (let i = 0; i < pieces.length; i++) {
          io.phase(`Reading part ${i + 1} of ${pieces.length}`);
          sums.push(R.cleanText(await chat(msgs(`Summarize this part of a longer note in 2 or 3 sentences.\n\n---\n${pieces[i]}`, { hint }), { onText: io.onText, maxTokens: 300 })));
        }
        io.phase('Putting it together');
        out = R.cleanText(await chat(msgs(`${instr}\n\n---\n${sums.join('\n')}`, { hint }), { onText: io.onText, maxTokens: 400 }));
      } else if (key === 'continue') out = R.cleanText(await chat(msgs(`${instr}\n\n---\n${pieces[pieces.length - 1]}`, { hint }), { onText: io.onText, maxTokens: 600 }));
      else {
        const outs = [];
        for (let i = 0; i < pieces.length; i++) {
          io.phase(`Part ${i + 1} of ${pieces.length}`);
          outs.push(R.cleanText(await chat(msgs(`${instr}\n\n---\n${pieces[i]}`, { hint }), { onText: (x) => io.onText([...outs, x].join('\n')), maxTokens: 1200 })));
        }
        out = outs.join('\n');
      }
      return textResult(key === 'summarize' ? `Summary: ${n.title || 'note'}` : title, out, n, mode);
    } });
  }
  function suggestTitle(n) {
    const t = need(n); if (!t) return;
    run({ title: 'Suggesting a title…', exec: async (io) => {
      const out = R.cleanText(await chat(msgs(`Suggest a short title (2 to 6 words) for this note. Output only the title.\n\n---\n${n.body || t}`), { onText: io.onText, maxTokens: 30, temperature: 0.3 })).split('\n')[0].replace(/[.。]$/, '').slice(0, 80);
      if (!out) throw new Error('No title came back. Try again.');
      pushUndo(); n.title = out; renderAll(); save(); toast(`Title: ${out}`, true);
      return null;
    } });
  }
  function toChecklist(n) {
    const t = need(n); if (!t) return;
    run({ title: 'Making a checklist…', phase: 'Finding the tasks', exec: async (io) => {
      const j = await chatJSON(msgs(`Turn this note into a checklist: a short title and the concrete tasks or action items in it (a few words each). If it has none, suggest sensible next steps.\n\n---\n${t}`), SCHEMA.checklist, { penalty: 0.5, onText: io.onText });
      return checklistResult(String(j.title || n.title || 'Checklist'), (j.tasks || []).map(String), n);
    } });
  }
  function breakSteps(n) {
    const open = (n.tasks || []).filter((x) => !x.done);
    if (!open.length) { toast('No open tasks to break down'); return; }
    run({ title: 'Breaking into steps…', phase: 'Planning', exec: async (io) => {
      const j = await chatJSON(msgs(`Break these tasks into small, concrete steps (a few words each), in order. Return all steps as one list.\n\n${open.map((x) => `- ${x.title}`).join('\n')}`), SCHEMA.checklist, { penalty: 0.5, onText: io.onText, maxTokens: 900 });
      const steps = (j.tasks || []).map(String);
      const res = checklistResult(`Steps: ${n.title || 'checklist'}`, steps, n);
      res.actions.splice(1, 0, { label: 'Replace the open tasks', run: () => { pushUndo(); n.tasks = [...n.tasks.filter((x) => x.done), ...steps.map((s) => ({ title: s, done: false }))]; renderAll(); save(); toast('Tasks replaced with steps', true); } });
      return res;
    } });
  }
  function noteDates(n) {
    const t = need(n); if (!t) return;
    run({ title: 'Finding dates…', phase: 'Reading the note', exec: async (io) => datesResult((await chatJSON(msgs(`${P.dates()}\n\nText:\n${t}`), SCHEMA.dates, { onText: io.onText, maxTokens: 500, temperature: 0 })).items || [], n) });
  }
  function noteChart(n) {
    const t = need(n); if (!t) return;
    run({ title: 'Making a chart…', phase: 'Reading the numbers', exec: async (io) => chartResult(await chatJSON(msgs(`${P.chart}\n\nMake the chart from this note:\n${t}`), SCHEMA.chart, { onText: io.onText, temperature: 0.1 }), n) });
  }
  function noteDiagram(n) {
    const t = need(n); if (!t) return;
    run({ title: 'Drawing a diagram…', phase: 'Reading the note', exec: async (io) => {
      const j = await chatJSON(msgs(`${P.diagram}\n\nMake a diagram that shows the structure of this note:\n${t}`), SCHEMA.diagram, { onText: io.onText, maxTokens: 900 });
      return sketchResult(String(j.title || `Diagram: ${n.title || 'note'}`), R.sketchToStrokes(j), n);
    } });
  }
  function scopeNotes() { const sel = A.selectedIds().map(findNote).filter(Boolean); return sel.length > 1 ? sel : (activeBoard().notes || []).slice(); }
  function deskSummary() {
    const t = notesText(scopeNotes()); if (!t) { toast('There are no notes with text here'); return; }
    run({ title: 'Summarizing…', phase: 'Reading the notes', exec: async (io) => {
      const out = R.cleanText(await chat(msgs(`Summarize these notes from a desk as a short overview: up to 6 "- " bullet points, most important first.\n\n${t}`), { onText: io.onText, maxTokens: 700 }));
      return textResult(`Summary: ${activeBoard().title || 'desk'}`, out, null, 'new');
    } });
  }
  function deskTasks() {
    const t = notesText(scopeNotes()); if (!t) { toast('There are no notes with text here'); return; }
    run({ title: 'Collecting tasks…', phase: 'Reading the notes', exec: async (io) => {
      const j = await chatJSON(msgs(`List every open task or action item found in these notes, one short line each, without duplicates. Skip tasks marked [x] (done). Title: "Open tasks".\n\n${t}`), SCHEMA.checklist, { penalty: 0.5, onText: io.onText, maxTokens: 900, temperature: 0.1 });
      return checklistResult(String(j.title || 'Open tasks'), (j.tasks || []).map(String), null);
    } });
  }
  function deskDates() {
    const t = notesText(scopeNotes()); if (!t) { toast('There are no notes with text here'); return; }
    run({ title: 'Finding dates…', phase: 'Reading the notes', exec: async (io) => datesResult((await chatJSON(msgs(`${P.dates()}\n\nText:\n${t}`), SCHEMA.dates, { onText: io.onText, maxTokens: 700, temperature: 0 })).items || [], null) });
  }
  function askDesk() {
    const q = (st.question || '').trim(); if (!q) { $('#ai-ask', dlg)?.focus(); return; }
    const t = notesText(scopeNotes(), 5000);
    run({ title: 'Answering…', phase: 'Reading the notes', exec: async (io) => {
      const out = R.cleanText(await chat(msgs(`Answer the question using only these notes. If the notes do not say, answer that you could not find it.\n\nNotes:\n${t || '(no notes)'}\n\nQuestion: ${q}`), { onText: io.onText, maxTokens: 700 }));
      return textResult(q.slice(0, 60), out, null, 'new');
    } });
  }

  /* ------------------------------------------------------------ pictures */
  async function imagePrompt(q, io) {
    // The picture model reads English; translate other languages when a language model is set up.
    if (!/[^\x00-\x7F]/.test(q) || !modelOf('text')) return q;
    io.phase('Translating the description');
    return R.cleanText(await chat(msgs(`Translate this picture description into English for an image generator. Output only the description.\n\n${q}`, { hint: false }), { maxTokens: 120, temperature: 0 })) || q;
  }
  async function makeImage(prompt, seed, io) {
    await ensureImage();
    io?.phase?.('Painting');
    const r = await eng.image.call('generate', { prompt, ...(seed != null ? { seed } : {}) }, (p) => { if (p.text) io?.phase?.(p.text); }, undefined, 240000);
    const dataUrl = await new Promise((res) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.readAsDataURL(r.blob); });
    return { ...r, dataUrl };
  }
  async function imageResult(q, io) {
    const prompt = await imagePrompt(q, io);
    let img = await makeImage(prompt, null, io);
    const res = {
      title: q.slice(0, 60),
      html: `<figure class="ai-img"><img id="ai-img" src="${img.dataUrl}" alt="${esc(q)}"/><figcaption>${esc(prompt)} · ${(img.ms / 1000).toFixed(1)} s</figcaption></figure>`,
      actions: [
        { label: 'Another one', run: async () => { const b = $('[data-res="0"]', dlg); if (b) { b.disabled = true; b.textContent = 'Painting…'; } try { img = await makeImage(prompt, null); $('#ai-img', dlg).src = img.dataUrl; $('figcaption', dlg).textContent = `${prompt} · ${(img.ms / 1000).toFixed(1)} s`; } catch (e) { toast(e.message); } if (b) { b.disabled = false; b.textContent = 'Another one'; } return true; } },
        { label: 'Add to desk', primary: true, run: () => { A.addNote({ type: 'image', title: q.slice(0, 80), body: q, w: 300, h: 340, meta: { dataUrl: img.dataUrl, dimensions: '512 × 512 px', ai: { model: 'SD-Turbo', prompt, seed: img.seed, at: Date.now() } }, ...placeNear(null) }); toast('Picture added', true); } },
      ],
    };
    return res;
  }
  function imageVariation(n) {
    const prompt = n.meta?.ai?.prompt || n.body || n.title;
    if (!prompt) { toast('This picture has no description'); return; }
    run({ title: 'New variation…', phase: 'Painting', exec: (io) => imageResult(prompt, io) });
  }

  /* ------------------------------------------------------------ 3D */
  let threeP = null;
  const three = () => threeP || (threeP = Promise.all([import('three'), import('three/addons/controls/OrbitControls.js'), import('three/addons/exporters/GLTFExporter.js')])
    .then(([T, O, G]) => ({ T, OrbitControls: O.OrbitControls, GLTFExporter: G.GLTFExporter })).catch((e) => { threeP = null; throw e; }));
  function buildScene(T, spec) {
    const scene = new T.Scene();
    scene.add(new T.HemisphereLight(0xffffff, 0x8a8170, 1.4));
    const sun = new T.DirectionalLight(0xffffff, 2.2); sun.position.set(3, 6, 4); scene.add(sun);
    const group = new T.Group(); group.name = spec.title || 'Model';
    for (const p of spec.parts) {
      let g;
      switch (p.shape) {
        case 'sphere': g = new T.SphereGeometry(0.5, 40, 24); break;
        case 'cylinder': g = new T.CylinderGeometry(0.5, 0.5, 1, 40); break;
        case 'cone': g = new T.ConeGeometry(0.5, 1, 40); break;
        case 'pyramid': g = new T.ConeGeometry(0.7071, 1, 4); g.rotateY(Math.PI / 4); break;
        case 'torus': g = new T.TorusGeometry(0.4, 0.1, 20, 48); break;
        case 'capsule': g = new T.CapsuleGeometry(0.5, 1, 8, 24); g.scale(1, 0.5, 1); break;
        case 'plane': g = new T.BoxGeometry(1, 0.02, 1); break;
        default: g = new T.BoxGeometry(1, 1, 1);
      }
      const mesh = new T.Mesh(g, new T.MeshStandardMaterial({ color: p.color, metalness: p.metal, roughness: p.rough }));
      mesh.name = p.name;
      if (p.shape === 'torus') mesh.scale.set(p.size[0], p.size[1], p.size[2] * 5); else if (p.shape === 'plane') mesh.scale.set(p.size[0], 1, p.size[2]); else mesh.scale.set(p.size[0], p.size[1], p.size[2]);
      mesh.position.set(...p.position);
      mesh.rotation.set(...p.rotation.map((d) => (d * Math.PI) / 180));
      group.add(mesh);
    }
    scene.add(group);
    const box = new T.Box3().setFromObject(group);
    return { scene, group, box };
  }
  function frame(T, camera, box, controls) {
    const size = box.getSize(new T.Vector3()), center = box.getCenter(new T.Vector3()), r = Math.max(size.x, size.y, size.z, 0.1);
    camera.position.set(center.x + r * 1.3, center.y + r * 0.9, center.z + r * 1.6);
    camera.near = r / 100; camera.far = r * 100; camera.updateProjectionMatrix();
    camera.lookAt(center); if (controls) { controls.target.copy(center); controls.update(); }
  }
  async function sceneThumb(spec, w = 480, h = 360) {
    const { T } = await three();
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ren = new T.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true });
    ren.setClearColor(0xF4F1EA);
    const { scene, box } = buildScene(T, spec);
    const cam = new T.PerspectiveCamera(40, w / h); frame(T, cam, box);
    ren.render(scene, cam);
    const url = cv.toDataURL('image/jpeg', 0.88);
    ren.dispose(); ren.forceContextLoss?.();
    return url;
  }
  async function sceneResult(spec, q, { template = false } = {}) {
    if (!spec.parts.length) throw new Error('The model did not return any parts. Try again or describe the object differently.');
    const thumb = await sceneThumb(spec);
    const at = st.at;
    const actions = [{ label: 'Add to desk', primary: true, run: () => { st.at = at; A.addNote({ type: 'model3d', title: spec.title, body: q, w: 300, h: 290, meta: { scene: spec, dataUrl: thumb, ...aiMeta({ prompt: q, template }) }, ...placeNear(null) }); toast('3D model added', true); } }];
    if (template) actions.unshift({ label: 'Design it with AI instead', run: () => { st.at = at; setTimeout(() => run({ title: 'Designing…', exec: (io) => makers.model3d(q, io, { freeform: true }) })); return true; } });
    return {
      title: spec.title,
      html: `<figure class="ai-img"><img src="${thumb}" alt="${esc(spec.title)}"/><figcaption>${spec.parts.length} parts${template ? ' · a ready-made shape in your colours' : ''} · after adding, Quick Look lets you turn it and download a .glb file</figcaption></figure>`,
      actions,
    };
  }
  let viewer = null;
  async function open3D(n) {
    const spec = n.meta?.scene; if (!spec) return;
    let mod; try { mod = await three(); } catch { toast('The 3D viewer could not load. Check the connection and try again.'); return; }
    const { T, OrbitControls, GLTFExporter } = mod;
    viewer?.close();
    const d = document.createElement('dialog'); d.id = 'ai-3d'; d.setAttribute('aria-label', `3D: ${n.title}`);
    d.innerHTML = `<div class="sd"><div class="sd-head"><span class="sd-mono" style="--c:var(--accent)">${icon('cube')}</span><h2>${esc(n.title || '3D model')}</h2><button type="button" class="ib" data-x aria-label="Close">${icon('x')}</button></div>
      <div class="ai-3d-stage"><canvas></canvas></div>
      <div class="sd-foot"><span class="grow">Drag to turn · scroll or pinch to zoom · right-drag to move</span><button type="button" class="btn ghost" data-thumb>Use this view as the picture</button><button type="button" class="btn primary" data-glb>Download .glb</button></div></div>`;
    document.body.appendChild(d); d.showModal();
    const cv = $('canvas', d), stage = $('.ai-3d-stage', d);
    const ren = new T.WebGLRenderer({ canvas: cv, antialias: true, preserveDrawingBuffer: true }); ren.setPixelRatio(Math.min(2, devicePixelRatio)); ren.setClearColor(0xF4F1EA);
    const { scene, group, box } = buildScene(T, R.normalizeScene(spec));
    const grid = new T.GridHelper(Math.max(2, box.getSize(new T.Vector3()).length() * 2), 20, 0xbbb3a3, 0xddd6c8); grid.position.y = Math.min(0, box.min.y); scene.add(grid);
    const cam = new T.PerspectiveCamera(40, 1); const ctl = new OrbitControls(cam, cv); ctl.enableDamping = true;
    frame(T, cam, box, ctl);
    let raf = 0;
    const size = () => { const w = stage.clientWidth, h = stage.clientHeight; ren.setSize(w, h, false); cam.aspect = w / Math.max(1, h); cam.updateProjectionMatrix(); };
    const ro = new ResizeObserver(size); ro.observe(stage); size();
    const loop = () => { ctl.update(); ren.render(scene, cam); raf = requestAnimationFrame(loop); }; loop();
    const close = () => { cancelAnimationFrame(raf); ro.disconnect(); ctl.dispose(); ren.dispose(); ren.forceContextLoss?.(); d.remove(); viewer = null; };
    viewer = { close };
    d.addEventListener('close', close);
    d.addEventListener('click', async (e) => {
      if (e.target === d || e.target.closest('[data-x]')) d.close();
      else if (e.target.closest('[data-glb]')) {
        try { const glb = await new GLTFExporter().parseAsync(group, { binary: true }); const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([glb], { type: 'model/gltf-binary' })); a.download = `${(n.title || 'model').replace(/[\\/:*?"<>|]+/g, ' ').trim()}.glb`; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 4000); }
        catch (err) { toast(`Export failed: ${err.message}`); }
      } else if (e.target.closest('[data-thumb]')) {
        grid.visible = false; ren.render(scene, cam);
        const c2 = document.createElement('canvas'); c2.width = 480; c2.height = 360; const g2 = c2.getContext('2d');
        const sw = cv.width, sh = cv.height, k = Math.max(480 / sw, 360 / sh); g2.drawImage(cv, (480 - sw * k) / 2, (360 - sh * k) / 2, sw * k, sh * k);
        grid.visible = true;
        pushUndo(); n.meta.dataUrl = c2.toDataURL('image/jpeg', 0.88); renderAll(); save(); toast('Picture updated', true);
      }
    });
  }

  /* ------------------------------------------------------------ speech */
  const PLACEHOLDER = /^(Click Rec to record.*|Transcript will appear here\.?|Recording voice memo…|Recorded voice memo \(.*\)|Voice memo recorded on desk.*|)$/s;
  // Whisper sometimes "hears" captions in silence; these never belong in a transcript.
  const HALLUCINATION = /amara\.org|υπότιτλοι|subtitles by|thanks for watching|ευχαριστούμε που παρακολουθήσατε|ευχαριστώ που παρακολουθήσατε|please subscribe|μην ξεχάσετε να κάνετε subscribe/i;
  function cleanSegments(segs) {
    const out = [];
    for (const s of segs) {
      const t = s.t.replace(/\s+/g, ' ').trim();
      if (!t || HALLUCINATION.test(t) || /^[.,!?…\s-]+$/.test(t)) continue;
      if (out.length && out[out.length - 1].t === t) continue;
      out.push({ ...s, t });
    }
    return out;
  }
  async function pickLanguage(audio) {
    if (cfg.lang === 'any') {
      return eng.speech.call('detect', { audio: audio.slice(0, RATE * 30), langs: ['en', 'el', 'de', 'fr', 'es', 'it', 'pt', 'nl', 'ru', 'tr', 'ar', 'zh', 'ja', 'ko', 'pl', 'sv', 'bg', 'ro', 'uk', 'cs', 'hu', 'he', 'hi'] }, null, undefined, 120000).catch(() => cfg.langs[0] || 'en');
    }
    if (cfg.langs.length < 2) return cfg.langs[0] || 'en';
    return eng.speech.call('detect', { audio: audio.slice(0, RATE * 30), langs: cfg.langs }, null, undefined, 120000).catch(() => cfg.langs[0]);
  }
  async function decodeAudio(src) {
    const buf = await (await fetch(src)).arrayBuffer();
    const AC = window.AudioContext || window.webkitAudioContext;
    const ac = new AC(); let ab;
    try { ab = await ac.decodeAudioData(buf.slice(0)); } finally { ac.close?.(); }
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(ab.duration * RATE)), RATE);
    const s = off.createBufferSource(); s.buffer = ab; s.connect(off.destination); s.start();
    return (await off.startRendering()).getChannelData(0);
  }
  const noteEl = (n) => $(`.note[data-id="${n.id}"] .pd-inline-body`);
  function showBody(n) { const el = noteEl(n); if (el && document.activeElement !== el) el.value = n.body; }
  function transcribeNote(n) {
    const src = n.meta?.audioDataUrl || n.meta?.dataUrl || n.url;
    if (!src) { toast('This note has no recording'); return; }
    run({ title: 'Transcribing…', phase: 'Reading the recording', exec: async (io) => {
      const audio = await decodeAudio(src);
      await ensureSpeech();
      io.phase('Recognising the language');
      const lang = await pickLanguage(audio);
      const parts = R.splitAudio(audio, RATE, { maxSec: 28 }), segs = [];
      for (let i = 0; i < parts.length; i++) {
        const [a, b] = parts[i], piece = audio.slice(a, b);
        io.phase(`Transcribing ${i + 1} of ${parts.length} (${R.fmtTime(a / RATE)}–${R.fmtTime(b / RATE)})`);
        if (R.isSilent(piece, RATE)) continue;
        const r = await eng.speech.call('transcribe', { audio: piece, language: lang }, null, [piece.buffer], 180000);
        for (const c of r.chunks) segs.push({ s: a / RATE + c.s, e: c.e != null ? a / RATE + c.e : null, t: c.t });
        io.onText(cleanSegments(segs).map((s) => s.t).join(' '));
        if (st.stop) { st.stop = false; throw Object.assign(new Error('Stopped'), { name: 'AbortError' }); }
      }
      const clean = cleanSegments(segs), text = clean.map((s) => s.t).join(' ');
      if (!text) throw new Error('No speech was found in this recording.');
      return {
        title: `Transcript (${langName(lang)})`,
        html: `${textArea(text)}<p class="sd-note">${clean.length} parts with times: in Quick Look you can tap a sentence to hear it.</p>`,
        actions: [
          { label: 'Copy', run: () => copy(outVal()) },
          { label: 'Use as the note text', primary: true, run: () => { pushUndo(); n.body = outVal(); n.meta = { ...n.meta, transcript: { lang, model: modelOf('speech')?.name, duration: audio.length / RATE, segments: clean, at: Date.now() } }; renderAll(); save(); toast('Transcript added', true); } },
        ],
      };
    } });
  }
  const langName = (c) => ({ en: 'English', el: 'Greek', de: 'German', fr: 'French', es: 'Spanish', it: 'Italian' }[c] || c);

  /** Live transcript while recording (called by the voice recorder). Returns { stop } or null. */
  const live = new Map();
  function startLive(note, stream) {
    if (!modelOf('speech')) {
      if (!cfg.tipShown) { cfg.tipShown = true; saveCfg(); setTimeout(() => toast('Tip: set up speech to text in AI (A) to get a live transcript, all on this device'), 1500); }
      return null;
    }
    const AC = window.AudioContext || window.webkitAudioContext;
    let ac; try { ac = new AC({ sampleRate: RATE }); } catch { ac = new AC(); }
    const rate = ac.sampleRate, src = ac.createMediaStreamSource(stream), proc = ac.createScriptProcessor(4096, 1, 1);
    const base = PLACEHOLDER.test((note.body || '').trim()) ? '' : note.body.replace(/\s*$/, '') + '\n';
    let buf = new Float32Array(0), offset = 0, queue = ensureSpeech().catch((e) => { toast(`Speech model: ${e.message}`); }), lang = null, stopped = false;
    const segs = [];
    const toRate = (x) => { if (rate === RATE) return x; const n = Math.floor((x.length * RATE) / rate), out = new Float32Array(n); for (let i = 0; i < n; i++) { const p = (i * rate) / RATE, j = Math.floor(p), f = p - j; out[i] = x[j] * (1 - f) + (x[j + 1] ?? x[j]) * f; } return out; };
    let pending = 0;
    const commit = (cut) => {
      const piece = toRate(buf.slice(0, cut)); buf = buf.slice(cut);
      const at = offset; offset += piece.length / RATE;
      pending++;
      queue = queue.finally(() => { pending--; }).then(async () => {
        if (!eng.speechKey || R.isSilent(piece, RATE)) return;
        if (!lang) lang = await pickLanguage(piece);
        const r = await eng.speech.call('transcribe', { audio: piece, language: lang }, null, [piece.buffer], 180000);
        segs.push(...r.chunks.map((c) => ({ s: at + c.s, e: c.e != null ? at + c.e : null, t: c.t })));
        const text = cleanSegments(segs).map((s) => s.t).join(' ');
        if (text) { note.body = base + text; showBody(note); }
      }).catch((e) => console.warn('PaperDesk transcription:', e));
    };
    proc.onaudioprocess = (e) => {
      if (stopped) return;
      const d = e.inputBuffer.getChannelData(0), nb = new Float32Array(buf.length + d.length); nb.set(buf); nb.set(d, buf.length); buf = nb;
      // Whisper reads 30 s at a time, so when it falls behind, wait for longer phrases.
      const cut = R.phraseCut(buf, rate, { minSec: pending ? 8 : 3, maxSec: 25 });
      if (cut > 0) commit(cut);
    };
    src.connect(proc); proc.connect(ac.destination);
    const handle = {
      async stop() {
        if (stopped) return; stopped = true;
        try { proc.disconnect(); src.disconnect(); } catch { /* already */ }
        if (buf.length > rate * 0.3) commit(buf.length);
        await queue; ac.close?.();
        live.delete(note.id); renderStatus();
        const clean = cleanSegments(segs);
        if (clean.length) {
          note.body = base + clean.map((s) => s.t).join(' ');
          note.meta = { ...note.meta, transcript: { lang, model: modelOf('speech')?.name, duration: offset, segments: clean, at: Date.now() } };
          if (/^(Voice memo|Dictation) \d/.test(note.title || '') && modelOf('text') && eng.textId) suggestQuietTitle(note);
        }
        renderAll(); save();
      },
    };
    live.set(note.id, handle); renderStatus();
    return handle;
  }
  async function suggestQuietTitle(n) {
    try { const t = R.cleanText(await chat(msgs(`Suggest a short title (2 to 6 words) for this note. Output only the title.\n\n---\n${n.body}`), { maxTokens: 30, temperature: 0.3 })).split('\n')[0].replace(/[.。]$/, '').slice(0, 80); if (t) { n.title = t; renderAll(); save(); } } catch { /* keep the time-based title */ }
  }
  function dictate(at = null) {
    if (!modelOf('speech')) { open({ view: 'models' }); st.notice = 'Dictation needs the speech model, a one-time download. Choose one below (Whisper large-v3 turbo is best for English and Greek).'; render(); return; }
    if (!FX.toggleVoiceRecording) { toast('Recording is not available here'); return; }
    const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const n = A.addNote({ type: 'voice', title: `Dictation ${time}`, body: '', url: `dictation_${Date.now()}.webm`, w: 320, h: 230, meta: { duration: '00:00', elapsed: '00:00' }, ...(at ? { x: Math.round(at.x - 160), y: Math.round(at.y - 110) } : {}) });
    ensureSpeech().catch((e) => toast(`Speech model: ${e.message}`));
    FX.toggleVoiceRecording(n);
  }

  /* ------------------------------------------------------------ charts you make yourself */
  function newChart(at = null) {
    const c = R.normalizeChart({ type: 'bar', title: 'Chart', labels: ['A', 'B', 'C', 'D'], series: [{ name: 'Value', values: [4, 7, 3, 6] }] });
    const n = A.addNote({ type: 'chart', title: 'Chart', body: '', w: 340, h: 250, meta: { chart: c }, ...(at ? { x: Math.round(at.x - 170), y: Math.round(at.y - 125) } : {}) });
    A.openPreview?.(n.id);
    toast('Edit the numbers and the chart type in Quick Look');
  }

  /* ------------------------------------------------------------ rendering note types */
  FX.extendTypeBody?.((n) => {
    const m = n.meta || {};
    if (n.type === 'chart') return `<div class="ai-chartbox">${R.chartSvg(m.chart || {}, { w: Math.max(160, n.w - 24), h: Math.max(90, n.h - 84) })}</div>`;
    if (n.type === 'sketch' && m.sketch) return `<div class="ai-sketchbox">${sketchSvg(m.sketch)}</div>`;
    if (n.type === 'image') return `<div class="thumb clip ai-imgbox">${m.dataUrl ? `<img class="pd-img-thumb" src="${esc(m.dataUrl)}" alt="${esc(n.title)}"/>` : icon('image')}</div><input class="pd-mini-in" data-note-field="body" value="${esc(n.body)}" placeholder="Caption…"/>`;
    if (n.type === 'model3d') return `<div class="thumb clip ai-imgbox">${m.dataUrl ? `<img class="pd-img-thumb" src="${esc(m.dataUrl)}" alt="${esc(n.title)}"/>` : icon('cube')}<button type="button" class="btn ai-3d-btn" data-ai3d>${icon('cube', 's12')}Turn in 3D</button></div>`;
    return null;
  });
  FX.extendViewerStage?.((n, lg, base) => {
    const m = n.meta || {};
    const notes = `<section><div class="sec-h">Notes</div><textarea class="field" data-vf="body" placeholder="Add notes…">${esc(n.body)}</textarea></section>`;
    if (n.type === 'chart') {
      const c = R.normalizeChart(m.chart || {});
      return `<div class="vs ${lg ? 'lg' : ''}" data-ai-chart="${n.id}">
        <div class="ai-chart-big">${R.chartSvg(c, { w: lg ? 760 : 560, h: lg ? 400 : 320 })}</div>
        <section><div class="sec-h">Chart type</div><div class="sd-cats">${R.CHART_TYPES.map((t) => `<button type="button" class="sd-pill" data-ai-ctype="${t}" aria-pressed="${c.type === t}">${{ bar: 'Bars', hbar: 'Horizontal bars', line: 'Line', area: 'Area', pie: 'Pie', doughnut: 'Doughnut' }[t]}</button>`).join('')}</div></section>
        <section><div class="sec-h">Data</div><textarea class="field mono ai-cdata" data-ai-cdata rows="8" spellcheck="false">${esc(R.chartToCSV(c))}</textarea><div class="cap">One row per label; each column after the first is a series. Pie charts use the first series. Paste from a spreadsheet too.</div></section>
        ${notes}</div>`;
    }
    if (n.type === 'sketch' && m.sketch) return `<div class="vs ${lg ? 'lg' : ''}"><div class="ai-sketch-big">${sketchSvg(m.sketch)}</div><div class="sd-choice"><button type="button" class="btn" data-ai-paper="${n.id}">${icon('pen', 's16')}Draw on the paper (to erase or add to it)</button></div>${notes}</div>`;
    if (n.type === 'image') return `<div class="vs ${lg ? 'lg' : ''}"><div class="clipimg" style="padding:8px;background:var(--surface-2)"><img src="${esc(m.dataUrl || '')}" alt="${esc(n.title)}" style="max-width:100%;max-height:${lg ? 620 : 420}px;border-radius:8px;object-fit:contain"/></div><div class="cap">${esc(m.ai ? `Made on this device with ${m.ai.model || 'AI'}: ${m.ai.prompt || ''}` : m.dimensions || '')}</div><div class="sd-choice"><button type="button" class="btn" data-ai-var="${n.id}">${icon('refresh', 's16')}New variation</button><a class="btn" href="${esc(m.dataUrl || '')}" download="${esc((n.title || 'picture').slice(0, 60))}.jpg">${icon('download', 's16')}Download</a></div>${notes}</div>`;
    if (n.type === 'model3d') return `<div class="vs ${lg ? 'lg' : ''}"><div class="clipimg" style="padding:8px;background:var(--surface-2)"><img src="${esc(m.dataUrl || '')}" alt="${esc(n.title)}" style="max-width:100%;max-height:${lg ? 560 : 380}px;border-radius:8px;object-fit:contain"/></div><div class="cap">${m.scene?.parts?.length || 0} parts · ${esc(m.ai?.prompt || '')}</div><div class="sd-choice"><button type="button" class="btn primary" data-ai3d-open="${n.id}">${icon('cube', 's16')}Turn in 3D and download</button></div>${notes}</div>`;
    if ((n.type === 'voice' || n.type === 'audio') && m.transcript?.segments?.length) {
      const segs = m.transcript.segments;
      const sec = `<section class="ai-transcript" data-ai-tr="${n.id}"><div class="sec-h">Transcript with times · ${esc(langName(m.transcript.lang || ''))}${m.transcript.model ? ` · ${esc(m.transcript.model)}` : ''}</div>${segs.map((s) => `<button type="button" data-ai-seek="${s.s}"><span class="mono">${R.fmtTime(s.s)}</span>${esc(s.t)}</button>`).join('')}</section>`;
      const html = base(n, lg);
      return /<\/div>\s*$/.test(html) ? html.replace(/<\/div>\s*$/, `${sec}</div>`) : html + sec;
    }
    return null;
  });

  // Clicks on AI parts of notes and viewers.
  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-ai3d],[data-ai3d-open],[data-ai-ctype],[data-ai-seek],[data-ai-var],[data-ai-paper]');
    if (!t) return;
    if (t.dataset.ai3d !== undefined) { e.stopPropagation(); const n = findNote(t.closest('.note')?.dataset.id); if (n) open3D(n); return; }
    if (t.dataset.ai3dOpen) { const n = findNote(t.dataset.ai3dOpen); if (n) open3D(n); return; }
    if (t.dataset.aiVar) { const n = findNote(t.dataset.aiVar); if (n) { A.closePreview?.(); imageVariation(n); } return; }
    if (t.dataset.aiPaper) { const n = findNote(t.dataset.aiPaper); if (n) { A.closePreview?.(); drawOnPaper({ strokes: n.meta.sketch.strokes, width: n.meta.sketch.w, height: n.meta.sketch.h }); } return; }
    if (t.dataset.aiCtype) {
      const box = t.closest('[data-ai-chart]'), n = box && findNote(box.dataset.aiChart); if (!n) return;
      pushUndo(); n.meta.chart = { ...R.normalizeChart(n.meta.chart), type: t.dataset.aiCtype };
      $$('[data-ai-ctype]', box).forEach((b) => b.setAttribute('aria-pressed', b === t));
      redrawChart(box, n); return;
    }
    if (t.dataset.aiSeek) {
      const n = findNote(t.closest('[data-ai-tr]')?.dataset.aiTr); if (!n || !FX.togglePlayMedia) return;
      const dur = n.meta.transcript.duration || 1;
      FX.togglePlayMedia(n, Math.min(0.999, Number(t.dataset.aiSeek) / dur));
    }
  }, true);
  let chartTimer = 0;
  document.addEventListener('input', (e) => {
    const el = e.target; if (el.dataset?.aiCdata === undefined) return;
    const box = el.closest('[data-ai-chart]'), n = box && findNote(box.dataset.aiChart); if (!n) return;
    clearTimeout(chartTimer);
    chartTimer = setTimeout(() => { pushUndo(`ai-chart-${n.id}`); n.meta.chart = R.chartFromCSV(el.value, R.normalizeChart(n.meta.chart)); redrawChart(box, n); }, 250);
  });
  function redrawChart(box, n) {
    const big = $('.ai-chart-big', box), lg = box.classList.contains('lg');
    if (big) big.innerHTML = R.chartSvg(n.meta.chart, { w: lg ? 760 : 560, h: lg ? 400 : 320 });
    const card = $(`.note[data-id="${n.id}"] .ai-chartbox`); if (card) card.innerHTML = R.chartSvg(n.meta.chart, { w: Math.max(160, n.w - 24), h: Math.max(90, n.h - 84) });
    save();
  }

  /* ------------------------------------------------------------ the AI button */
  function addButton() {
    if ($('#ai-btn')) return;
    const b = document.createElement('button');
    b.className = 'ib'; b.id = 'ai-btn'; b.type = 'button';
    b.setAttribute('aria-label', 'AI on this device (A)'); b.title = 'AI on this device (A)';
    b.innerHTML = icon('sparkle');
    b.addEventListener('click', () => open());
    const sync = $('#sync-btn'); if (sync) sync.parentNode.insertBefore(b, sync);
  }
  addButton();

  window.PaperDeskAI = {
    open, noteMenu, noteItems, dictate, startLive, newChart, open3D, transcribeNote,
    // Standalone SVGs (white background) for sending charts and sketches to other apps.
    chartSvgOf: (n) => (n.meta?.chart ? R.chartSvg(n.meta.chart, { w: 640, h: 400 }).replace('<svg class="ai-chart" ', '<svg ').replace(/(<svg[^>]*>)/, '$1<rect width="100%" height="100%" fill="#ffffff"/>') : ''),
    sketchSvgOf: (n) => { const k = n.meta?.sketch; return k ? `<svg xmlns="http://www.w3.org/2000/svg" width="${k.w}" height="${k.h}" viewBox="0 0 ${k.w} ${k.h}"><rect width="100%" height="100%" fill="#ffffff"/>${A.inkLayer(k.strokes).replace(/ class="hl"/g, '')}</svg>` : ''; },
    state: st, cfg, dev, inst, refreshInstalled, ensureSpeech, ensureText, ensureImage, chat, models: KINDS,
  };
  A.renderAll();
})();

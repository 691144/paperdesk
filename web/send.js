/* PaperDesk "Send to": a guided dialog that sends selected notes (or the whole
   desk) to other apps. It picks the best route each tool allows, from creating
   items directly through the tool's API, to opening the app, email, files to
   import, copy and paste, or a web address for automation and custom tools. */
(function () {
  'use strict';
  const A = window.PaperDeskApp, F = window.PDSendFormats, CAT = window.PDSendCatalog, K = window.PDSendConnectors, Cloud = window.PDCloud;
  if (!A || !F || !CAT || !K) return;
  const { $, $$, esc, icon, toast, findNote, activeBoard, TYPES, B } = A;
  const C = K.C;

  /* ----------------------------------------------------------- storage */
  const ls = {
    get(k, d = null) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  const SAVED = 'pd.send.saved', JOB = 'pd.send.job';
  const saved = () => ls.get(SAVED, []);
  const putSaved = (list) => ls.set(SAVED, list);
  // The default destination: Send (S) goes straight to it. quick = send without the confirm step.
  const DEF = 'pd.send.default';
  const getDefault = () => { const d = ls.get(DEF); const s = d && saved().find((x) => x.id === d.id); return s && destOf(s) && routeOf(s) ? { ...d, s } : null; };
  const setDefault = (id, quick = false) => ls.set(DEF, id ? { id, quick: !!quick } : null);
  const uid = () => 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // Folder handles live in IndexedDB (they cannot be stored as JSON).
  const idb = {
    open() { return new Promise((res, rej) => { const r = indexedDB.open('paperdesk-send', 1); r.onupgradeneeded = () => r.result.createObjectStore('h'); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); },
    async get(k) { const db = await this.open(); return new Promise((res) => { const q = db.transaction('h').objectStore('h').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); },
    async set(k, v) { const db = await this.open(); return new Promise((res) => { const t = db.transaction('h', 'readwrite'); t.objectStore('h').put(v, k); t.oncomplete = res; t.onerror = res; }); },
  };

  /* ------------------------------------------------------------- labels */
  const KIND = {
    direct: { label: 'Automatic', cls: 'auto', what: (d) => `PaperDesk creates them in ${d.name} for you.` },
    scheme: { label: 'Opens the app', what: (d) => `Opens ${d.name} on this device with the note filled in.` },
    email: { label: 'By email', what: () => 'Opens your email app with a ready message.' },
    copy: { label: 'Copy & paste', what: () => 'Copies the notes so you can paste them.' },
    file: { label: 'Import a file', what: () => 'Downloads a file that the app can import.' },
    folder: { label: 'Save into a folder', what: () => 'Writes Markdown files straight into a folder on this computer.' },
    webhook: { label: 'Web address', what: () => 'Posts the notes to a web address (webhook).' },
    share: { label: 'Share sheet', what: () => 'Uses this device\'s Share menu.' },
    urltpl: { label: 'Link', what: () => 'Opens a link you design, with the note filled in.' },
  };
  const COPY_LABEL = { html: 'Copy as formatted text', md: 'Copy as Markdown', text: 'Copy as plain text', lines: 'Copy one line per task', tsv: 'Copy as table rows', opml: 'Copy as OPML outline' };
  const FILE_LABEL = { md: 'Markdown (.md)', mdzip: 'Markdown folder (.zip)', html: 'Web page (.html)', txt: 'Text (.txt)', csv: 'Spreadsheet (.csv)', 'csv-custom': 'CSV with your columns', todoist: 'Todoist template (.csv)', json: 'PaperDesk Send (.json)', enex: 'Evernote format (.enex)', ics: 'Calendar (.ics)', 'ics-events': 'Calendar events (.ics)', opml: 'Outline (.opml)', pdf: 'Print / PDF' };
  const fileLabel = (f) => FILE_LABEL[f] || (f.startsWith('csv:') ? `${F.CSV_PRESETS[f.slice(4)]?.label || ''} CSV` : f);
  const routeTitle = (r, d) => {
    if (r.kind === 'direct') return `Send straight to ${d.name}`;
    if (r.kind === 'copy') return COPY_LABEL[r.flavor] || 'Copy';
    if (r.kind === 'file') return r.format === 'pdf' ? 'Print or save as PDF' : `Download ${fileLabel(r.format)}`;
    if (r.kind === 'email') return r.to ? `Email to ${r.to}` : 'Send by email';
    if (r.kind === 'scheme') return `Open in ${d.name}`;
    if (r.kind === 'folder') return 'Save into a folder';
    if (r.kind === 'webhook') return r.preset && CAT.HOOKS[r.preset] && r.preset !== 'custom' ? `Send through ${CAT.HOOKS[r.preset].name}` : 'Send to a web address';
    if (r.kind === 'share') return 'Share…';
    if (r.kind === 'urltpl') return 'Open a link';
    return r.kind;
  };
  const canShare = () => !!navigator.share;
  const canFolder = () => !!window.showDirectoryPicker;
  const routeAvailable = (r) => (r.kind !== 'share' || canShare()) && (r.kind !== 'folder' || canFolder());

  /* ------------------------------------------------------------- schemes */
  const enc = encodeURIComponent;
  const plainDetails = (it) => [it.text.trim(), ...it.tasks.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.title}`), it.url].filter(Boolean).join('\n');
  const SCHEMES = {
    obsidian: {
      fields: [{ key: 'vault', label: 'Vault name', placeholder: 'Empty = the vault you used last' }, { key: 'folder', label: 'Folder inside the vault', placeholder: 'e.g. Inbox (optional)' }],
      urls: (items, cfg) => items.map((it) => `obsidian://new?${cfg.vault ? `vault=${enc(cfg.vault)}&` : ''}file=${enc((cfg.folder ? cfg.folder.replace(/\/+$/, '') + '/' : '') + F.safeName(it.title))}&content=${enc(F.itemMarkdown(it, { level: 0, frontMatter: true }))}`),
    },
    bear: { urls: (items) => items.map((it) => `bear://x-callback-url/create?title=${enc(it.title)}&text=${enc(F.itemMarkdown(it, { level: 0 }))}${it.tags.length ? `&tags=${enc(it.tags.join(','))}` : ''}`) },
    drafts: { urls: (items) => items.map((it) => `drafts://x-callback-url/create?text=${enc(F.itemMarkdown(it, { level: 1 }))}`) },
    omnifocus: { urls: (items) => items.map((it) => `omnifocus:///add?name=${enc(it.title)}&note=${enc(plainDetails(it))}${it.due ? `&due=${enc(it.due.replace('T', ' '))}` : ''}`) },
    things: {
      urls: (items) => [`things:///add-json?reveal=true&data=${enc(JSON.stringify(items.map((it) => ({ type: 'to-do', attributes: {
        title: it.title, notes: [it.text.trim(), it.url].filter(Boolean).join('\n\n'), ...(it.dueDate ? { deadline: it.dueDate } : {}), ...(it.tags.length ? { tags: it.tags } : {}),
        'checklist-items': it.tasks.map((t) => ({ type: 'checklist-item', attributes: { title: t.title, completed: t.done } })),
      } }))))}`],
    },
    shortcuts: { fields: [{ key: 'shortcut', label: 'Shortcut name', required: true }], urls: (items, cfg) => [`shortcuts://run-shortcut?name=${enc(cfg.shortcut || '')}&input=text&text=${enc(F.toText(items))}`] },
  };

  /* ------------------------------------------------------------- state */
  const st = { open: false, view: 'pick', scope: 'selection', noteId: null, q: '', cat: 'all', dest: null, routeIdx: 0, custom: null, savedId: null, cfg: {}, opts: {}, remember: true, makeDefault: false, pick: {}, items: [], busy: false, result: null, progress: 0, authError: '' };
  let dlg;

  function notesForScope() {
    if (st.scope === 'note') { const n = findNote(st.noteId); return n ? [n] : []; }
    if (st.scope === 'selection') return A.selectedIds().map(findNote).filter(Boolean);
    return (activeBoard().notes || []).slice();
  }
  const deskName = () => activeBoard().title || 'PaperDesk';

  function inkSvgOf(n) {
    const pts = (n.scribbles || []).flatMap((s) => s.points || []);
    if (!pts.length) return '';
    const wmax = Math.max(...n.scribbles.map((s) => s.width || 2.6));
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]), pad = wmax / 2 + 8;
    const x = Math.min(...xs) - pad, y = Math.min(...ys) - pad, w = Math.max(...xs) - Math.min(...xs) + pad * 2, h = Math.max(...ys) - Math.min(...ys) + pad * 2;
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${Math.ceil(w)}" height="${Math.ceil(h)}" viewBox="${x} ${y} ${w} ${h}"><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="#ffffff"/>${A.inkLayer(n.scribbles).replace(/ class="hl"/g, '')}</svg>`;
  }
  async function rasterize(att) {
    try {
      const img = new Image(); img.src = att.dataUrl; await img.decode();
      const scale = Math.min(2, 2000 / Math.max(img.naturalWidth, img.naturalHeight, 1));
      const c = document.createElement('canvas'); c.width = Math.max(1, Math.round(img.naturalWidth * scale)); c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return { ...att, name: att.name.replace(/\.svg$/, '.png'), mime: 'image/png', dataUrl: c.toDataURL('image/png') };
    } catch { return att; }
  }
  async function buildItems() {
    const AI = window.PaperDeskAI;
    const extraSvg = (n) => (n.type === 'chart' ? AI?.chartSvgOf(n) : n.type === 'sketch' ? AI?.sketchSvgOf(n) : '') || '';
    const items = F.buildItems(notesForScope(), { desk: deskName(), types: TYPES, badges: B, inkSvg: inkSvgOf, extraSvg });
    for (const it of items) it.attachments = await Promise.all(it.attachments.map((a) => (a.ink ? rasterize(a) : a)));
    st.items = items;
  }

  /* ------------------------------------------------------------- open */
  // open(scope, noteId, { choose }) — with a default destination set, this goes
  // straight to it (or sends right away); choose: true always shows the list.
  async function open(scope, noteId, { choose = false } = {}) {
    if (!dlg) mount();
    if (st.busy) { if (!dlg.open) { render(); dlg.showModal(); st.open = true; } return; }
    const sel = A.selectedIds();
    st.scope = scope === 'note' ? 'note' : scope === 'desk' ? 'desk' : sel.length ? 'selection' : 'desk';
    st.noteId = noteId || null;
    Object.assign(st, { view: 'pick', q: '', cat: 'all', dest: null, custom: null, savedId: null, cfg: {}, opts: {}, pick: {}, result: null, busy: false, authError: '', makeDefault: false });
    await buildItems();
    const def = !choose && st.items.length ? getDefault() : null;
    if (def) {
      loadSaved(def.s);
      if (def.quick && readyToGo(curRoute())) return quickSend(def.s);
      st.view = 'quick';
    }
    render();
    if (!dlg.open) dlg.showModal();
    st.open = true;
    setTimeout(() => (st.view === 'quick' ? $('[data-act="go-default"]', dlg) : $('#sd-q', dlg))?.focus(), 30);
  }
  function loadSaved(s) {
    if (s.destId === 'custom') Object.assign(st, { custom: { name: s.name, route: s.route, method: s.method }, dest: null, routeIdx: 0 });
    else { const d = CAT.D.find((x) => x.id === s.destId); Object.assign(st, { dest: s.destId, custom: null, routeIdx: Math.min(s.routeIdx || 0, d.routes.length - 1) }); }
    Object.assign(st, { savedId: s.id, cfg: { ...(s.cfg || {}) }, opts: { ...(s.opts || {}) }, pick: {}, authError: '', remember: true, result: null });
  }
  // Send to the default without showing the dialog; it only opens if something needs attention.
  async function quickSend(s) {
    st.view = 'route'; render();
    toast(`Sending ${countLabel(st.items.length)} to ${s.name}…`);
    await go();
    const res = st.result || {};
    const failed = (res.results || []).some((x) => !x.ok && x.code !== 'skipped');
    if (failed || res.seq || res.authFail) { render(); if (!dlg.open) dlg.showModal(); st.open = true; return; }
    toast(res.title === `Sent to ${destOf(s).name}` ? `Sent ${countLabel(st.items.length)} to ${s.name}` : `${res.title} · ${s.name}`);
  }

  function mount() {
    dlg = document.createElement('dialog');
    dlg.id = 'send-dlg';
    dlg.setAttribute('aria-label', 'Send to');
    dlg.innerHTML = '<div class="sd"></div>';
    document.body.appendChild(dlg);
    dlg.addEventListener('click', onClick);
    dlg.addEventListener('input', onInput);
    dlg.addEventListener('change', onChange);
    dlg.addEventListener('close', () => { st.open = false; });
    dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) dlg.close(); });
  }

  /* ------------------------------------------------------------- views */
  const mono = (d, lg = false) => `<span class="sd-mono${lg ? ' lg' : ''}" style="--c:${d.color || '#6B665C'}" aria-hidden="true">${esc(d.mono || '?')}</span>`;
  const head = (title, back) => `<div class="sd-head">${back ? `<button type="button" class="ib back" data-act="${back}" aria-label="Back">${icon('arrow-l')}</button>` : `<span class="sd-mono" style="--c:var(--accent)">${icon('send')}</span>`}<h2>${esc(title)}</h2><button type="button" class="ib" data-act="close" aria-label="Close">${icon('x')}</button></div>`;
  const countLabel = (n) => `${n} note${n === 1 ? '' : 's'}`;

  function scopeBar() {
    const nSel = A.selectedIds().length, nDesk = (activeBoard().notes || []).length;
    const pills = [];
    if (st.noteId) pills.push(`<button type="button" class="sd-pill" data-scope="note" aria-pressed="${st.scope === 'note'}">This note</button>`);
    pills.push(`<button type="button" class="sd-pill" data-scope="selection" aria-pressed="${st.scope === 'selection'}" ${nSel ? '' : 'disabled'}>Selected (${nSel})</button>`);
    pills.push(`<button type="button" class="sd-pill" data-scope="desk" aria-pressed="${st.scope === 'desk'}">Whole desk (${nDesk})</button>`);
    const names = st.items.slice(0, 3).map((i) => esc(i.title)).join(' · ') + (st.items.length > 3 ? ` · +${st.items.length - 3} more` : '');
    return `<div class="sd-scope">${pills.join('')}</div>${st.items.length ? `<details><summary>${countLabel(st.items.length)}: ${names}</summary><div class="sd-preview">${esc(F.toMarkdown(st.items).slice(0, 6000))}</div></details>` : '<p class="sd-warn">There are no notes to send. Select some notes on the desk first.</p>'}`;
  }

  function viewPick() {
    const defId = getDefault()?.id;
    const sv = saved().sort((a, b) => (b.id === defId) - (a.id === defId) || (b.lastUsed || 0) - (a.lastUsed || 0));
    return head(`Send ${countLabel(st.items.length)} to…`) + `<div class="sd-body">
      ${scopeBar()}
      ${sv.length ? `<h3>Your destinations</h3><div class="sd-saved">${sv.map((s) => {
        const d = destOf(s); if (!d) return '';
        const isDef = s.id === defId;
        return `<div class="row${isDef ? ' is-default' : ''}">${mono(d)}<div class="t"><b>${esc(s.name)}${isDef ? ' <span class="sd-badge auto">Default</span>' : ''}</b><small>${esc(routeTitle(routeOf(s), d))}</small></div>
          <button type="button" class="ib sm sd-star" data-act="star" data-id="${s.id}" aria-pressed="${isDef}" aria-label="${isDef ? 'Default destination (press to unset)' : 'Make this the default'}" title="${isDef ? 'Default: Send and S go straight here' : 'Make this the default'}">${icon('star', isDef ? 'fill' : '')}</button>
          <button type="button" class="btn primary" data-act="use-saved" data-id="${s.id}" ${st.items.length ? '' : 'disabled'}>Send</button>
          <button type="button" class="ib sm" data-act="edit-saved" data-id="${s.id}" aria-label="Change ${esc(s.name)}" title="Change">${icon('more')}</button></div>`;
      }).join('')}</div>` : ''}
      <div class="sd-search">${icon('search')}<input id="sd-q" placeholder="Search apps: OneNote, Trello, Notion, email…" value="${esc(st.q)}" autocomplete="off"/></div>
      <div class="sd-cats"><button type="button" class="sd-pill" data-cat="all" aria-pressed="${st.cat === 'all'}">All</button>${CAT.CATS.map(([id, name]) => `<button type="button" class="sd-pill" data-cat="${id}" aria-pressed="${st.cat === id}">${esc(name)}</button>`).join('')}</div>
      <div id="sd-grid">${gridHtml()}</div>
    </div>
    <div class="sd-foot"><span class="grow">Your notes go straight from this device to the app you choose. Saved destinations and tokens stay on this device.</span>
      <button type="button" class="btn ghost" data-act="io">Export / import setups</button></div>`;
  }
  function gridHtml() {
    const q = st.q.trim().toLowerCase();
    const list = CAT.D.filter((d) => (st.cat === 'all' || d.cat === st.cat) && (!q || `${d.name} ${d.blurb} ${d.id}`.toLowerCase().includes(q)) && d.routes.some(routeAvailable));
    const custom = (!q || 'custom own tool webhook api link email csv folder'.includes(q) || 'your own tool'.includes(q));
    const tiles = list.map((d) => `<button type="button" class="sd-tile" data-dest="${d.id}">${mono(d)}<span class="t"><b>${esc(d.name)}</b><small>${esc(d.blurb || '')}</small></span></button>`);
    if (custom && (st.cat === 'all' || st.cat === 'auto')) tiles.push(`<button type="button" class="sd-tile" data-act="custom">${mono({ mono: '+', color: 'var(--accent)' })}<span class="t"><b>Your own tool…</b><small>Webhook, API, link, email or file</small></span></button>`);
    return tiles.length ? `<div class="sd-grid">${tiles.join('')}</div>` : `<p class="sd-note">No app matches “${esc(st.q)}”. Try <b>Your own tool</b>, or a general route: copy, email or a file.</p><div class="sd-grid"><button type="button" class="sd-tile" data-act="custom">${mono({ mono: '+', color: 'var(--accent)' })}<span class="t"><b>Your own tool…</b><small>Webhook, API, link, email or file</small></span></button><button type="button" class="sd-tile" data-dest="anynotes">${mono({ mono: '…' })}<span class="t"><b>Any other app</b><small>Paste, share or import</small></span></button></div>`;
  }

  function destOf(s) { return s.destId === 'custom' ? { id: 'custom', name: s.name, mono: (s.name || '?').slice(0, 2), color: '#4A463F', routes: [s.route] } : CAT.D.find((d) => d.id === s.destId); }
  function routeOf(s) { return s.destId === 'custom' ? s.route : CAT.D.find((d) => d.id === s.destId)?.routes[s.routeIdx || 0]; }
  const curDest = () => st.custom ? { id: 'custom', name: st.custom.name || 'Your tool', mono: (st.custom.name || 'Yo').slice(0, 2), color: '#4A463F', routes: [st.custom.route] } : CAT.D.find((d) => d.id === st.dest);
  const curRoute = () => { const d = curDest(); return d?.routes[st.custom ? 0 : st.routeIdx]; };

  function viewRoute() {
    const d = curDest(), r = curRoute();
    const routes = d.routes.map((x, i) => ({ x, i })).filter(({ x }) => routeAvailable(x));
    const one = routes.length === 1 || st.custom;
    return head(d.name, 'back') + `<div class="sd-body">
      ${scopeBar()}
      ${one ? '' : `<h3>Choose how</h3><div class="sd-routes">${routes.map(({ x, i }) => {
        const k = KIND[x.kind] || { label: x.kind, what: () => '' };
        const conn = x.kind === 'direct' ? C[x.conn] : null;
        return `<button type="button" class="sd-route" data-route="${i}" aria-pressed="${i === st.routeIdx}"><span class="sd-radio"></span><span class="t"><b>${esc(routeTitle(x, d))}</b><span class="sd-badge ${k.cls || ''}">${esc(k.label)}</span>${conn?.beta ? '<span class="sd-badge beta">Beta</span>' : ''}<p>${esc(k.what(d))}</p></span></button>`;
      }).join('')}</div>`}
      <div class="sd-panel">${panelHtml(d, r)}${defaultHtml()}</div>
    </div>
    <div class="sd-foot">${footHtml(d, r)}</div>`;
  }
  const defaultHtml = () => (st.savedId && getDefault()?.id === st.savedId
    ? '<p class="sd-note">This is your default destination: the Send button and S come straight here.</p>'
    : `<label class="sd-check"><input type="checkbox" data-make-default ${st.makeDefault ? 'checked' : ''}/> <span>Make this my default destination (the Send button and S come straight here; Shift+S lets you choose)</span></label>`);

  function viewQuick() {
    const def = getDefault(); if (!def) { st.view = 'pick'; return viewPick(); }
    const s = def.s, d = destOf(s), r = curRoute(), ready = readyToGo(r);
    return head(`Send ${countLabel(st.items.length)}`) + `<div class="sd-body">
      ${scopeBar()}
      <h3>To your default destination</h3>
      <div class="sd-saved"><div class="row is-default">${mono(d)}<div class="t"><b>${esc(s.name)}</b><small>${esc(routeTitle(r, d))}</small></div>
        <button type="button" class="ib sm" data-act="edit-saved" data-id="${s.id}" aria-label="Change ${esc(s.name)}" title="Change settings">${icon('more')}</button></div></div>
      ${ready ? '' : '<p class="sd-warn">This destination needs attention first (sign in, or a missing setting). Press the button to fix it.</p>'}
      <label class="sd-check"><input type="checkbox" data-quick ${def.quick ? 'checked' : ''}/> <span>Next time, send right away without this step (it only opens if something needs attention)</span></label>
    </div>
    <div class="sd-foot"><span class="grow">Shift+S always lets you choose.</span><button type="button" class="btn ghost" data-act="choose">Choose another app</button><button type="button" class="btn primary" data-act="go-default" ${st.items.length && !st.busy ? '' : 'disabled'}>${st.busy ? 'Working…' : ready ? `Send to ${esc(d.name)}` : 'Fix and send'}</button></div>`;
  }

  const stepsHtml = (steps) => (steps?.length ? `<ol class="sd-steps">${steps.map((s) => `<li>${esc(s).replace(/`([^`]+)`/g, '<code>$1</code>')}</li>`).join('')}</ol>` : '');
  function fieldHtml(f, conn) {
    const v = st.cfg[f.key] ?? '';
    const id = `sdf-${f.key}`;
    if (f.type === 'picker') {
      const p = st.pick[f.key] || {};
      const depsOk = (f.deps || []).every((k) => st.cfg[k]) && authOk(conn);
      const opts = p.options || [];
      const hasCur = v && opts.some((o) => o.value === String(v));
      return `<label class="sd-field" for="${id}">${esc(f.label)}<span class="row"><select class="field" id="${id}" data-field="${f.key}" ${depsOk && !p.loading ? '' : 'disabled'}>
        ${f.empty ? `<option value="">${esc(f.empty)}</option>` : `<option value="">${p.loading ? 'Loading…' : depsOk ? 'Choose…' : 'Fill in the fields above first'}</option>`}
        ${!hasCur && v && st.cfg[f.key + 'Label'] ? `<option value="${esc(v)}" selected>${esc(st.cfg[f.key + 'Label'])}</option>` : ''}
        ${opts.map((o) => `<option value="${esc(o.value)}" ${String(v) === o.value ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}</select>
        <button type="button" class="ib" data-act="reload" data-key="${f.key}" title="Reload" aria-label="Reload ${esc(f.label)}" ${depsOk ? '' : 'disabled'}>${icon('refresh')}</button></span>
        ${p.error ? `<span class="sd-err">${esc(p.error)}</span>` : ''}</label>`;
    }
    if (f.type === 'checkbox') return `<label class="sd-check"><input type="checkbox" data-field="${f.key}" ${v ? 'checked' : ''}/> <span>${esc(f.label)}</span></label>`;
    if (f.type === 'textarea') return `<label class="sd-field" for="${id}">${esc(f.label)}<textarea class="field" id="${id}" data-field="${f.key}" rows="${f.rows || 5}" placeholder="${esc(f.placeholder || '')}" spellcheck="false">${esc(v)}</textarea>${f.help ? `<small class="muted">${f.help}</small>` : ''}</label>`;
    if (f.type === 'select') return `<label class="sd-field" for="${id}">${esc(f.label)}<select class="field" id="${id}" data-field="${f.key}">${f.options.map(([val, lab]) => `<option value="${esc(val)}" ${String(v || f.def || '') === val ? 'selected' : ''}>${esc(lab)}</option>`).join('')}</select></label>`;
    const action = f.action ? (() => { const href = f.action.href(st.cfg); return `<a class="btn" ${href ? `href="${esc(href)}" target="_blank" rel="noopener"` : 'aria-disabled="true" style="opacity:.5;pointer-events:none"'}>${esc(f.action.label)}</a>`; })() : '';
    return `<label class="sd-field" for="${id}">${esc(f.label)}${f.required ? '' : ' <small class="muted">(optional)</small>'}<span class="row"><input class="field" id="${id}" data-field="${f.key}" type="${f.type === 'password' ? 'password' : f.type === 'url' ? 'url' : 'text'}" value="${esc(v)}" placeholder="${esc(f.placeholder || '')}" autocomplete="off" spellcheck="false"/>${action}</span>${f.help ? `<small class="muted">${f.help}</small>` : ''}</label>`;
  }
  function optionsHtml(options) {
    return (options || []).map((o) => `<div class="sd-field">${esc(o.label)}<div class="sd-choice">${o.choices.map(([v, l]) => `<button type="button" class="sd-pill" data-opt="${o.key}" data-val="${v}" aria-pressed="${(st.opts[o.key] ?? o.def) === v}">${esc(l)}</button>`).join('')}</div></div>`).join('');
  }

  /* Microsoft / Google connection state */
  function provFor(conn) { return conn?.auth === 'microsoft' || conn?.auth === 'google' ? Cloud?.providers?.[conn.auth] : null; }
  function authOk(conn) {
    if (!conn || (conn.auth !== 'microsoft' && conn.auth !== 'google')) return true;
    const p = provFor(conn); if (!p?.connected || !p.hasScopes?.(conn.scopes)) return false;
    if (conn.auth === 'google') { const t = p.tokens(); return !!(t.access && t.exp > Date.now()); }
    return true;
  }
  function authHtml(conn) {
    if (!conn || (conn.auth !== 'microsoft' && conn.auth !== 'google')) return '';
    const who = conn.auth === 'microsoft' ? 'Microsoft' : 'Google';
    if (!Cloud?.clientId(conn.auth)) return `<div class="sd-err">${who} sign-in is not set up in this copy of PaperDesk. Use another way below.</div>`;
    const p = provFor(conn);
    if (authOk(conn)) return `<div class="sd-auth ok">${icon('check')}<span class="t">Connected${p.account ? ` as <b>${esc(p.account)}</b>` : ''}.</span><button type="button" class="btn ghost" data-act="connect">Use another account</button></div>`;
    const expired = p?.connected && p.hasScopes?.(conn.scopes);
    return `<div class="sd-auth">${icon('users')}<span class="t">${expired ? `${who} asks you to confirm it's you again (Google sign-ins last an hour).` : `Connect your ${who} account to let PaperDesk ${conn.auth === 'google' && conn.scopes[0].endsWith('drive.file') ? 'create documents' : 'add items'} for you. You'll come back here afterwards.`}</span>
      <button type="button" class="btn primary" data-act="connect">${expired ? 'Continue with ' + who : 'Connect ' + who}</button></div>${st.authError ? `<div class="sd-err">${esc(st.authError)}</div>` : ''}`;
  }

  function panelHtml(d, r) {
    const steps = r.steps || [];
    if (r.kind === 'direct') {
      const conn = C[r.conn];
      return `${conn.note ? `<p class="sd-note">${esc(conn.note)}</p>` : ''}${stepsHtml(conn.steps)}${authHtml(conn)}${(conn.fields || []).map((f) => fieldHtml(f, conn)).join('')}${optionsHtml(conn.options)}${rememberHtml()}`;
    }
    if (r.kind === 'scheme') {
      const s = SCHEMES[r.app] || {};
      const big = st.items.some((it) => F.itemMarkdown(it).length > 6000);
      return `${stepsHtml(steps)}${(s.fields || []).map((f) => fieldHtml(f)).join('')}${big ? '<p class="sd-warn">Some notes are long. Very long links may be cut off by the system; for those, use a file or the folder option.</p>' : ''}${(s.fields || []).length ? rememberHtml() : ''}`;
    }
    if (r.kind === 'email') {
      const to = r.to || st.cfg.to || '';
      return `${stepsHtml(steps)}${r.to ? `<p>To: <code>${esc(r.to)}</code></p>` : fieldHtml({ key: 'to', label: 'Send to', type: 'text', placeholder: 'name@example.com', required: !!r.field && d.id !== 'email' })}
        ${r.per === 'item' ? `<p class="sd-note">${st.items.length > 1 ? `Each note is its own email, so you'll press Send ${st.items.length} times in your email app.` : ''}</p>` : optionsHtml([{ key: 'per', label: 'Messages', def: 'all', choices: [['all', 'One email with all notes'], ['item', 'One email per note']] }])}
        ${!r.to && to ? rememberHtml() : ''}`;
    }
    if (r.kind === 'copy') return `${stepsHtml(steps)}<details><summary>What will be copied</summary><div class="sd-preview">${esc(copyText(r.flavor).slice(0, 5000))}</div></details>`;
    if (r.kind === 'file') {
      let extra = '';
      if (r.format === 'csv-custom' || r.format?.startsWith('csv')) extra += optionsHtml([{ key: 'splitTasks', label: 'Checklist items', def: 'no', choices: [['no', 'Inside the note\'s row'], ['yes', 'One row each']] }]);
      if (r.format === 'csv-custom') extra += colsHtml();
      if (r.format === 'json') extra += optionsHtml([{ key: 'attachments', label: 'Pictures and files', def: 'yes', choices: [['yes', 'Include (larger file)'], ['no', 'Leave out']] }]) + formatRefHtml();
      const dated = st.items.filter((i) => i.dueDate).length;
      if (r.format?.startsWith('ics')) extra += dated ? `<p class="sd-note">${dated} of ${countLabel(st.items.length)} ${dated === 1 ? 'has' : 'have'} a date and will be included.</p>` : '<p class="sd-warn">None of these notes has a date. Calendars only take dated notes (reminders and events).</p>';
      return `${stepsHtml(steps.length ? steps : ['The file downloads to this device.'])}${extra}`;
    }
    if (r.kind === 'folder') return `${stepsHtml(steps)}<p class="sd-note">${st.cfg.folderName ? `Folder: <b>${esc(st.cfg.folderName)}</b> · <a href="#" data-act="pick-folder">Choose another</a>` : 'You will choose the folder when you press Save.'}</p>${rememberHtml()}`;
    if (r.kind === 'share') return stepsHtml(steps.length ? steps : ['Pick the app in your device\'s share sheet.']) + optionsHtml(st.items.some((i) => i.attachments.length) ? [{ key: 'files', label: 'Pictures and files', def: 'yes', choices: [['yes', 'Include them'], ['no', 'Text only']] }] : []);
    if (r.kind === 'webhook') {
      const hook = CAT.HOOKS[r.preset || st.cfg.preset || 'custom'] || CAT.HOOKS.custom;
      return `${stepsHtml(r.steps || hook.steps)}${fieldHtml({ key: 'url', label: 'Web address (URL)', type: 'url', required: true, placeholder: 'https://…' })}
        ${r.preset === 'teams' ? '' : optionsHtml([{ key: 'mode', label: 'Requests', def: 'batch', choices: [['batch', 'One request with all notes'], ['each', 'One request per note']] }])}
        ${advancedHookHtml(r)}${formatRefHtml()}${rememberHtml()}`;
    }
    if (r.kind === 'urltpl') return `${fieldHtml({ key: 'template', label: 'Link template', type: 'textarea', rows: 3, placeholder: 'https://mytool.example/new?title={{title|url}}&body={{markdown|url}}', help: 'Use {{fields}} from the list under Format. Add |url inside links.' })}${optionsHtml([{ key: 'per', label: 'Links', def: 'item', choices: [['item', 'One link per note'], ['all', 'One link for all notes']] }])}${linkPreview()}${formatRefHtml()}${rememberHtml()}`;
    return '';
  }
  function linkPreview() {
    if (!st.cfg.template || !st.items.length) return '';
    return `<details open><summary>Link for the first note</summary><div class="sd-preview">${esc(F.renderTemplate(st.cfg.template, st.items[0], st.items))}</div></details>`;
  }
  function advancedHookHtml(r) {
    if (r.preset && r.preset !== 'custom' && !st.custom) return '';
    return `<details ${st.cfg.body === 'template' || st.cfg.headers ? 'open' : ''}><summary>Advanced: method, headers and body</summary><div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
      ${fieldHtml({ key: 'method', label: 'Method', type: 'select', def: 'POST', options: [['POST', 'POST'], ['PUT', 'PUT'], ['PATCH', 'PATCH']] })}
      ${fieldHtml({ key: 'headers', label: 'Extra headers, one per line', type: 'textarea', rows: 2, placeholder: 'Authorization: Bearer your-token' })}
      ${fieldHtml({ key: 'body', label: 'Body', type: 'select', def: 'standard', options: [['standard', 'PaperDesk Send JSON (recommended)'], ['template', 'My own template']] })}
      ${st.cfg.body === 'template' ? fieldHtml({ key: 'template', label: 'Body template (sent once per note)', type: 'textarea', rows: 6, placeholder: '{"name": {{title|json}}, "description": {{markdown|json}}, "due": {{due|json}}}' }) + fieldHtml({ key: 'contentType', label: 'Content type', type: 'select', def: 'application/json', options: [['application/json', 'application/json'], ['application/x-www-form-urlencoded', 'application/x-www-form-urlencoded'], ['text/plain', 'text/plain'], ['text/markdown', 'text/markdown']] }) : ''}
      ${fieldHtml({ key: 'attachments', label: 'Include pictures and files (base64, makes requests larger)', type: 'checkbox' })}
    </div></details>`;
  }
  function formatRefHtml() {
    const sample = st.items[0] ? JSON.parse(F.toJSON([st.items[0]], { desk: deskName(), withAttachments: false })) : null;
    return `<details><summary>Format: the fields PaperDesk sends</summary><p class="sd-note" style="margin-top:8px">Standard body (PaperDesk Send v${F.VERSION}): <code>format</code>, <code>version</code>, <code>exportedAt</code>, <code>source</code> and <code>items[]</code>. Each item has <code>title</code>, <code>text</code>, <code>tasks[]</code> (title, done), <code>due</code>, <code>dueDate</code>, <code>dueTime</code>, <code>tags[]</code>, <code>priority</code>, <code>done</code>, <code>url</code>, <code>location</code>, <code>type</code>, <code>desk</code>, <code>created</code> and <code>attachments[]</code>.<br/>Template fields: ${F.TEMPLATE_FIELDS.map((f) => `<code>{{${f}}}</code>`).join(' ')}. Filters: <code>|url</code> <code>|json</code> <code>|html</code> <code>|upper</code> <code>|lower</code> <code>|trim</code> <code>|first:100</code>.</p>${sample ? `<div class="sd-preview">${esc(JSON.stringify(sample, null, 2))}</div>` : ''}</details>`;
  }
  function colsHtml() {
    const cols = st.cfg.cols || F.CSV_PRESETS.generic.cols.slice(0, 6);
    const fieldOpts = (cur) => Object.entries(F.FIELDS).filter(([k]) => k !== 'parent').map(([k, f]) => `<option value="${k}" ${k === cur ? 'selected' : ''}>${esc(f.label)}</option>`).join('');
    return `<div class="sd-field">Columns<div class="sd-cols">${cols.map(([k, h], i) => `<div class="row"><input class="field" data-col-h="${i}" value="${esc(h)}" aria-label="Column ${i + 1} heading"/><select class="field" data-col-k="${i}" aria-label="Column ${i + 1} content">${fieldOpts(k)}</select><button type="button" class="ib" data-act="col-del" data-i="${i}" aria-label="Remove column">${icon('x')}</button></div>`).join('')}</div>
      <div class="sd-choice"><button type="button" class="btn ghost" data-act="col-add">${icon('plus')}Add column</button>${Object.entries(F.CSV_PRESETS).map(([k, p]) => `<button type="button" class="sd-pill" data-act="col-preset" data-p="${k}">${esc(p.label.split(' (')[0])}</button>`).join('')}</div>
      ${fieldHtml({ key: 'sep', label: 'Separator', type: 'select', def: ',', options: [[',', 'Comma'], [';', 'Semicolon (Excel in many countries)'], ['\t', 'Tab']] })}</div>`;
  }
  const rememberHtml = () => `<label class="sd-check"><input type="checkbox" data-remember ${st.remember ? 'checked' : ''}/> <span>Remember this destination on this device${st.savedId ? ' (updates the saved one)' : ''}</span></label>`;

  function footHtml(d, r) {
    const n = st.items.length;
    const label = {
      direct: `Send ${countLabel(n)}`, scheme: `Open ${d.name}`, email: 'Open email', copy: 'Copy', file: r.format === 'pdf' ? 'Print…' : 'Download',
      folder: 'Save to folder', webhook: `Send ${countLabel(n)}`, share: 'Share…', urltpl: 'Open link',
    }[r.kind] || 'Send';
    const testBtn = r.kind === 'webhook' || (r.kind === 'direct' && C[r.conn]?.auth === 'token') ? `<button type="button" class="btn ghost" data-act="test" ${n && !st.busy ? '' : 'disabled'}>Send a test (first note)</button>` : '';
    const delBtn = st.savedId ? `<button type="button" class="btn ghost danger" data-act="del-saved">Forget</button>` : '';
    return `<span class="grow">${st.busy ? `<span class="sd-progress"><i style="width:${Math.round(st.progress * 100)}%"></i></span>` : esc(KIND[r.kind]?.what(d) || '')}</span>${delBtn}${testBtn}<button type="button" class="btn primary" data-act="go" ${n && !st.busy && readyToGo(r) ? '' : 'disabled'}>${st.busy ? 'Working…' : esc(label)}</button>`;
  }
  function readyToGo(r) {
    if (r.kind === 'direct') {
      const conn = C[r.conn];
      if (!authOk(conn)) return false;
      return (conn.fields || []).every((f) => !f.required || st.cfg[f.key]);
    }
    if (r.kind === 'scheme') return (SCHEMES[r.app]?.fields || []).every((f) => !f.required || st.cfg[f.key]);
    if (r.kind === 'email') return !!(r.to || st.cfg.to || !r.field || curDest()?.id === 'email');
    if (r.kind === 'webhook') return /^https?:\/\//i.test(st.cfg.url || '');
    if (r.kind === 'urltpl') return !!(st.cfg.template || '').trim();
    if (r.kind === 'file' && r.format?.startsWith('ics')) return st.items.some((i) => i.dueDate);
    return true;
  }

  function viewResult() {
    const d = curDest(), r = curRoute(), res = st.result;
    const okN = (res.results || []).filter((x) => x.ok).length, badN = (res.results || []).filter((x) => !x.ok && x.code !== 'skipped').length;
    const alt = d.routes.map((x, i) => ({ x, i })).filter(({ x, i }) => i !== st.routeIdx && routeAvailable(x) && !st.custom);
    const title = res.title || (badN && !okN ? 'Not sent' : 'Done');
    return head(title, 'back') + `<div class="sd-body">
      ${res.message ? `<p>${res.message}</p>` : ''}
      ${res.steps?.length ? `<h3>Next</h3>${stepsHtml(res.steps)}` : ''}
      ${res.seq ? `<div class="sd-results">${res.seq.map((s, i) => `<div class="sd-res"><span class="${s.done ? 'ok' : ''}">${icon(s.done ? 'check' : 'external')}</span><span class="t">${esc(s.title)}</span><button type="button" class="btn ${s.done ? 'ghost' : 'primary'}" data-act="seq" data-i="${i}">${s.done ? 'Open again' : esc(res.seqLabel || 'Open')}</button></div>`).join('')}</div>` : ''}
      ${res.results ? `<div class="sd-results">${res.results.map((x) => `<div class="sd-res"><span class="${x.ok ? 'ok' : 'bad'}">${icon(x.ok ? 'check' : 'alert')}</span><span class="t">${esc(x.title)}${x.note ? ` <small>${esc(x.note)}</small>` : ''}${x.error ? `<small>${esc(x.error)}</small>` : ''}</span>${/^https?:\/\//i.test(x.url || '') ? `<a class="btn ghost" href="${esc(x.url)}" target="_blank" rel="noopener">Open</a>` : ''}</div>`).join('')}</div>` : ''}
      ${res.open ? `<p><a class="btn" href="${esc(res.open.url)}" target="_blank" rel="noopener">${icon('external', 's16')}${esc(res.open.label)}</a></p>` : ''}
      ${res.authFail ? `<p class="sd-warn">The sign-in or token was not accepted. <a href="#" data-act="back">Go back</a> to connect again or fix the token.</p>` : ''}
      ${badN && alt.length ? `<h3>Other ways to get them to ${esc(d.name)}</h3><div class="sd-routes">${alt.map(({ x, i }) => `<button type="button" class="sd-route" data-alt="${i}"><span class="t"><b>${esc(routeTitle(x, d))}</b><span class="sd-badge ${KIND[x.kind]?.cls || ''}">${esc(KIND[x.kind]?.label || '')}</span></span></button>`).join('')}</div>` : ''}
    </div>
    <div class="sd-foot"><span class="grow">${okN ? `${okN} sent` : ''}${okN && badN ? ' · ' : ''}${badN ? `${badN} failed` : ''}</span>${okN && !badN && !(st.savedId && getDefault()?.id === st.savedId) ? '<button type="button" class="btn ghost" data-act="make-default">' + icon('star', 's16') + 'Make this my default</button>' : ''}<button type="button" class="btn ghost" data-act="home">Send somewhere else</button><button type="button" class="btn primary" data-act="close">Done</button></div>`;
  }

  /* ------------------------------------------------------ custom tools */
  const CUSTOM_METHODS = [
    ['webhook', 'Web address (webhook or API)', 'Posts JSON to your tool, an automation, or any API that accepts requests from browsers.'],
    ['urltpl', 'Link or app address', 'Opens a link with the note filled in, e.g. https://tool/new?title=… or myapp://add?…'],
    ['email', 'Email address', 'Many tools create items from emails sent to a special address.'],
    ['file:csv-custom', 'CSV file with your columns', 'For tools that import spreadsheets.'],
    ['file:json', 'JSON file (PaperDesk Send)', 'For your own scripts and importers.'],
    ['file:mdzip', 'Markdown files (.zip)', 'For tools that import a folder of Markdown files.'],
    ['folder', 'Folder on this computer', 'Writes Markdown files into a folder your tool watches (Chrome and Edge).'],
  ].filter(([k]) => k !== 'folder' || canFolder());
  function viewCustom() {
    const c = st.custom;
    return head('Your own tool', 'home') + `<div class="sd-body">
      <p>Describe how your tool accepts new items once. PaperDesk saves it as a destination you can reuse, and you can export the setup for colleagues.</p>
      <label class="sd-field" for="sd-cname">Name<input class="field" id="sd-cname" data-cname value="${esc(c.name || '')}" placeholder="e.g. Team tracker"/></label>
      <h3>How does it accept new items?</h3>
      <div class="sd-methods">${CUSTOM_METHODS.map(([k, t, p]) => `<button type="button" class="sd-route" data-method="${k}" aria-pressed="${c.method === k}"><span class="sd-radio"></span><span class="t"><b>${esc(t)}</b><p>${esc(p)}</p></span></button>`).join('')}</div>
    </div>
    <div class="sd-foot"><span class="grow">Next you'll fill in the details and can send a test.</span><button type="button" class="btn primary" data-act="custom-next" ${c.method && (c.name || '').trim() ? '' : 'disabled'}>Continue</button></div>`;
  }
  function customRoute(method) {
    if (method === 'webhook') return { kind: 'webhook', preset: 'custom' };
    if (method === 'urltpl') return { kind: 'urltpl' };
    if (method === 'email') return { kind: 'email', field: true, per: 'item', steps: ['Enter the address your tool gives for creating items by email.'] };
    if (method === 'folder') return { kind: 'folder', steps: ['Choose the folder your tool reads from.'] };
    return { kind: 'file', format: method.split(':')[1] };
  }

  function viewIO() {
    return head('Export or import setups', 'home') + `<div class="sd-body">
      <p>Move your saved destinations to another device, or share a custom tool setup with colleagues.</p>
      <label class="sd-check"><input type="checkbox" id="sd-io-secrets"/> <span>Include tokens and secrets (only for your own devices)</span></label>
      <div class="sd-choice"><button type="button" class="btn" data-act="io-export">${icon('download', 's16')}Download setups (.json)</button>
      <label class="btn" style="cursor:pointer">${icon('file', 's16')}Import setups…<input type="file" accept="application/json,.json" data-io-import hidden/></label></div>
    </div><div class="sd-foot"><span class="grow">${saved().length} saved</span><button type="button" class="btn primary" data-act="home">Done</button></div>`;
  }

  /* ------------------------------------------------------------- render */
  function render() {
    if (!dlg) return;
    const box = $('.sd', dlg);
    const scroll = $('.sd-body', box)?.scrollTop || 0;
    box.innerHTML = st.view === 'quick' ? viewQuick() : st.view === 'pick' ? viewPick() : st.view === 'route' ? viewRoute() : st.view === 'result' ? viewResult() : st.view === 'custom' ? viewCustom() : viewIO();
    const body = $('.sd-body', box); if (body && st.keepScroll) body.scrollTop = scroll;
    st.keepScroll = false;
    loadPickers();
  }
  const rerender = () => { st.keepScroll = true; render(); };

  function loadPickers() {
    const r = st.view === 'route' && curRoute();
    if (!r || r.kind !== 'direct') return;
    const conn = C[r.conn];
    for (const f of conn.fields || []) {
      if (f.type !== 'picker') continue;
      const ok = (f.deps || []).every((k) => st.cfg[k]) && authOk(conn);
      const sig = JSON.stringify((f.deps || []).map((k) => st.cfg[k])) + (provFor(conn)?.account || '');
      const p = st.pick[f.key];
      if (!ok || (p && p.sig === sig)) continue;
      st.pick[f.key] = { sig, loading: true };
      f.load(st.cfg).then((options) => { st.pick[f.key] = { sig, options }; }).catch((e) => { st.pick[f.key] = { sig, options: [], error: e.message }; }).then(() => { if (st.view === 'route') rerender(); });
    }
  }

  /* ------------------------------------------------------------- events */
  function goRoute(destId, routeIdx = null, s = null) {
    const d = CAT.D.find((x) => x.id === destId);
    st.dest = destId; st.custom = null; st.savedId = s?.id || null;
    st.routeIdx = routeIdx ?? Math.max(0, d.routes.findIndex(routeAvailable));
    st.cfg = { ...(s?.cfg || {}) }; st.opts = { ...(s?.opts || {}) }; st.pick = {}; st.authError = '';
    st.remember = s ? true : st.remember;
    st.view = 'route'; render();
  }
  function useSaved(s, edit) {
    if (s.destId === 'custom') { st.custom = { name: s.name, route: s.route, method: s.method }; st.dest = null; st.routeIdx = 0; st.savedId = s.id; st.cfg = { ...(s.cfg || {}) }; st.opts = { ...(s.opts || {}) }; st.pick = {}; st.view = 'route'; render(); }
    else goRoute(s.destId, s.routeIdx || 0, s);
    if (!edit) { const r = curRoute(); if (readyToGo(r) && !(r.kind === 'direct' && C[r.conn]?.fields?.some((f) => f.type === 'picker'))) go(); }
  }

  async function onClick(e) {
    const t = e.target.closest('[data-act],[data-dest],[data-scope],[data-cat],[data-route],[data-opt],[data-alt],[data-method]');
    if (!t) return;
    const act = t.dataset.act;
    if (t.tagName === 'A' && act) e.preventDefault();
    if (t.dataset.scope) { st.scope = t.dataset.scope; await buildItems(); return rerender(); }
    if (t.dataset.cat) { st.cat = t.dataset.cat; return rerender(); }
    if (t.dataset.dest) return goRoute(t.dataset.dest);
    if (t.dataset.route) { st.routeIdx = Number(t.dataset.route); st.authError = ''; return rerender(); }
    if (t.dataset.alt) { st.routeIdx = Number(t.dataset.alt); st.view = 'route'; return render(); }
    if (t.dataset.opt) { st.opts[t.dataset.opt] = t.dataset.val; return rerender(); }
    if (t.dataset.method) { st.custom.method = t.dataset.method; return rerender(); }
    switch (act) {
      case 'close': dlg.close(); break;
      case 'back': st.view = st.view === 'result' ? 'route' : 'pick'; if (st.custom && st.view === 'pick' && !st.savedId) { st.view = 'custom'; } render(); break;
      case 'home': Object.assign(st, { view: 'pick', dest: null, custom: null, savedId: null, cfg: {}, opts: {}, result: null }); render(); break;
      case 'custom': st.custom = { name: '', method: '' }; st.savedId = null; st.cfg = {}; st.opts = {}; st.view = 'custom'; render(); setTimeout(() => $('#sd-cname', dlg)?.focus(), 20); break;
      case 'custom-next': st.custom.route = customRoute(st.custom.method); st.routeIdx = 0; st.view = 'route'; st.remember = true; render(); break;
      case 'use-saved': { const s = saved().find((x) => x.id === t.dataset.id); if (s) useSaved(s, false); break; }
      case 'edit-saved': { const s = saved().find((x) => x.id === t.dataset.id); if (s) useSaved(s, true); break; }
      case 'choose': Object.assign(st, { view: 'pick', dest: null, custom: null, savedId: null, cfg: {}, opts: {}, pick: {}, result: null }); render(); setTimeout(() => $('#sd-q', dlg)?.focus(), 20); break;
      case 'go-default': if (readyToGo(curRoute())) go(); else { st.view = 'route'; render(); } break;
      case 'star': { const cur = ls.get(DEF); const on = cur?.id !== t.dataset.id; setDefault(on ? t.dataset.id : null, on ? cur?.quick : false); toast(on ? 'Default set: Send and S go straight there' : 'No default destination'); rerender(); break; }
      case 'make-default': { const d = curDest(), r = curRoute(); if (!st.savedId || !saved().some((x) => x.id === st.savedId)) remember(d, r); setDefault(st.savedId, getDefault()?.quick); toast(`Default set: ${saved().find((x) => x.id === st.savedId)?.name || d.name}`); rerender(); break; }
      case 'del-saved': if (ls.get(DEF)?.id === st.savedId) setDefault(null); putSaved(saved().filter((x) => x.id !== st.savedId)); st.savedId = null; toast('Destination forgotten on this device'); Object.assign(st, { view: 'pick' }); render(); break;
      case 'reload': delete st.pick[t.dataset.key]; rerender(); break;
      case 'connect': connect(); break;
      case 'go': go(); break;
      case 'test': go({ test: true }); break;
      case 'seq': openSeq(Number(t.dataset.i)); break;
      case 'pick-folder': st.cfg.folderName = ''; await idb.set(folderKey(), null).catch(() => {}); rerender(); break;
      case 'col-add': st.cfg.cols = [...(st.cfg.cols || F.CSV_PRESETS.generic.cols.slice(0, 6)), ['text', 'Description']]; rerender(); break;
      case 'col-del': st.cfg.cols = (st.cfg.cols || F.CSV_PRESETS.generic.cols.slice(0, 6)).filter((_, i) => i !== Number(t.dataset.i)); rerender(); break;
      case 'col-preset': st.cfg.cols = F.CSV_PRESETS[t.dataset.p].cols.map((c) => [...c]); rerender(); break;
      case 'io': st.view = 'io'; render(); break;
      case 'io-export': exportSetups($('#sd-io-secrets', dlg)?.checked); break;
      default: break;
    }
  }
  const SECRET = /token|secret|key|password|headers/i;
  function onInput(e) {
    const el = e.target;
    if (el.id === 'sd-q') { st.q = el.value; $('#sd-grid', dlg).innerHTML = gridHtml(); return; }
    if (el.dataset.cname !== undefined) { st.custom.name = el.value; const b = $('[data-act="custom-next"]', dlg); if (b) b.disabled = !(st.custom.method && el.value.trim()); return; }
    if (el.dataset.colH !== undefined) { const cols = st.cfg.cols || F.CSV_PRESETS.generic.cols.slice(0, 6).map((c) => [...c]); cols[Number(el.dataset.colH)][1] = el.value; st.cfg.cols = cols; return; }
    if (el.dataset.field && el.type !== 'checkbox' && el.tagName !== 'SELECT') {
      st.cfg[el.dataset.field] = el.value.trim() === '' ? '' : (el.type === 'password' || el.dataset.field === 'template' || el.dataset.field === 'headers' ? el.value : el.value.trim());
      const r = curRoute(); const b = $('[data-act="go"]', dlg); if (b && r) b.disabled = !(st.items.length && !st.busy && readyToGo(r));
    }
  }
  function onChange(e) {
    const el = e.target;
    if (el.dataset.ioImport !== undefined) { importSetups(el.files?.[0]); return; }
    if (el.dataset.remember !== undefined) { st.remember = el.checked; return; }
    if (el.dataset.makeDefault !== undefined) { st.makeDefault = el.checked; return; }
    if (el.dataset.quick !== undefined) { const cur = ls.get(DEF); if (cur) ls.set(DEF, { ...cur, quick: el.checked }); return; }
    if (el.dataset.colK !== undefined) { const cols = st.cfg.cols || F.CSV_PRESETS.generic.cols.slice(0, 6).map((c) => [...c]); const i = Number(el.dataset.colK); cols[i] = [el.value, cols[i][1] === F.FIELDS[cols[i][0]]?.label || !cols[i][1] ? F.FIELDS[el.value].label : cols[i][1]]; st.cfg.cols = cols; rerender(); return; }
    if (!el.dataset.field) return;
    const key = el.dataset.field;
    if (el.type === 'checkbox') st.cfg[key] = el.checked;
    else if (el.tagName === 'SELECT') {
      st.cfg[key] = el.value;
      st.cfg[key + 'Label'] = el.value ? el.options[el.selectedIndex]?.text || '' : '';
      // Clear fields that depend on this one.
      const r = curRoute(); const conn = r?.kind === 'direct' ? C[r.conn] : null;
      for (const f of conn?.fields || []) if ((f.deps || []).includes(key)) { st.cfg[f.key] = ''; st.cfg[f.key + 'Label'] = ''; delete st.pick[f.key]; }
    }
    rerender();
  }

  /* ------------------------------------------------------------- auth */
  function jobSnapshot() { return { scope: st.scope, noteId: st.noteId, ids: st.items.map((i) => i.id), dest: st.dest, custom: st.custom, routeIdx: st.routeIdx, savedId: st.savedId, cfg: st.cfg, opts: st.opts, remember: st.remember }; }
  async function connect() {
    const r = curRoute(); const conn = C[r.conn];
    ls.set(JOB, { ...jobSnapshot(), at: Date.now() });
    try { await Cloud.startSignIn(conn.auth, { scopes: conn.scopes, purpose: 'send' }); }
    catch (e) { st.authError = e.message; rerender(); }
  }
  async function resume(ret) {
    const job = ls.get(JOB); ls.set(JOB, null);
    if (!job || Date.now() - (job.at || 0) > 30 * 60000) { if (ret.ok) toast('Connected. Open Send to again to continue.'); return; }
    if (!dlg) mount();
    Object.assign(st, { scope: job.scope === 'selection' ? 'ids' : job.scope, noteId: job.noteId, dest: job.dest, custom: job.custom, routeIdx: job.routeIdx, savedId: job.savedId, cfg: job.cfg || {}, opts: job.opts || {}, remember: job.remember !== false, pick: {}, result: null, busy: false, view: 'route', authError: ret.ok ? '' : `Sign-in didn't finish: ${ret.error}` });
    // Bring back the same notes that were chosen before the sign-in.
    if (st.scope === 'ids') { A.setSelection(job.ids.filter((id) => findNote(id))); st.scope = 'selection'; }
    await buildItems();
    render(); if (!dlg.open) dlg.showModal();
    if (ret.ok) toast('Connected. Choose where the notes go, then send.');
  }
  window.addEventListener('pd-auth-return', (e) => { if (e.detail?.purpose === 'send') resume(e.detail); });
  if (Cloud?.lastReturn?.purpose === 'send') resume(Cloud.lastReturn);

  /* ------------------------------------------------------------- output helpers */
  function download(name, data, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type });
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  const stamp = () => new Date().toISOString().slice(0, 10);
  const baseName = () => `${F.safeName(deskName())} ${stamp()}`;
  function copyText(flavor, items = st.items) {
    if (flavor === 'md') return F.toMarkdown(items);
    if (flavor === 'lines') return items.flatMap((it) => (it.tasks.length ? it.tasks.filter((t) => !t.done).map((t) => t.title) : [it.title])).join('\n');
    if (flavor === 'tsv') { const cell = (v) => String(v ?? '').replace(/[\t\r\n]+/g, ' ').trim(); return [['Title', 'Details', 'Due', 'Tags', 'Status', 'URL'], ...items.map((it) => [it.title, F.FIELDS.details.get(it), it.due.replace('T', ' '), it.tags.join(', '), it.done ? 'Done' : 'Open', it.url])].map((r) => r.map(cell).join('\t')).join('\n'); }
    if (flavor === 'opml') return F.toOPML(items, { title: deskName() });
    return F.toText(items);
  }
  async function copyOut(flavor) {
    const text = copyText(flavor);
    if (flavor === 'html') {
      const html = F.toHtml(st.items);
      try { await navigator.clipboard.write([new ClipboardItem({ 'text/html': new Blob([html], { type: 'text/html' }), 'text/plain': new Blob([text], { type: 'text/plain' }) })]); return; }
      catch {
        const div = document.createElement('div'); div.contentEditable = 'true'; div.innerHTML = html; Object.assign(div.style, { position: 'fixed', left: '-9999px', top: '0' });
        dlg.appendChild(div); const range = document.createRange(); range.selectNodeContents(div); const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
        const ok = document.execCommand('copy'); sel.removeAllRanges(); div.remove(); if (ok) return;
      }
    }
    try { await navigator.clipboard.writeText(text); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; Object.assign(ta.style, { position: 'fixed', left: '-9999px' }); dlg.appendChild(ta); ta.select();
      const ok = document.execCommand('copy'); ta.remove(); if (!ok) throw new Error('The browser blocked copying. Use a file instead.');
    }
  }
  function fileOut(format) {
    const items = st.items, desk = deskName(), split = st.opts.splitTasks === 'yes';
    switch (format) {
      case 'md': return download(`${baseName()}.md`, F.toMarkdown(items, { heading: desk }), 'text/markdown;charset=utf-8');
      case 'mdzip': return download(`${baseName()}.zip`, new Blob([F.zip(F.markdownBundle(items, { desk }))], { type: 'application/zip' }));
      case 'html': return download(`${baseName()}.html`, F.toHtml(items, { standalone: true, title: desk }), 'text/html;charset=utf-8');
      case 'txt': return download(`${baseName()}.txt`, F.toText(items), 'text/plain;charset=utf-8');
      case 'csv': return download(`${baseName()}.csv`, F.toCSV(items, { splitTasks: split }), 'text/csv;charset=utf-8');
      case 'csv-custom': return download(`${baseName()}.csv`, F.toCSV(items, { cols: st.cfg.cols || F.CSV_PRESETS.generic.cols.slice(0, 6), sep: st.cfg.sep || ',', splitTasks: split }), 'text/csv;charset=utf-8');
      case 'todoist': return download(`${baseName()} (Todoist).csv`, F.toTodoistCSV(items), 'text/csv;charset=utf-8');
      case 'json': return download(`${baseName()}.json`, F.toJSON(items, { desk, withAttachments: st.opts.attachments !== 'no' }), 'application/json');
      case 'enex': return download(`${baseName()}.enex`, F.toENEX(items), 'application/enex+xml');
      case 'ics': return download(`${baseName()}.ics`, F.toICS(items), 'text/calendar;charset=utf-8');
      case 'ics-events': return download(`${baseName()}.ics`, F.toICS(items, { allEvents: true }), 'text/calendar;charset=utf-8');
      case 'opml': return download(`${baseName()}.opml`, F.toOPML(items, { title: desk }), 'text/x-opml;charset=utf-8');
      case 'pdf': {
        const w = window.open('', '_blank');
        if (!w) throw new Error('The browser blocked the print window. Allow pop-ups for PaperDesk, or download the web page and print it.');
        w.document.open(); w.document.write(F.toHtml(items, { standalone: true, title: desk }).replace('</body>', '<script>window.onload=()=>setTimeout(()=>window.print(),300)<\/script></body>')); w.document.close();
        return;
      }
      default:
        if (format.startsWith('csv:')) return download(`${baseName()} (${format.slice(4)}).csv`, F.toCSV(items, { cols: F.CSV_PRESETS[format.slice(4)].cols, splitTasks: split }), 'text/csv;charset=utf-8');
        throw new Error('Unknown format');
    }
  }
  const folderKey = () => `folder:${st.savedId || st.dest || 'custom:' + (st.custom?.name || '')}`;
  async function folderOut() {
    let dir = await idb.get(folderKey()).catch(() => null);
    if (dir && (await dir.queryPermission?.({ mode: 'readwrite' })) !== 'granted' && (await dir.requestPermission?.({ mode: 'readwrite' })) !== 'granted') dir = null;
    if (!dir) { dir = await window.showDirectoryPicker({ id: 'paperdesk-send', mode: 'readwrite' }); await idb.set(folderKey(), dir).catch(() => {}); }
    st.cfg.folderName = dir.name;
    const exists = async (h, name) => { try { await h.getFileHandle(name); return true; } catch { return false; } };
    const write = async (h, name, data) => { const fh = await h.getFileHandle(name, { create: true }); const w = await fh.createWritable(); await w.write(data); await w.close(); };
    const files = F.markdownBundle(st.items, { desk: deskName() }).filter((f) => !f.name.endsWith('(index).md'));
    const out = [];
    for (const f of files) {
      if (f.name.startsWith('attachments/')) { const sub = await dir.getDirectoryHandle('attachments', { create: true }); await write(sub, f.name.slice(12), f.data); continue; }
      let name = f.name, i = 2; while (await exists(dir, name)) name = f.name.replace(/\.md$/, ` ${i++}.md`);
      await write(dir, name, f.data); out.push({ title: name, ok: true });
    }
    return out;
  }

  function seqFor(urls, titles, label) { return { seq: urls.map((u, i) => ({ url: u, title: titles[i] || `Item ${i + 1}`, done: false })), seqLabel: label }; }
  // Links that would run code inside PaperDesk are never opened.
  const unsafeUrl = (u) => /^\s*(javascript|data|vbscript|blob|file):/i.test(String(u || ''));
  function openSeq(i) {
    const s = st.result?.seq?.[i]; if (!s) return;
    if (unsafeUrl(s.url)) { toast('This kind of link is blocked for safety'); return; }
    if (/^https?:/i.test(s.url)) window.open(s.url, '_blank', 'noopener'); else location.href = s.url;
    s.done = true; rerender();
  }

  /* ------------------------------------------------------------- send */
  async function go({ test = false } = {}) {
    const d = curDest(), r = curRoute();
    if (!d || !r || st.busy) return;
    const all = st.items, items = test ? all.slice(0, 1) : all;
    st.busy = true; st.progress = 0; rerender();
    let result = {};
    try {
      if (r.kind === 'direct') {
        const conn = C[r.conn];
        const ctx = { desk: deskName(), opts: Object.fromEntries((conn.options || []).map((o) => [o.key, st.opts[o.key] ?? o.def])), progress: (i, n) => { st.progress = n ? i / n : 1; const bar = $('.sd-progress i', dlg); if (bar) bar.style.width = Math.round(st.progress * 100) + '%'; } };
        const results = await conn.send(items, st.cfg, ctx);
        result = { results, open: results.open, authFail: results.some((x) => x.code === 'auth'), title: results.every((x) => x.ok) ? (test ? 'Test sent' : `Sent to ${d.name}`) : results.some((x) => x.ok) ? 'Partly sent' : 'Not sent' };
      } else if (r.kind === 'webhook') {
        const ctx = { desk: deskName(), progress: () => {} };
        const results = await C.webhook.send(items, { ...st.cfg, preset: r.preset, mode: r.preset === 'teams' ? 'each' : st.opts.mode || 'batch' }, ctx);
        result = { results, title: results.every((x) => x.ok) ? (test ? 'Test sent' : 'Sent') : 'Not sent', message: test && results.every((x) => x.ok) ? 'Check your tool: it should have received one note. Then go back and send all of them.' : '' };
      } else if (r.kind === 'copy') {
        await copyOut(r.flavor);
        result = { title: 'Copied', message: `${countLabel(items.length)} copied to the clipboard.`, steps: r.steps, open: r.open ? { url: r.open, label: `Open ${d.name}` } : null };
      } else if (r.kind === 'file') {
        fileOut(r.format);
        result = { title: r.format === 'pdf' ? 'Print window opened' : 'Downloaded', message: r.format === 'pdf' ? '' : `Your browser saved the file (usually to Downloads).`, steps: r.steps };
      } else if (r.kind === 'folder') {
        const results = await folderOut();
        result = { title: `Saved to ${st.cfg.folderName}`, results, message: 'Pictures and drawings are in the attachments folder next to the notes.' };
      } else if (r.kind === 'email') {
        const to = r.to || st.cfg.to || '';
        const per = r.per === 'item' || st.opts.per === 'item';
        const groups = per ? items.map((it) => [it]) : [items];
        let truncated = false;
        const urls = groups.map((g) => { const m = F.mailtoUrl({ to, subject: g.length > 1 ? `${deskName()}: ${countLabel(g.length)}` : g[0].title, body: F.toText(g) }); truncated = truncated || m.truncated; return m.url; });
        if (truncated) { await copyOut('text').catch(() => {}); }
        if (urls.length === 1) { location.href = urls[0]; result = { title: 'Email opened', message: truncated ? 'The notes were too long for an email link, so the message is shortened. The full text is on the clipboard: paste it into the message.' : 'Check the message in your email app and press Send.' }; }
        else result = { title: 'Send each email', message: 'Your email app opens one message at a time. Press each button, then Send in your email app.' + (truncated ? ' Long notes are shortened; the full text is on the clipboard.' : ''), ...seqFor(urls, groups.map((g) => g[0].title), 'Open email') };
      } else if (r.kind === 'scheme') {
        const s = SCHEMES[r.app];
        const urls = s.urls(items, st.cfg);
        if (urls.length === 1) { location.href = urls[0]; result = { title: `Opening ${d.name}`, message: `If nothing happens, ${d.name} may not be installed on this device. Use another way instead.` }; }
        else result = { title: `Open ${d.name} for each note`, message: 'Browsers only let a page open one app link per click, so press each button in turn.', ...seqFor(urls, items.map((i) => i.title), `Open in ${d.name}`) };
      } else if (r.kind === 'urltpl') {
        const urls = st.opts.per === 'all' ? [F.renderTemplate(st.cfg.template, items[0], items)] : items.map((it) => F.renderTemplate(st.cfg.template, it, items));
        if (urls.some(unsafeUrl)) throw new Error('Links starting with javascript:, data:, blob: or file: are blocked for safety.');
        if (urls.length === 1) { if (/^https?:/i.test(urls[0])) window.open(urls[0], '_blank', 'noopener'); else location.href = urls[0]; result = { title: 'Link opened' }; }
        else result = { title: 'Open each link', ...seqFor(urls, items.map((i) => i.title), 'Open') };
      } else if (r.kind === 'share') {
        const files = st.opts.files !== 'no' ? items.flatMap((it) => it.attachments).map((a) => new File([F.dataUrlBytes(a.dataUrl)], a.name, { type: a.mime })) : [];
        const data = { title: items.length === 1 ? items[0].title : deskName(), text: F.toText(items) };
        if (files.length && navigator.canShare?.({ files })) data.files = files;
        try { await navigator.share(data); result = { title: 'Shared' }; }
        catch (e) { if (e.name === 'AbortError') { st.busy = false; return rerender(); } throw e; }
      }
      const anyOk = !(result.results || []).length || (result.results || []).some((x) => x.ok);
      if (!test && anyOk && ((st.remember && shouldRemember(r)) || st.makeDefault)) remember(d, r);
      if (!test && anyOk && st.makeDefault && st.savedId) { setDefault(st.savedId, getDefault()?.quick); st.makeDefault = false; }
    } catch (e) {
      result = { title: 'Something went wrong', results: [{ title: d.name, ok: false, error: e.message, code: e.code }], authFail: e.code === 'auth' };
    }
    st.busy = false; st.result = result; st.view = 'result'; render();
  }
  function shouldRemember(r) {
    if (st.custom) return true;
    if (r.kind === 'direct' || r.kind === 'webhook' || r.kind === 'folder' || r.kind === 'urltpl') return true;
    if (r.kind === 'scheme') return (SCHEMES[r.app]?.fields || []).length > 0;
    if (r.kind === 'email') return !r.to && !!st.cfg.to;
    return false;
  }
  function savedName(d, r) {
    const bits = Object.entries(st.cfg).filter(([k, v]) => k.endsWith('Label') && v).map(([, v]) => v);
    if (st.custom) return st.custom.name;
    if (bits.length) return `${d.name} · ${bits.join(' / ')}`;
    if (r.kind === 'email' && st.cfg.to) return `${d.name} · ${st.cfg.to}`;
    if (r.kind === 'folder' && st.cfg.folderName) return `${d.name} · ${st.cfg.folderName}`;
    if (r.kind === 'file') return `${d.name} · ${fileLabel(r.format)}`;
    if (r.kind === 'copy') return `${d.name} · ${COPY_LABEL[r.flavor] || 'Copy'}`;
    return d.name;
  }
  function remember(d, r) {
    const list = saved();
    const rec = { id: st.savedId || uid(), destId: st.custom ? 'custom' : d.id, routeIdx: st.routeIdx, name: savedName(d, r), cfg: st.cfg, opts: st.opts, lastUsed: Date.now() };
    if (st.custom) { rec.route = st.custom.route; rec.method = st.custom.method; }
    const i = list.findIndex((x) => x.id === rec.id);
    if (i >= 0) list[i] = rec; else list.push(rec);
    putSaved(list); st.savedId = rec.id;
  }

  function exportSetups(withSecrets) {
    const list = saved().map((s) => ({ ...s, cfg: Object.fromEntries(Object.entries(s.cfg || {}).filter(([k]) => withSecrets || !SECRET.test(k))) }));
    download(`paperdesk-destinations ${stamp()}.json`, JSON.stringify({ format: 'paperdesk-destinations', version: 1, destinations: list }, null, 2), 'application/json');
    toast(withSecrets ? 'Setups downloaded, including tokens. Keep the file private.' : 'Setups downloaded without tokens');
  }
  async function importSetups(file) {
    if (!file) return;
    try {
      const j = JSON.parse(await file.text());
      if (j.format !== 'paperdesk-destinations' || !Array.isArray(j.destinations)) throw new Error('This is not a PaperDesk destinations file.');
      const list = saved(); let n = 0;
      for (const s of j.destinations) {
        if (!s || typeof s !== 'object' || !s.destId || (s.destId !== 'custom' && !CAT.D.some((d) => d.id === s.destId))) continue;
        const rec = { ...s, id: uid(), lastUsed: 0 };
        // Never import a link that would run code.
        if (rec.route && rec.route.kind === 'urltpl' && /^\s*javascript:/i.test(rec.cfg?.template || '')) continue;
        list.push(rec); n++;
      }
      putSaved(list); toast(`${n} destination${n === 1 ? '' : 's'} imported`); st.view = 'pick'; render();
    } catch (e) { toast(e.message || 'Could not read that file'); }
  }

  window.PaperDeskSend = { open, state: st, render, getDefault, setDefault };
})();

/* PaperDesk sync: connects the app to the sync engine and the cloud
   providers, decides when to sync, and draws the Sync dialog. */
(function () {
  'use strict';
  const A = window.PaperDeskApp, Core = window.PDSyncCore, Cloud = window.PDCloud;
  if (!A || !Core || !Cloud) return;
  const { S, $, esc, toast, openDialog, renderAll, renderTopbar, save, findNote } = A;

  const ls = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || 'null'); } catch { return null; } },
    set(k, v) { try { if (v == null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch { /* storage blocked */ } },
  };
  const NAMES = { google: 'Google Drive', microsoft: 'OneDrive' };
  const st = { type: ls.get('pd.sync.provider'), status: 'off', error: '', last: ls.get('pd.sync.last') || 0, engine: null, timer: 0, typingAt: 0, backoff: 0, applying: false, dialog: null };

  const kvFor = (type) => { const pre = `pd.sync.${type}.`; return { get: (k) => ls.get(pre + k), set: (k, v) => ls.set(pre + k, v) }; };
  const provider = () => (st.type ? Cloud.providers[st.type] : null);
  const connected = () => !!provider()?.connected;
  function makeEngine() {
    st.engine = st.type ? new Core.SyncEngine({ provider: Cloud.providers[st.type], kv: kvFor(st.type), getBoards: () => S.boards, applyBoards }) : null;
  }

  /* ---------- applying changes from another device ---------- */
  function captureFocus() {
    const el = document.activeElement;
    const noteEl = el?.closest?.('.note');
    if (!noteEl || !/^(INPUT|TEXTAREA)$/.test(el.tagName)) return null;
    let sel = null;
    if (el.dataset.noteField) sel = `[data-note-field="${el.dataset.noteField}"]`;
    else if (el.dataset.taskEdit != null) sel = `[data-task-edit="${el.dataset.taskEdit}"]`;
    else if (el.classList.contains('edit-title')) sel = '.edit-title';
    else if (el.classList.contains('edit-body')) sel = '.edit-body';
    if (!sel) return null;
    return { id: noteEl.dataset.id, sel, value: el.value, start: el.selectionStart, end: el.selectionEnd, editing: S.editingId === noteEl.dataset.id };
  }
  function restoreFocus(f) {
    if (!f) return;
    const el = document.querySelector(`.note[data-id="${CSS.escape(f.id)}"] ${f.sel}`);
    if (!el) return;
    if (f.editing && el.value !== f.value) el.value = f.value;   // text not yet committed to the note
    el.focus({ preventScroll: true });
    try { el.setSelectionRange(f.start, f.end); } catch { /* not a text field */ }
  }
  function applyBoards(boards) {
    if (!boards.length) return;
    const focus = captureFocus();
    st.applying = true;
    try {
      S.boards = boards;
      S.undo = []; S.redo = [];   // older undo steps would undo the other device's changes
      if (!S.boards.some((b) => b.id === S.activeId) && !String(S.activeId).startsWith('group:')) S.activeId = S.boards[0].id;
      if (S.sel && !findNote(S.sel)) S.sel = null;
      for (const id of [...S.multi]) if (!findNote(id)) S.multi.delete(id);
      if (S.multi.size < 2) S.multi.clear();
      if (S.previewId && !findNote(S.previewId)) S.previewId = null;
      if (S.maxId && !findNote(S.maxId)) S.maxId = null;
      renderAll();
      save();
    } finally { setTimeout(() => { st.applying = false; }, 400); }
    restoreFocus(focus);
  }

  /* ---------- when to sync ---------- */
  function setStatus(status, error = '') {
    st.status = status; st.error = error;
    renderTopbar(); paintButton(); renderDialog();
  }
  const isTyping = () => Date.now() - st.typingAt < 1500;
  function schedule(delay = 2000) {
    clearTimeout(st.timer);
    if (st.engine && connected()) st.timer = setTimeout(run, delay);
  }
  async function run(trigger = 'auto') {
    if (!st.engine || !connected()) return;
    if (!navigator.onLine) { setStatus('offline'); return; }
    if (isTyping() && trigger === 'auto') { schedule(1500); return; }
    setStatus('syncing');
    try {
      const r = await st.engine.sync();
      st.last = Date.now(); ls.set('pd.sync.last', st.last); st.backoff = 0;
      setStatus('ok');
      if (r.conflicts) toast(`Merged changes from another device (${r.conflicts} edited on both — see "Conflict copy" notes)`);
    } catch (e) {
      if (e.code === 'auth') { setStatus('needsAuth', e.message); renewSilently(trigger); return; }
      setStatus(e.code === 'network' ? 'offline' : 'error', e.message || String(e));
      st.backoff = Math.min(Math.max(st.backoff * 2, 15000), 300000);
      schedule(st.backoff);
    }
  }
  /** Renews an expired sign-in without a prompt. It reloads the page, so it only
      runs when the app is opened or switched back to, never while typing. */
  async function renewSilently(trigger) {
    if (trigger !== 'startup' && trigger !== 'resume') return;
    if (S.editingId || isTyping() || document.visibilityState !== 'visible' || !navigator.onLine) return;
    if (Date.now() - (ls.get('pd.auth.silentAt') || 0) < 10 * 60000) return;
    ls.set('pd.auth.silentAt', Date.now());
    await goToSignIn(st.type, true);
  }
  async function goToSignIn(type, silent = false) {
    if (S.editingId) A.commitEdit();
    save();
    await new Promise((r) => setTimeout(r, 350));   // let the local save finish
    await Cloud.startSignIn(type, { silent });
  }

  A.onSaved = () => { if (!st.applying) schedule(2000); };
  document.addEventListener('input', () => { st.typingAt = Date.now(); }, true);
  document.addEventListener('keydown', () => { st.typingAt = Date.now(); }, true);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') setTimeout(() => run('resume'), 300); });
  window.addEventListener('online', () => run('auto'));
  setInterval(() => { if (document.visibilityState === 'visible' && st.status !== 'syncing') run('auto'); }, 45000);

  /* ---------- actions ---------- */
  async function choose(type) {
    if (type === st.type) return;
    clearTimeout(st.timer);
    st.type = type; ls.set('pd.sync.provider', type);
    makeEngine();
    setStatus(type && connected() ? 'idle' : 'off');
    if (type && connected()) run('manual');
  }
  async function disconnect() {
    const type = st.type; if (!type) return;
    clearTimeout(st.timer);
    await Cloud.providers[type].disconnect();
    for (const k of ['base', 'seen', 'uploaded']) kvFor(type).set(k, null);
    makeEngine();
    setStatus('off');
    toast(`Disconnected from ${NAMES[type]}. Your desks stay on this device.`);
  }

  /* ---------- top bar ---------- */
  function label() {
    if (!st.type) return 'This device';
    if (!connected()) return 'Not connected';
    return { syncing: 'Syncing…', offline: 'Offline', needsAuth: 'Reconnect', error: 'Sync issue' }[st.status] || 'Synced';
  }
  function paintButton() {
    const b = $('#sync-btn'); if (!b) return;
    b.dataset.state = !st.type ? 'local' : !connected() ? 'off' : st.status;
    b.title = !st.type ? 'Saved on this device only' : !connected() ? `Connect ${NAMES[st.type]} to sync` : st.error || (st.last ? `Last synced ${A.timeAgo ? A.timeAgo(st.last) : ''}` : 'Sync');
  }
  const css = document.createElement('style');
  css.textContent = `
    #sync-btn[data-state="local"] svg, #sync-btn[data-state="off"] svg { color: var(--ink-3); }
    #sync-btn[data-state="syncing"] svg { color: var(--accent); animation: pd-pulse 1s ease-in-out infinite; }
    #sync-btn[data-state="error"] svg, #sync-btn[data-state="needsAuth"] svg, #sync-btn[data-state="offline"] svg { color: var(--danger); }
    @keyframes pd-pulse { 50% { opacity: .35; } }
    .pd-sync-status { padding: 10px 12px; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line); font-size: 13.5px; line-height: 1.45; }
    .pd-sync-status.bad { border-color: color-mix(in srgb, var(--danger) 40%, var(--line)); }
    .pd-sync-status b { font-weight: 600; }
    .pd-sync-row { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
    .pd-sync-note { font-size: 12.5px; color: var(--ink-3); line-height: 1.45; }
  `;
  document.head.appendChild(css);

  /* ---------- dialog ---------- */
  function statusHtml() {
    const p = provider();
    if (!p) return `<div class="pd-sync-status">Desks are saved in this browser only. Pick Google Drive or OneDrive to use them on your other devices.</div>`;
    const name = NAMES[st.type];
    if (!p.configured) return `<div class="pd-sync-status bad"><b>${name} isn't set up in this copy of PaperDesk.</b><br/>It needs a client ID (see “Use your own client ID” below).</div>`;
    if (!p.connected) return `<div class="pd-sync-status">Connect your ${name} account. You'll approve access once on this device; PaperDesk can only see its own folder.
      <div class="pd-sync-row"><button type="button" class="btn primary" data-act="connect">Connect ${name}</button></div></div>`;
    const who = p.account ? ` as <b>${esc(p.account)}</b>` : '';
    const when = st.last ? `Last synced ${esc(A.timeAgo ? A.timeAgo(st.last) : new Date(st.last).toLocaleString())}.` : 'Not synced yet.';
    const line = {
      syncing: 'Syncing…',
      offline: `Offline. Changes are kept here and sync when you're back online. ${when}`,
      needsAuth: `${name} needs you to sign in again.`,
      error: `Sync problem: ${esc(st.error)} ${when}`,
    }[st.status] || `Up to date. ${when}`;
    const bad = ['offline', 'needsAuth', 'error'].includes(st.status);
    return `<div class="pd-sync-status${bad ? ' bad' : ''}">Connected to <b>${name}</b>${who}.<br/>${line}
      <div class="pd-sync-row">
        ${st.status === 'needsAuth' ? `<button type="button" class="btn primary" data-act="reconnect">Sign in again</button>` : `<button type="button" class="btn primary" data-act="sync" ${st.status === 'syncing' ? 'disabled' : ''}>Sync now</button>`}
        <button type="button" class="btn ghost" data-act="disconnect">Disconnect</button>
      </div></div>`;
  }
  function bodyHtml() {
    const opt = (type, name, hint) => `<label class="provider"><input type="radio" name="pd-prov" value="${type}" ${st.type === (type || null) ? 'checked' : ''}/><span class="grow"><b>${name}</b><small>${hint}</small></span></label>`;
    const ids = ['google', 'microsoft'].map((t) => `<label>${NAMES[t]} client ID<input class="field mono" data-client="${t}" value="${esc(Cloud.clientId(t))}" placeholder="${t === 'google' ? '…apps.googleusercontent.com' : 'Application (client) ID'}"/></label>`).join('');
    return `
      <div class="links">
        ${opt('', 'This device only', 'Saved in this browser')}
        ${opt('google', 'Google Drive', Cloud.providers.google.connected ? 'Connected' : 'Private app folder in your Drive')}
        ${opt('microsoft', 'OneDrive', Cloud.providers.microsoft.connected ? 'Connected' : 'Apps folder in your OneDrive')}
      </div>
      ${statusHtml()}
      <p class="pd-sync-note">Each device keeps its own copy and works offline. Changes merge note by note; if the same note was edited on two devices before they synced, the newer edit wins and the other is kept as a “Conflict copy” note. <a href="privacy.html" target="_blank" rel="noopener">Privacy</a></p>
      <details><summary style="cursor:pointer;font-size:13px;color:var(--ink-3)">Use your own client ID</summary>
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:8px">${ids}
        <p class="pd-sync-note">Only needed if this copy of PaperDesk wasn't set up with one. Redirect address to register: <code>${esc(Cloud.redirectUri())}</code></p>
        <div><button type="button" class="btn" data-act="save-ids">Save client IDs</button></div></div>
      </details>`;
  }
  function renderDialog() {
    const body = st.dialog?.open && st.dialog.querySelector('#pd-sync-body');
    if (body) body.innerHTML = bodyHtml();
  }
  function openSyncDialog() {
    st.dialog = openDialog(`<h2>Sync</h2>
      <p>Use your desks on all your devices. They're stored in your own Google Drive or OneDrive — no PaperDesk account, and no other server sees them.</p>
      <div id="pd-sync-body">${bodyHtml()}</div>
      <div class="actions"><button type="button" class="btn ghost" data-act="backup">Files & backup…</button><button class="btn" value="cancel">Close</button></div>`, (dl) => {
      dl.addEventListener('change', (e) => { if (e.target.name === 'pd-prov') choose(e.target.value || null).then(renderDialog); });
      dl.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-act]'); if (!b) return;
        const act = b.dataset.act;
        if (act === 'connect' || act === 'reconnect') { if (!provider()?.configured) return; await goToSignIn(st.type); }
        else if (act === 'sync') run('manual');
        else if (act === 'disconnect') await disconnect();
        else if (act === 'backup') { dl.close(); window.PaperDeskFeatures?.backupDialog?.(); }
        else if (act === 'save-ids') {
          dl.querySelectorAll('[data-client]').forEach((i) => Cloud.setClientId(i.dataset.client, i.value));
          toast('Client IDs saved on this device'); renderDialog();
        }
      });
    });
    return st.dialog;
  }

  A.setHooks({ syncDialog: openSyncDialog });
  window.PaperDeskSync = { openDialog: openSyncDialog, label, run: () => run('manual'), state: st };

  /* ---------- start ---------- */
  (async () => {
    let back = await Cloud.handleRedirect();
    // Sign-ins started by Send to are finished by the Send dialog, not by sync.
    if (back && back.purpose && back.purpose !== 'sync') back = null;
    if (back) {
      if (back.ok) { if (st.type !== back.provider) { st.type = back.provider; ls.set('pd.sync.provider', back.provider); } if (!back.silent) toast(`Connected to ${NAMES[back.provider]}`); ls.set('pd.auth.silentAt', null); }
      else if (!back.silent) toast(`${NAMES[back.provider]} sign-in didn't finish: ${back.error}`);
    }
    makeEngine();
    setStatus(st.type && connected() ? 'idle' : 'off');
    if (back && !back.ok && back.silent) { setStatus('needsAuth', back.error); return; }
    run('startup');
  })();
})();

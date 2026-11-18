/* PaperDesk "Look": desk themes (wood, leather, glass…), note styles and colours,
   auto-fit note height, and defaults for new notes.
   Desk theme: board.deskTheme. Per note: n.nstyle, n.color, n.autofit (synced like any note field).
   Defaults for new notes live on this device (localStorage "pd.look"). */
(function () {
  'use strict';
  const A = window.PaperDeskApp;
  if (!A) return;
  const { $, $$, esc, icon, S, save, pushUndo, findNote, activeBoard, renderAll, toast } = A;

  /* ------------------------------------------------------------ data */
  const COLORS = [['yellow', 'Yellow', '#FFF1A8'], ['pink', 'Pink', '#FFD1DC'], ['orange', 'Orange', '#FFDDB5'], ['green', 'Green', '#CDEFC4'], ['blue', 'Blue', '#CFE6FF'], ['purple', 'Purple', '#E3D5FF'], ['gray', 'Grey', '#E6E4DE'], ['white', 'White', '#FFFFFF']];
  const STYLES = [['', 'Classic', 'Clean card'], ['sticky', 'Sticky', 'Post-it with a curl'], ['paper', 'Lined', 'Notebook paper'], ['kraft', 'Kraft', 'Cardboard'], ['glass', 'Glass', 'Frosted, see-through']];
  const DESKS = [['', 'Paper'], ['grid', 'Grid'], ['wood', 'Wood'], ['leather', 'Leather'], ['cork', 'Cork'], ['chalk', 'Chalkboard'], ['glass', 'Glass'], ['linen', 'Linen'], ['blueprint', 'Blueprint']];
  // Notes whose height can follow their content (media notes keep their size).
  const FIT = new Set(['text', 'checklist', 'hyperlink', 'bookmark', 'emailLink', 'invitation', 'calendar', 'alarm', 'appShortcut']);

  /* ------------------------------------------------------------ desk textures (pure CSS + tiny SVG noise) */
  const svgUrl = (svg) => `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
  const noise = (w, h, freq, oct, seed, rgb, a, bias = 0) => svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><filter id="f" x="0" y="0" width="100%" height="100%"><feTurbulence type="fractalNoise" baseFrequency="${freq}" numOctaves="${oct}" seed="${seed}" stitchTiles="stitch"/><feColorMatrix values="0 0 0 0 ${rgb[0]} 0 0 0 0 ${rgb[1]} 0 0 0 0 ${rgb[2]} ${a} 0 0 0 ${bias}"/></filter><rect width="100%" height="100%" filter="url(#f)"/></svg>`);
  const P = 'var(--bgx,0px) var(--bgy,0px)';
  const Z = (n) => `calc(${n}px * var(--z,1))`;
  function deskCss() {
    const wood = noise(640, 640, '0.004 0.09', 5, 4, [0.33, 0.19, 0.09], 1.5, -0.25);
    const wood2 = noise(640, 640, '0.012 0.4', 3, 9, [0.2, 0.1, 0.04], 0.9, -0.25);
    const leather = noise(300, 300, '0.55', 3, 2, [0.95, 0.85, 0.75], 0.55, -0.12);
    const leather2 = noise(500, 500, '0.035', 3, 6, [0, 0, 0], 1.1, -0.2);
    const cork = noise(400, 400, '0.7', 2, 5, [0.38, 0.2, 0.08], 1.4, -0.28);
    const cork2 = noise(400, 400, '0.06', 4, 8, [0.95, 0.8, 0.55], 0.9, -0.25);
    const chalk = noise(400, 400, '0.5', 2, 3, [1, 1, 1], 0.5, -0.12);
    const rules = [
      ['grid', `background-color:var(--paper);background-image:linear-gradient(var(--dot) 1px,transparent 1px),linear-gradient(90deg,var(--dot) 1px,transparent 1px);background-size:${Z(24)} ${Z(24)};background-position:${P}`],
      ['wood', `background-color:#A9764A;background-image:linear-gradient(to bottom,rgba(0,0,0,.34) 0 2px,rgba(255,255,255,.1) 2px 3px,transparent 3px),${wood2},${wood};background-size:100% ${Z(176)},${Z(640)} ${Z(640)},${Z(640)} ${Z(640)};background-position:${P},${P},${P}`],
      ['leather', `background-color:#3B2A22;background-image:radial-gradient(ellipse at 50% 40%,transparent 45%,rgba(0,0,0,.5)),${leather},${leather2};background-size:100% 100%,${Z(300)} ${Z(300)},${Z(500)} ${Z(500)};background-position:0 0,${P},${P}`],
      ['cork', `background-color:#C89B63;background-image:${cork},${cork2};background-size:${Z(400)} ${Z(400)},${Z(400)} ${Z(400)};background-position:${P},${P}`],
      ['chalk', `background-color:#2E3F3A;background-image:${chalk},radial-gradient(rgba(255,255,255,.22) 1px,transparent 1.4px);background-size:${Z(400)} ${Z(400)},${Z(24)} ${Z(24)};background-position:${P},${P}`],
      ['glass', `background-color:#DCE8F7;background-image:radial-gradient(circle at 18% 22%,#7FCBFF 0,transparent 42%),radial-gradient(circle at 82% 28%,#D2A6FF 0,transparent 40%),radial-gradient(circle at 55% 92%,#FFC2A0 0,transparent 45%),radial-gradient(circle at 8% 88%,#9BF0D2 0,transparent 35%)`],
      ['linen', `background-color:#E9E2D2;background-image:repeating-linear-gradient(0deg,rgba(120,100,70,.09) 0 1px,transparent 1px 4px),repeating-linear-gradient(90deg,rgba(120,100,70,.09) 0 1px,transparent 1px 4px);background-size:${Z(4)} ${Z(4)};background-position:${P}`],
      ['blueprint', `background-color:#1F3F6B;background-image:linear-gradient(rgba(255,255,255,.18) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.18) 1px,transparent 1px),linear-gradient(rgba(255,255,255,.07) 1px,transparent 1px),linear-gradient(90deg,rgba(255,255,255,.07) 1px,transparent 1px);background-size:${Z(120)} ${Z(120)},${Z(120)} ${Z(120)},${Z(24)} ${Z(24)},${Z(24)} ${Z(24)};background-position:${P},${P},${P},${P}`],
    ];
    const kraft = noise(200, 200, '0.8', 2, 11, [0.35, 0.22, 0.1], 1.1, -0.35);
    return `:root{--lk-noise:${kraft}}\n` + rules.map(([id, css]) => `[data-desk="${id}"],#viewport[data-desk="${id}"]{${css}}`).join('\n');
  }
  const styleEl = document.createElement('style'); styleEl.id = 'look-desk-css'; styleEl.textContent = deskCss(); document.head.appendChild(styleEl);

  /* ------------------------------------------------------------ settings */
  const ls = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* blocked */ } },
  };
  const def = Object.assign({ nstyle: '', color: '', autofit: false }, ls.get('pd.look', {}));
  const saveDef = () => ls.set('pd.look', def);
  const homeBoard = () => A.homeBoard ? A.homeBoard() : S.boards[0];

  /* ------------------------------------------------------------ applying looks to the desk */
  function applyDesk() {
    const vp = $('#viewport'); if (!vp) return;
    const b = activeBoard(), id = (b.isGroup ? homeBoard() : b).deskTheme || '';
    if (id) vp.dataset.desk = id; else delete vp.dataset.desk;
    document.body.classList.toggle('desk-themed', !!id);
  }
  const colorHex = (id) => (COLORS.find((c) => c[0] === id) || [])[2] || '';
  function applyNoteLook(el, n) {
    if (n.nstyle) el.dataset.ns = n.nstyle; else delete el.dataset.ns;
    if (n.color && colorHex(n.color)) { el.dataset.nc = n.color; el.style.setProperty('--nc', colorHex(n.color)); }
    else { delete el.dataset.nc; el.style.removeProperty('--nc'); }
  }

  /* ------------------------------------------------------------ auto-fit */
  const lastFit = new Map();
  function measure(el, n) {
    const card = el.querySelector(':scope > .card'); if (!card) return null;
    const saved = [el.style.height, card.style.position, card.style.inset];
    const tas = $$('textarea', el);
    tas.forEach((t) => { t.style.flex = 'none'; t.style.height = '0px'; });
    el.style.height = 'auto'; card.style.position = 'relative'; card.style.inset = 'auto';
    tas.forEach((t) => { t.style.height = Math.max(24, t.scrollHeight) + 'px'; });
    const h = Math.ceil(el.offsetHeight);
    tas.forEach((t) => { t.style.flex = ''; });
    [el.style.height, card.style.position, card.style.inset] = saved;
    return Math.max(72, Math.min(1400, h));
  }
  function fitNote(el, n, { silent = false } = {}) {
    const h = measure(el, n); if (h == null) return false;
    el.style.height = h + 'px';
    const changed = Math.abs((n.h || 0) - h) > 1;
    if (changed) { n.h = h; if (!silent) { A.renderLinks?.(); A.positionNoteBar?.(); save(); } }
    lastFit.set(n.id, n.h);
    return changed;
  }
  function fitAll() {
    let moved = false;
    for (const el of $$('#notes .note')) {
      const n = findNote(el.dataset.id); if (!n) continue;
      if (!n.autofit || !FIT.has(n.type)) { lastFit.delete(n.id); continue; }
      // The user dragged a resize handle: that means they want their own size.
      if (lastFit.has(n.id) && Math.abs(n.h - lastFit.get(n.id)) > 2) { n.autofit = false; lastFit.delete(n.id); moved = true; continue; }
      fitNote(el, n, { silent: true }); moved = true;
    }
    if (moved) { A.renderLinks?.(); A.positionNoteBar?.(); save(); }
  }
  document.addEventListener('input', (e) => {
    const el = e.target.closest?.('#notes .note'); if (!el) return;
    const n = findNote(el.dataset.id); if (n?.autofit && FIT.has(n.type)) requestAnimationFrame(() => fitNote(el, n));
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.closest?.('#notes .note')) { const el = e.target.closest('.note'), n = findNote(el.dataset.id); if (n?.autofit) setTimeout(() => fitNote(el, n), 0); } });

  /* ------------------------------------------------------------ new notes get the defaults */
  function stampNew() {
    if (!def.nstyle && !def.color && !def.autofit) return false;
    let any = false; const now = Date.now();
    for (const b of S.boards) for (const n of b.notes || []) {
      if (n.lookSet || !n.createdAt || now - n.createdAt > 4000) continue;
      n.lookSet = true; any = true;
      if (def.nstyle) n.nstyle = def.nstyle;
      if (def.color) n.color = def.color;
      if (def.autofit && FIT.has(n.type)) n.autofit = true;
    }
    return any;
  }

  let busy = false;
  function onRender() {
    if (busy) return; busy = true;
    try {
      applyDesk();
      if (stampNew()) { save(); busy = false; renderAll(); return; }
      for (const el of $$('#notes .note')) { const n = findNote(el.dataset.id); if (n) applyNoteLook(el, n); }
      fitAll();
    } finally { busy = false; }
  }
  const mo = new MutationObserver(onRender);
  mo.observe($('#notes'), { childList: true });
  mo.observe($('#viewport'), { attributes: true, attributeFilter: ['class'] });
  window.addEventListener('load', () => setTimeout(fitAll, 400));
  document.fonts?.ready.then(() => fitAll());

  /* ------------------------------------------------------------ dialog */
  const st = { target: 'new' };
  let dlg;
  const selNotes = () => A.selectedIds().map(findNote).filter(Boolean);
  function targetNotes() { return st.target === 'sel' ? selNotes() : st.target === 'all' ? (homeBoard().notes || []).concat(activeBoard().isGroup ? [] : []) : []; }
  function current() {
    if (st.target === 'new') return def;
    const n = (st.target === 'sel' ? selNotes() : (activeBoard().notes || []))[0];
    return n ? { nstyle: n.nstyle || '', color: n.color || '', autofit: !!n.autofit } : { nstyle: '', color: '', autofit: false };
  }
  function setProp(prop, val) {
    if (st.target === 'new') { def[prop] = val; saveDef(); render(); return; }
    const list = st.target === 'sel' ? selNotes() : (activeBoard().notes || []);
    if (!list.length) return;
    pushUndo();
    for (const n of list) {
      if (prop === 'autofit' && val && !FIT.has(n.type)) continue;
      n[prop] = val; n.lookSet = true;
      if (prop === 'autofit' && !val) lastFit.delete(n.id);
    }
    renderAll(); save(); render();
  }
  function setDesk(id) {
    pushUndo(); homeBoard().deskTheme = id; save(); applyDesk(); renderAll(); render();
  }
  const noteSwatch = (ns, nc, label) => `<span class="lk-prev" ${ns ? `data-ns="${ns}"` : ''} ${nc ? `data-nc="${nc}" style="--nc:${colorHex(nc)}"` : ''}><span class="card">${esc(label)}</span></span>`;
  function view() {
    const nSel = selNotes().length, cur = current();
    const deskId = (activeBoard().isGroup ? homeBoard() : activeBoard()).deskTheme || '';
    const targets = [['new', 'New notes'], ...(nSel ? [['sel', `Selected (${nSel})`]] : []), ['all', 'All notes on this desk']];
    if (st.target === 'sel' && !nSel) st.target = 'new';
    return `<div class="sd-head"><span class="sd-mono" style="--c:var(--accent)">${icon('palette')}</span><h2>Look</h2><button type="button" class="ib" data-lk="close" aria-label="Close">${icon('x')}</button></div>
    <div class="sd-body">
      <h3>Desk</h3>
      <div class="lk-desks" role="group" aria-label="Desk theme">${DESKS.map(([id, name]) => `<button type="button" class="lk-desk" data-lk-desk="${id}" aria-pressed="${deskId === id}"><i ${id ? `data-desk="${id}"` : 'class="plain"'} style="--z:.4"></i><span>${name}</span></button>`).join('')}</div>
      <h3>Notes</h3>
      <div class="sd-scope" role="group" aria-label="Apply to">${targets.map(([id, name]) => `<button type="button" class="sd-pill" data-lk-target="${id}" aria-pressed="${st.target === id}">${name}</button>`).join('')}</div>
      <p class="sd-note">${st.target === 'new' ? 'Used for every note you create from now on. Existing notes keep their look.' : st.target === 'sel' ? 'Changes the selected notes right away. Undo brings them back.' : 'Changes every note on this desk. Undo brings them back.'}</p>
      <div class="lk-styles" role="group" aria-label="Note style">${STYLES.map(([id, name, d]) => `<button type="button" class="lk-style" data-lk-style="${id}" aria-pressed="${cur.nstyle === id}" title="${esc(d)}">${noteSwatch(id, cur.color, 'Aa')}<span>${name}</span></button>`).join('')}</div>
      <div class="lk-colors" role="group" aria-label="Note colour"><button type="button" class="lk-color none" data-lk-color="" aria-pressed="${!cur.color}" title="Default colour"></button>${COLORS.map(([id, name, hex]) => `<button type="button" class="lk-color" data-lk-color="${id}" aria-pressed="${cur.color === id}" title="${name}" style="--c:${hex}"></button>`).join('')}</div>
      <label class="sd-check"><input type="checkbox" data-lk-fit ${cur.autofit ? 'checked' : ''}/> <span><b>Fit the note to its content</b> — the note grows and shrinks as you type (text, checklists, reminders, links…). Dragging a resize handle turns it off for that note.</span></label>
    </div>
    <div class="sd-foot"><span class="grow">${st.target === 'new' ? 'Saved on this device.' : ''}</span><button type="button" class="btn primary" data-lk="close">Done</button></div>`;
  }
  function render() { if (dlg) $('.sd', dlg).innerHTML = view(); }
  function mount() {
    dlg = document.createElement('dialog'); dlg.id = 'look-dlg'; dlg.setAttribute('aria-label', 'Look');
    dlg.innerHTML = '<div class="sd"></div>'; document.body.appendChild(dlg);
    dlg.addEventListener('click', (e) => {
      const t = e.target.closest('[data-lk],[data-lk-desk],[data-lk-target],[data-lk-style],[data-lk-color]'); if (!t) return;
      if (t.dataset.lk === 'close') dlg.close();
      else if (t.dataset.lkDesk !== undefined) setDesk(t.dataset.lkDesk);
      else if (t.dataset.lkTarget) { st.target = t.dataset.lkTarget; render(); }
      else if (t.dataset.lkStyle !== undefined) setProp('nstyle', t.dataset.lkStyle);
      else if (t.dataset.lkColor !== undefined) setProp('color', t.dataset.lkColor);
    });
    dlg.addEventListener('change', (e) => { if (e.target.dataset.lkFit !== undefined) setProp('autofit', e.target.checked); });
    dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) dlg.close(); });
  }
  function open(target) {
    if (!dlg) mount();
    st.target = target || (selNotes().length ? 'sel' : 'new');
    render(); if (!dlg.open) dlg.showModal();
  }

  /* ------------------------------------------------------------ entry points */
  const sym = document.querySelector('symbol')?.parentNode;
  if (sym) sym.insertAdjacentHTML('beforeend', '<symbol id="i-palette" viewBox="0 0 24 24"><path d="M12 3a9 9 0 1 0 0 18c1.1 0 1.8-.8 1.8-1.7 0-.5-.2-.9-.5-1.3-.3-.4-.5-.8-.5-1.3 0-1 .8-1.7 1.8-1.7H17a4 4 0 0 0 4-4c0-4.4-4-8-9-8z"/><circle cx="7.5" cy="11" r="1"/><circle cx="10" cy="7" r="1"/><circle cx="14.5" cy="7" r="1"/></symbol>');
  const b = document.createElement('button');
  b.className = 'ib'; b.id = 'look-btn'; b.type = 'button'; b.title = 'Look: desk themes, note colours, auto-fit'; b.setAttribute('aria-label', 'Look: desk themes and note colours');
  b.innerHTML = icon('palette'); b.addEventListener('click', () => open());
  const anchor = $('#ai-btn') || $('#sync-btn'); if (anchor) anchor.parentNode.insertBefore(b, anchor);

  window.PaperDeskLook = { open, fitAll, def, COLORS, STYLES, DESKS };
  onRender();
})();

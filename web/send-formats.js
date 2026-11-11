/* PaperDesk "Send to" formats.
   Turns notes into a neutral item list (the PaperDesk Send format) and writes
   that list as Markdown, HTML, plain text, CSV, Evernote (.enex), calendar
   (.ics), outline (.opml), JSON or a .zip bundle. No browser APIs are needed,
   so the same code runs in Node for tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PDSendFormats = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const FORMAT = 'paperdesk-send', VERSION = 1;
  const pad = (n) => String(n).padStart(2, '0');
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const xmlEsc = (s) => esc(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

  /* ------------------------------------------------------------------ items */
  const PRIORITY = { urgent: 'high', deadline: 'medium', raise: 'medium' };
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/, TIME_RE = /^\d{1,2}:\d{2}$/;

  function dueOf(n) {
    const m = n.meta || {};
    if (n.type === 'calendar' || n.type === 'invitation') {
      if (DATE_RE.test(m.date || '')) return { date: m.date, time: TIME_RE.test(m.time || '') ? m.time.padStart(5, '0') : '' };
    }
    if (n.type === 'alarm') {
      const date = DATE_RE.test(m.dateIso || '') ? m.dateIso : '';
      const time = TIME_RE.test(m.time24 || '') ? m.time24.padStart(5, '0') : '';
      if (date) return { date, time };
    }
    return null;
  }

  function dataUrlInfo(url) {
    const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(url || '');
    if (!m) return null;
    return { mime: m[1] || 'application/octet-stream', base64: !!m[2], data: m[3] };
  }
  const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg', 'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mpeg': 'mp3', 'audio/mp4': 'm4a', 'audio/wav': 'wav', 'video/mp4': 'mp4', 'video/webm': 'webm', 'application/pdf': 'pdf', 'text/plain': 'txt' };
  function safeName(s, fallback = 'note') {
    const out = String(s || '').replace(/[\\/:*?"<>|#^[\]\u0000-\u001F]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
    return out || fallback;
  }

  /**
   * Builds one PaperDesk Send item from a note.
   * ctx: { desk, types: {type:{label}}, badges: {id:{label}}, inkSvg(note) -> svg string or '' }
   */
  function buildItem(n, ctx = {}) {
    const typeLabel = ctx.types?.[n.type]?.label || n.type || 'Note';
    const body = String(n.body || '');
    const firstLine = body.split('\n').find((l) => l.trim()) || '';
    const title = String(n.title || '').trim() || firstLine.trim().slice(0, 80) || typeLabel;
    const attachments = [];
    const addAtt = (url, name) => {
      const info = dataUrlInfo(url); if (!info) return;
      const ext = EXT[info.mime] || (info.mime.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 5);
      attachments.push({ name: `${safeName(name || title)}.${ext}`, mime: info.mime, dataUrl: url });
    };
    if (n.url && n.url.startsWith('data:')) addAtt(n.url, n.meta?.fileName || title);
    if (n.meta?.dataUrl && n.meta.dataUrl !== n.url) addAtt(n.meta.dataUrl, title);
    if (n.meta?.audioDataUrl) addAtt(n.meta.audioDataUrl, `${title} (voice memo)`);
    const svg = n.scribbles?.length && ctx.inkSvg ? ctx.inkSvg(n) : '';
    if (svg) attachments.push({ name: `${safeName(title)} (ink).svg`, mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg), ink: true });
    const badges = (n.badges || []).filter((b) => b !== 'circle');
    const due = dueOf(n);
    return {
      id: n.id,
      type: n.type || 'text',
      typeLabel,
      title,
      text: body,
      url: n.url && !n.url.startsWith('data:') ? n.url : '',
      tasks: (n.tasks || []).map((t) => ({ title: String(t.title || ''), done: !!t.done })).filter((t) => t.title),
      due: due ? (due.time ? `${due.date}T${due.time}` : due.date) : '',
      dueDate: due?.date || '',
      dueTime: due?.time || '',
      location: n.meta?.location || '',
      tags: badges.map((b) => ctx.badges?.[b]?.label || b),
      priority: badges.map((b) => PRIORITY[b]).find(Boolean) || '',
      done: !!(n.tasks?.length && n.tasks.every((t) => t.done)) || badges.includes('verified'),
      desk: ctx.desk || '',
      created: n.createdAt ? new Date(n.createdAt).toISOString() : '',
      attachments,
    };
  }

  function buildItems(notes, ctx = {}) {
    // Reading order on the desk: top to bottom, then left to right (rows of ~80px).
    const sorted = [...notes].sort((a, b) => (Math.round((a.y || 0) / 80) - Math.round((b.y || 0) / 80)) || ((a.x || 0) - (b.x || 0)));
    return sorted.map((n) => buildItem(n, ctx));
  }

  /* -------------------------------------------------------------- text kinds */
  const metaParts = (it) => [
    it.typeLabel && it.type !== 'text' ? it.typeLabel : '',
    it.due ? `Due ${it.due.replace('T', ' ')}` : '',
    it.location ? `At ${it.location}` : '',
    it.priority === 'high' ? 'High priority' : '',
    it.tags.length ? it.tags.map((t) => '#' + t.replace(/\s+/g, '-')).join(' ') : '',
  ].filter(Boolean);

  function itemMarkdown(it, { level = 2, attachDir = '', frontMatter = false } = {}) {
    const out = [];
    if (frontMatter) {
      out.push('---', `title: ${JSON.stringify(it.title)}`);
      if (it.tags.length) out.push(`tags: [${it.tags.map((t) => JSON.stringify(t)).join(', ')}]`);
      if (it.due) out.push(`due: ${it.due}`);
      if (it.created) out.push(`created: ${it.created}`);
      out.push(`type: ${it.type}`, 'source: PaperDesk', '---', '');
    }
    if (level) out.push(`${'#'.repeat(level)} ${it.title}`, '');
    const meta = metaParts(it); if (meta.length) out.push(`*${meta.join(' · ')}*`, '');
    if (it.text.trim()) out.push(it.text.trim(), '');
    if (it.tasks.length) { for (const t of it.tasks) out.push(`- [${t.done ? 'x' : ' '}] ${t.title}`); out.push(''); }
    if (it.url) out.push(`<${it.url}>`, '');
    for (const a of it.attachments) {
      if (attachDir) out.push(`${a.mime.startsWith('image/') ? '!' : ''}[${a.name}](${encodeURI(attachDir + '/' + a.name)})`, '');
      else out.push(`*Attachment: ${a.name}*`, '');
    }
    return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  }
  function toMarkdown(items, opts = {}) {
    const head = opts.heading ? `# ${opts.heading}\n\n` : '';
    return head + items.map((it) => itemMarkdown(it, { level: opts.heading ? 2 : (opts.level ?? 2), attachDir: opts.attachDir })).join('\n');
  }

  function itemText(it) {
    const out = [it.title];
    const meta = metaParts(it); if (meta.length) out.push(meta.join(' · '));
    if (it.text.trim()) out.push(it.text.trim());
    for (const t of it.tasks) out.push(`${t.done ? '☑' : '☐'} ${t.title}`);
    if (it.url) out.push(it.url);
    for (const a of it.attachments) out.push(`(Attachment: ${a.name})`);
    return out.join('\n');
  }
  const toText = (items) => items.map(itemText).join('\n\n');

  /* flavor: 'generic' (☐ characters, inline images), 'onenote' (data-tag to-dos, images by part name),
     'enml' (Evernote: <en-todo/> and <en-media/>) */
  function itemHtml(it, { flavor = 'generic', level = 2, images = 'inline' } = {}) {
    const h = `h${Math.min(Math.max(level, 1), 6)}`;
    const out = level ? [`<${h}>${esc(it.title)}</${h}>`] : [];
    const meta = metaParts(it); if (meta.length) out.push(`<p><i>${esc(meta.join(' · '))}</i></p>`);
    if (it.text.trim()) out.push(...it.text.trim().split(/\n{2,}/).map((p) => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`));
    if (it.tasks.length) {
      if (flavor === 'onenote') out.push(...it.tasks.map((t) => `<p data-tag="to-do${t.done ? ':completed' : ''}">${esc(t.title)}</p>`));
      else if (flavor === 'enml') out.push(`<div>${it.tasks.map((t) => `<div><en-todo checked="${t.done}"/>${esc(t.title)}</div>`).join('')}</div>`);
      else out.push(`<ul style="list-style:none;padding-left:0">${it.tasks.map((t) => `<li>${t.done ? '☑' : '☐'} ${t.done ? `<s>${esc(t.title)}</s>` : esc(t.title)}</li>`).join('')}</ul>`);
    }
    if (it.url) out.push(`<p><a href="${esc(it.url)}">${esc(it.url)}</a></p>`);
    it.attachments.forEach((a, i) => {
      const isImg = a.mime.startsWith('image/');
      if (flavor === 'enml') { if (a.hash) out.push(`<div><en-media type="${esc(a.mime)}" hash="${a.hash}"/></div>`); return; }
      if (flavor === 'onenote' && images === 'parts') { out.push(isImg ? `<img src="name:${a.part || 'p' + i}" alt="${esc(a.name)}"/>` : `<object data-attachment="${esc(a.name)}" data="name:${a.part || 'p' + i}" type="${esc(a.mime)}"/>`); return; }
      if (isImg && images === 'inline') out.push(`<p><img src="${a.dataUrl}" alt="${esc(a.name)}" style="max-width:100%"/></p>`);
      else out.push(`<p><i>Attachment: ${esc(a.name)}</i></p>`);
    });
    return out.join('\n');
  }
  function toHtml(items, { title = '', flavor = 'generic', images = 'inline', standalone = false } = {}) {
    const body = (title ? `<h1>${esc(title)}</h1>\n` : '') + items.map((it) => itemHtml(it, { flavor, images, level: title ? 2 : 2 })).join(flavor === 'generic' ? '\n<hr/>\n' : '\n<br/>\n');
    if (!standalone) return body;
    return `<!doctype html>\n<html><head><meta charset="utf-8"/><title>${esc(title || 'PaperDesk notes')}</title>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<style>body{font:15px/1.55 system-ui,-apple-system,"Segoe UI",sans-serif;max-width:760px;margin:32px auto;padding:0 16px;color:#1C1B18}h1{font-size:26px}h2{font-size:19px;margin-top:28px}hr{border:0;border-top:1px solid #E3DFD6;margin:24px 0}i{color:#6B665C}img{border-radius:6px}@media print{body{margin:0}}</style>
</head><body>\n${body}\n</body></html>\n`;
  }

  /* ------------------------------------------------------------------- CSV */
  const csvCell = (v, sep) => { const s = String(v ?? ''); return /["\n\r]/.test(s) || s.includes(sep) || /^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
  const FIELDS = {
    title: { label: 'Title', get: (it) => it.title },
    text: { label: 'Description', get: (it) => it.text },
    details: { label: 'Details', get: (it) => [it.text.trim(), ...it.tasks.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.title}`), it.url].filter(Boolean).join('\n') },
    checklist: { label: 'Checklist', get: (it) => it.tasks.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.title}`).join('\n') },
    due: { label: 'Due', get: (it) => it.due.replace('T', ' ') },
    dueDate: { label: 'Due date', get: (it) => it.dueDate },
    dueTime: { label: 'Due time', get: (it) => it.dueTime },
    tags: { label: 'Tags', get: (it) => it.tags.join(', ') },
    priority: { label: 'Priority', get: (it) => it.priority },
    status: { label: 'Status', get: (it) => (it.done ? 'Done' : 'Open') },
    url: { label: 'URL', get: (it) => it.url },
    location: { label: 'Location', get: (it) => it.location },
    type: { label: 'Type', get: (it) => it.typeLabel },
    desk: { label: 'Desk', get: (it) => it.desk },
    created: { label: 'Created', get: (it) => it.created },
    parent: { label: 'Parent', get: (it) => it.parent || '' },
  };
  /* Column presets for tools with their own CSV importers. */
  const CSV_PRESETS = {
    generic: { label: 'Spreadsheet (Excel, Google Sheets, Numbers)', cols: [['title', 'Title'], ['text', 'Description'], ['checklist', 'Checklist'], ['dueDate', 'Due date'], ['dueTime', 'Due time'], ['priority', 'Priority'], ['tags', 'Tags'], ['status', 'Status'], ['url', 'URL'], ['type', 'Type'], ['desk', 'Desk'], ['created', 'Created']] },
    asana: { label: 'Asana', cols: [['title', 'Name'], ['details', 'Description'], ['dueDate', 'Due Date'], ['tags', 'Tags']] },
    jira: { label: 'Jira', cols: [['title', 'Summary'], ['details', 'Description'], ['dueDate', 'Due date'], ['tags', 'Labels'], ['priority', 'Priority']] },
    clickup: { label: 'ClickUp', cols: [['title', 'Task Name'], ['details', 'Task Content'], ['dueDate', 'Due Date'], ['tags', 'Tags'], ['priority', 'Priority'], ['status', 'Status']] },
    monday: { label: 'monday.com', cols: [['title', 'Name'], ['details', 'Description'], ['dueDate', 'Date'], ['status', 'Status'], ['tags', 'Tags']] },
    notion: { label: 'Notion database', cols: [['title', 'Name'], ['details', 'Notes'], ['dueDate', 'Date'], ['tags', 'Tags'], ['status', 'Status'], ['url', 'URL']] },
    trello: { label: 'Trello (via a CSV import Power-Up)', cols: [['title', 'Card Name'], ['details', 'Card Description'], ['dueDate', 'Due Date'], ['tags', 'Labels']] },
  };
  /**
   * cols: [[fieldKey, header], ...]; opts.splitTasks puts each checklist item on its own row
   * (with a Parent column); opts.sep default ','; opts.bom adds a UTF-8 BOM (Excel).
   */
  function toCSV(items, { cols = CSV_PRESETS.generic.cols, splitTasks = false, sep = ',', bom = true } = {}) {
    let rows = items;
    if (splitTasks) {
      rows = [];
      for (const it of items) {
        rows.push({ ...it, tasks: [] });
        for (const t of it.tasks) rows.push({ ...it, title: t.title, text: '', tasks: [], url: '', attachments: [], done: t.done, parent: it.title });
      }
      if (!cols.some(([k]) => k === 'parent')) cols = [...cols, ['parent', 'Parent']];
    }
    const lines = [cols.map(([, h]) => csvCell(h, sep)).join(sep)];
    for (const it of rows) lines.push(cols.map(([k]) => csvCell(FIELDS[k] ? FIELDS[k].get(it) : '', sep)).join(sep));
    return (bom ? '\uFEFF' : '') + lines.join('\r\n') + '\r\n';
  }

  /* Todoist's CSV template (Import from template). Checklist items become sub-tasks. */
  function toTodoistCSV(items) {
    const head = ['TYPE', 'CONTENT', 'DESCRIPTION', 'PRIORITY', 'INDENT', 'AUTHOR', 'RESPONSIBLE', 'DATE', 'DATE_LANG', 'TIMEZONE'];
    const pri = (p) => (p === 'high' ? 4 : p === 'medium' ? 3 : 1);
    const lines = [head.join(',')];
    const row = (content, desc, p, indent, date) => ['task', content, desc, p, indent, '', '', date, date ? 'en' : '', ''].map((v) => csvCell(v, ',')).join(',');
    for (const it of items) {
      lines.push(row(it.title, [it.text.trim(), it.url].filter(Boolean).join('\n'), pri(it.priority), 1, it.due ? it.due.replace('T', ' ') : ''));
      for (const t of it.tasks) if (!t.done) lines.push(row(t.title, '', 1, 2, ''));
    }
    return lines.join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ ENEX */
  function md5Hex(bytes) {
    const K = new Uint32Array(64), S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
    for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32) >>> 0;
    const len = bytes.length, nBlocks = ((len + 8) >> 6) + 1, words = new Uint32Array(nBlocks * 16);
    for (let i = 0; i < len; i++) words[i >> 2] |= bytes[i] << ((i % 4) * 8);
    words[len >> 2] |= 0x80 << ((len % 4) * 8);
    words[nBlocks * 16 - 2] = (len * 8) >>> 0; words[nBlocks * 16 - 1] = Math.floor(len / 2 ** 29);
    let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
    for (let blk = 0; blk < nBlocks; blk++) {
      let A = a0, Bv = b0, C = c0, D = d0;
      for (let i = 0; i < 64; i++) {
        let F, g;
        if (i < 16) { F = (Bv & C) | (~Bv & D); g = i; } else if (i < 32) { F = (D & Bv) | (~D & C); g = (5 * i + 1) % 16; }
        else if (i < 48) { F = Bv ^ C ^ D; g = (3 * i + 5) % 16; } else { F = C ^ (Bv | ~D); g = (7 * i) % 16; }
        const tmp = D; D = C; C = Bv;
        const sum = (A + F + K[i] + words[blk * 16 + g]) >>> 0, s = S[(i >> 4) * 4 + (i % 4)];
        Bv = (Bv + ((sum << s) | (sum >>> (32 - s)))) >>> 0; A = tmp;
      }
      a0 = (a0 + A) >>> 0; b0 = (b0 + Bv) >>> 0; c0 = (c0 + C) >>> 0; d0 = (d0 + D) >>> 0;
    }
    return [a0, b0, c0, d0].map((v) => [0, 8, 16, 24].map((sh) => ((v >>> sh) & 255).toString(16).padStart(2, '0')).join('')).join('');
  }
  function b64ToBytes(b64) {
    if (typeof atob === 'function') { const s = atob(b64); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }
    return new Uint8Array(Buffer.from(b64, 'base64'));
  }
  function bytesToB64(u) {
    if (typeof btoa === 'function') { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); }
    return Buffer.from(u).toString('base64');
  }
  const utf8 = (s) => new TextEncoder().encode(s);
  function dataUrlBytes(url) {
    const info = dataUrlInfo(url); if (!info) return new Uint8Array(0);
    return info.base64 ? b64ToBytes(info.data) : utf8(decodeURIComponent(info.data));
  }
  const enexDate = (iso) => (iso ? iso.replace(/[-:]/g, '').replace(/\.\d+/, '') : new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, ''));
  function toENEX(items) {
    const notes = items.map((it) => {
      const res = it.attachments.map((a) => { const bytes = dataUrlBytes(a.dataUrl); return { a, bytes, hash: md5Hex(bytes) }; });
      const withHash = { ...it, attachments: res.map((r) => ({ ...r.a, hash: r.hash })) };
      const content = `<?xml version="1.0" encoding="UTF-8" standalone="no"?><!DOCTYPE en-note SYSTEM "http://xml.evernote.com/pub/enml2.dtd"><en-note>${itemHtml(withHash, { flavor: 'enml', level: 0 })}</en-note>`;
      return `<note><title>${xmlEsc(it.title.slice(0, 255))}</title><content><![CDATA[${content.replace(/]]>/g, ']]]]><![CDATA[>')}]]></content>`
        + (it.created ? `<created>${enexDate(it.created)}</created>` : '')
        + it.tags.map((t) => `<tag>${xmlEsc(t)}</tag>`).join('')
        + (it.url ? `<note-attributes><source-url>${xmlEsc(it.url)}</source-url></note-attributes>` : '')
        + res.map((r) => `<resource><data encoding="base64">${bytesToB64(r.bytes)}</data><mime>${xmlEsc(r.a.mime)}</mime><resource-attributes><file-name>${xmlEsc(r.a.name)}</file-name></resource-attributes></resource>`).join('')
        + '</note>';
    });
    return `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE en-export SYSTEM "http://xml.evernote.com/pub/evernote-export4.dtd">\n<en-export export-date="${enexDate()}" application="PaperDesk" version="1">\n${notes.join('\n')}\n</en-export>\n`;
  }

  /* ------------------------------------------------------------------- ICS */
  const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
  function fold(line) { const out = []; let s = line; while (utf8(s).length > 74) { let cut = 74; while (utf8(s.slice(0, cut)).length > 74) cut--; out.push(s.slice(0, cut)); s = ' ' + s.slice(cut); } out.push(s); return out.join('\r\n'); }
  const icsStamp = (d = new Date()) => `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
  /** Events for calendar notes, to-dos for everything else that has a date or a checklist. */
  function toICS(items, { onlyDated = true, allEvents = false } = {}) {
    const L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//PaperDesk//Send//EN', 'CALSCALE:GREGORIAN'];
    for (const it of items) {
      if (onlyDated && !it.dueDate) continue;
      // Google Calendar and most calendar apps import events only, so they can ask for everything as events.
      const isEvent = !!it.dueDate && (allEvents || it.type === 'calendar' || it.type === 'invitation');
      const desc = [it.text.trim(), ...it.tasks.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.title}`), it.url].filter(Boolean).join('\n');
      const d = it.dueDate.replace(/-/g, ''), t = it.dueTime.replace(':', '');
      L.push(isEvent ? 'BEGIN:VEVENT' : 'BEGIN:VTODO', `UID:${it.id}@paperdesk`, `DTSTAMP:${icsStamp()}`, `SUMMARY:${icsText(it.title)}`);
      if (desc) L.push(`DESCRIPTION:${icsText(desc)}`);
      if (it.location) L.push(`LOCATION:${icsText(it.location)}`);
      if (it.tags.length) L.push(`CATEGORIES:${it.tags.map(icsText).join(',')}`);
      if (isEvent) {
        if (t) { L.push(`DTSTART:${d}T${t}00`); L.push('DURATION:PT1H'); }
        else { const end = new Date(Date.UTC(+d.slice(0, 4), +d.slice(4, 6) - 1, +d.slice(6, 8) + 1)); L.push(`DTSTART;VALUE=DATE:${d}`, `DTEND;VALUE=DATE:${end.getUTCFullYear()}${pad(end.getUTCMonth() + 1)}${pad(end.getUTCDate())}`); }
        L.push('END:VEVENT');
      } else {
        if (d) L.push(t ? `DUE:${d}T${t}00` : `DUE;VALUE=DATE:${d}`);
        if (it.priority === 'high') L.push('PRIORITY:1'); else if (it.priority === 'medium') L.push('PRIORITY:5');
        L.push(`STATUS:${it.done ? 'COMPLETED' : 'NEEDS-ACTION'}`);
        if (it.type === 'alarm' && t) L.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(it.title)}`, 'TRIGGER:PT0S', 'END:VALARM');
        L.push('END:VTODO');
      }
    }
    L.push('END:VCALENDAR');
    return L.map(fold).join('\r\n') + '\r\n';
  }

  /* ------------------------------------------------------------------ OPML */
  function toOPML(items, { title = 'PaperDesk' } = {}) {
    const attr = (s) => xmlEsc(s).replace(/\n/g, '&#10;');
    const outline = (it) => {
      const kids = [
        ...it.text.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `<outline text="${attr(l)}"/>`),
        ...it.tasks.map((t) => `<outline text="${attr(t.title)}"${t.done ? ' _complete="true"' : ''}/>`),
        ...(it.url ? [`<outline text="${attr(it.url)}" type="link" url="${attr(it.url)}"/>`] : []),
      ];
      const note = metaParts(it).join(' · ');
      return `<outline text="${attr(it.title)}"${note ? ` _note="${attr(note)}"` : ''}${kids.length ? `>${kids.join('')}</outline>` : '/>'}`;
    };
    return `<?xml version="1.0" encoding="UTF-8"?>\n<opml version="2.0"><head><title>${xmlEsc(title)}</title></head><body>\n${items.map(outline).join('\n')}\n</body></opml>\n`;
  }

  /* ------------------------------------------------------------------ JSON */
  function toJSON(items, { desk = '', withAttachments = true, pretty = true } = {}) {
    const doc = {
      format: FORMAT, version: VERSION, exportedAt: new Date().toISOString(),
      source: { app: 'PaperDesk', desk },
      items: items.map((it) => ({ ...it, attachments: withAttachments ? it.attachments : it.attachments.map(({ dataUrl, ...rest }) => rest) })),
    };
    return JSON.stringify(doc, null, pretty ? 2 : 0);
  }

  /* ------------------------------------------------------------- templates */
  /* {{field}} or {{field|filter|filter}}. Filters: url, json, html, upper, lower, trim, first:N */
  function templateValues(it, all = []) {
    return {
      id: it.id, title: it.title, text: it.text, url: it.url, type: it.type, type_label: it.typeLabel,
      due: it.due, due_date: it.dueDate, due_time: it.dueTime, location: it.location,
      tags: it.tags.join(', '), tags_hash: it.tags.map((t) => '#' + t.replace(/\s+/g, '-')).join(' '), tags_list: it.tags,
      priority: it.priority, status: it.done ? 'done' : 'open', done: it.done,
      desk: it.desk, created: it.created,
      tasks_md: it.tasks.map((t) => `- [${t.done ? 'x' : ' '}] ${t.title}`).join('\n'),
      tasks_text: it.tasks.map((t) => t.title).join('\n'), tasks: it.tasks,
      markdown: itemMarkdown(it), html: itemHtml(it), plain: itemText(it),
      item: { ...it, attachments: it.attachments.map(({ dataUrl, ...r }) => r) },
      items: all.map((x) => ({ ...x, attachments: x.attachments.map(({ dataUrl, ...r }) => r) })),
      count: all.length, now: new Date().toISOString(),
    };
  }
  function renderTemplate(tpl, it, all = []) {
    const vals = templateValues(it, all);
    return String(tpl).replace(/\{\{\s*([a-z_]+)((?:\s*\|\s*[a-z]+(?::\d+)?)*)\s*\}\}/gi, (m, key, filters) => {
      if (!(key in vals)) return m;
      let v = vals[key];
      const fl = filters.split('|').map((f) => f.trim()).filter(Boolean);
      if (!fl.includes('json') && typeof v === 'object' && v !== null) v = Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(', ') : JSON.stringify(v);
      for (const f of fl) {
        const [name, arg] = f.split(':');
        if (name === 'json') v = JSON.stringify(v ?? '');
        else if (name === 'url') v = encodeURIComponent(String(v ?? ''));
        else if (name === 'html') v = esc(v);
        else if (name === 'upper') v = String(v ?? '').toUpperCase();
        else if (name === 'lower') v = String(v ?? '').toLowerCase();
        else if (name === 'trim') v = String(v ?? '').trim();
        else if (name === 'first') v = String(v ?? '').slice(0, Number(arg) || 100);
      }
      return v == null ? '' : String(v);
    });
  }
  const TEMPLATE_FIELDS = ['title', 'text', 'markdown', 'html', 'plain', 'url', 'due', 'due_date', 'due_time', 'location', 'tags', 'tags_hash', 'priority', 'status', 'tasks_md', 'tasks_text', 'tasks', 'type', 'type_label', 'desk', 'created', 'id', 'item', 'items', 'count', 'now'];

  /* ------------------------------------------------------------------- ZIP */
  const CRC_TABLE = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
  function crc32(u) { let c = 0xffffffff; for (let i = 0; i < u.length; i++) c = CRC_TABLE[(c ^ u[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
  /** files: [{ name, data: string | Uint8Array }] -> Uint8Array of a stored (uncompressed) zip. */
  function zip(files, date = new Date()) {
    const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1);
    const dosDate = ((date.getFullYear() - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const chunks = [], central = []; let offset = 0;
    const u16 = (v) => [v & 255, (v >> 8) & 255], u32 = (v) => [v & 255, (v >> 8) & 255, (v >> 16) & 255, (v >>> 24) & 255];
    for (const f of files) {
      const name = utf8(f.name), data = typeof f.data === 'string' ? utf8(f.data) : f.data, crc = crc32(data);
      const common = [...u16(20), ...u16(0x0800), ...u16(0), ...u16(dosTime), ...u16(dosDate), ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), ...u16(0)];
      const local = new Uint8Array([...u32(0x04034b50), ...common]);
      chunks.push(local, name, data);
      central.push(new Uint8Array([...u32(0x02014b50), ...u16(20), ...common, ...u16(0), ...u16(0), ...u16(0), ...u32(0), ...u32(offset)]), name);
      offset += local.length + name.length + data.length;
    }
    const cdSize = central.reduce((s, c) => s + c.length, 0);
    const end = new Uint8Array([...u32(0x06054b50), ...u16(0), ...u16(0), ...u16(files.length), ...u16(files.length), ...u32(cdSize), ...u32(offset), ...u16(0)]);
    const all = [...chunks, ...central, end], out = new Uint8Array(all.reduce((s, c) => s + c.length, 0));
    let p = 0; for (const c of all) { out.set(c, p); p += c.length; }
    return out;
  }
  /** A folder of Markdown files with front matter, plus attachments/ — the format most notes apps import. */
  function markdownBundle(items, { desk = 'PaperDesk' } = {}) {
    const used = new Set(), files = [];
    const unique = (base, ext) => { let n = `${base}.${ext}`, i = 2; while (used.has(n.toLowerCase())) n = `${base} ${i++}.${ext}`; used.add(n.toLowerCase()); return n; };
    for (const it of items) {
      const name = unique(safeName(it.title), 'md');
      for (const a of it.attachments) { a.zipName = a.zipName || a.name; files.push({ name: `attachments/${a.zipName}`, data: dataUrlBytes(a.dataUrl) }); }
      files.push({ name, data: itemMarkdown({ ...it, attachments: it.attachments.map((a) => ({ ...a, name: a.zipName })) }, { level: 1, attachDir: 'attachments', frontMatter: true }) });
    }
    files.push({ name: `${safeName(desk)} (index).md`, data: `# ${desk}\n\n` + items.map((it) => `- [[${safeName(it.title)}]]`).join('\n') + '\n' });
    return files;
  }

  /* ------------------------------------------------------------- utilities */
  function splitText(s, max) { const out = []; let rest = String(s); while (rest.length > max) { let cut = rest.lastIndexOf('\n', max); if (cut < max * 0.5) cut = rest.lastIndexOf(' ', max); if (cut < max * 0.5) cut = max; out.push(rest.slice(0, cut)); rest = rest.slice(cut).replace(/^\s+/, ''); } if (rest) out.push(rest); return out; }
  function mailtoUrl({ to = '', subject = '', body = '' }, maxLen = 1900) {
    const build = (b) => `mailto:${encodeURIComponent(to).replace(/%40/g, '@').replace(/%2C/g, ',').replace(/%2B/g, '+')}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(b)}`;
    let url = build(body), truncated = false;
    if (url.length > maxLen) {
      truncated = true; let lo = 0, hi = body.length;
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (build(body.slice(0, mid) + '\n…').length <= maxLen) lo = mid; else hi = mid - 1; }
      url = build(body.slice(0, lo) + '\n…');
    }
    return { url, truncated };
  }

  return {
    FORMAT, VERSION, buildItem, buildItems, dueOf, safeName, dataUrlInfo, dataUrlBytes, bytesToB64, utf8,
    itemMarkdown, toMarkdown, itemText, toText, itemHtml, toHtml,
    FIELDS, CSV_PRESETS, toCSV, toTodoistCSV, md5Hex, toENEX, toICS, toOPML, toJSON,
    renderTemplate, templateValues, TEMPLATE_FIELDS, crc32, zip, markdownBundle, splitText, mailtoUrl, esc,
  };
});

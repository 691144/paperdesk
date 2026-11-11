/* PaperDesk "Send to" connectors: create items directly in other tools.
   Every call goes straight from this device to the tool's own API; nothing
   passes through a PaperDesk server. Tokens typed here stay on this device. */
(function () {
  'use strict';
  const F = window.PDSendFormats;

  /* ------------------------------------------------------------ helpers */
  class SendError extends Error { constructor(msg, code, status) { super(msg); this.code = code; this.status = status; } }
  const NET_MSG = 'The browser could not reach this service. You may be offline, or the service does not accept requests from web apps — try another way below.';

  async function readBody(res) {
    const text = await res.text().catch(() => '');
    try { return { text, json: text ? JSON.parse(text) : null }; } catch { return { text, json: null }; }
  }
  function errorFrom(res, { text, json }) {
    const j = json || {};
    const msg = j.error?.message || j.error_description || j.message || (typeof j.error === 'string' ? j.error : '') || j.errors?.[0]?.message || j.err || (text || '').slice(0, 200);
    const pre = res.status === 401 ? 'Not signed in or the token is not valid. ' : res.status === 403 ? 'Not allowed: check the token\'s permissions. ' : res.status === 404 ? 'Not found: check the list, board or page you chose. ' : '';
    return new SendError(`${pre}${msg || 'HTTP ' + res.status}`.trim(), res.status === 401 ? 'auth' : 'http', res.status);
  }
  async function http(url, opts = {}) {
    let res;
    try { res = await fetch(url, opts); } catch { throw new SendError(NET_MSG, 'net'); }
    const body = await readBody(res);
    if (!res.ok) throw errorFrom(res, body);
    return body.json ?? body.text;
  }
  async function viaProvider(type, url, opts = {}) {
    const p = window.PDCloud?.providers?.[type];
    if (!p?.connected) throw new SendError('Connect your account first.', 'auth');
    let res;
    try { res = await p.api(url, opts); } catch (e) { if (e.code === 'auth') throw new SendError('Your sign-in has expired. Connect again to continue.', 'auth'); throw new SendError(NET_MSG, 'net'); }
    const body = await readBody(res);
    if (!res.ok) throw errorFrom(res, body);
    return body.json ?? body.text;
  }
  const GRAPH = 'https://graph.microsoft.com/v1.0';
  const ms = (path, opts) => viaProvider('microsoft', path.startsWith('http') ? path : GRAPH + path, opts);
  const goog = (url, opts) => viaProvider('google', url, opts);
  const jsonOpts = (method, body, headers = {}) => ({ method, headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const sleep = (ms2) => new Promise((r) => setTimeout(r, ms2));
  const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => ((Math.random() * 16) | (c === 'y' ? 8 : 0)).toString(16)));
  const details = (it, { tasks = false } = {}) => [it.text.trim(), tasks ? it.tasks.map((t) => `${t.done ? '[x]' : '[ ]'} ${t.title}`).join('\n') : '', it.url, it.location ? `Location: ${it.location}` : ''].filter(Boolean).join('\n\n');
  const localISO = (it) => (it.dueDate ? new Date(`${it.dueDate}T${it.dueTime || '00:00'}:00`).toISOString() : '');
  const blobOf = (a) => new Blob([F.dataUrlBytes(a.dataUrl)], { type: a.mime });
  const groupsOf = (items, combine) => (combine ? [items] : items.map((i) => [i]));
  const combinedTitle = (items, ctx) => ctx.title || `${ctx.desk || 'PaperDesk'} — ${new Date().toLocaleDateString()}`;
  /** Runs `fn` for each item, collecting per-item results and stopping on auth/network errors. */
  async function each(items, ctx, fn) {
    const out = [];
    for (let i = 0; i < items.length; i++) {
      ctx.progress?.(i, items.length);
      try { out.push({ title: items[i].title, ok: true, ...(await fn(items[i], i) || {}) }); }
      catch (e) { out.push({ title: items[i].title, ok: false, error: e.message, code: e.code }); if (e.code === 'auth' || e.code === 'net') { for (const rest of items.slice(i + 1)) out.push({ title: rest.title, ok: false, error: 'Not sent', code: 'skipped' }); break; } }
    }
    ctx.progress?.(items.length, items.length);
    return out;
  }
  const pick = (arr, value, label) => (arr || []).map((x) => ({ value: String(typeof value === 'function' ? value(x) : x[value]), label: typeof label === 'function' ? label(x) : x[label] }));

  const COMBINE = { key: 'combine', label: 'How to send', type: 'choice', def: 'each', choices: [['each', 'One per note'], ['one', 'All notes together']] };
  const SPLIT = { key: 'split', label: 'Checklist items', type: 'choice', def: 'steps', choices: [['steps', 'Keep inside each task'], ['tasks', 'Make each item its own task']] };
  const TAGS = { key: 'tags', label: 'Badges', type: 'choice', def: 'off', choices: [['off', 'Leave out'], ['on', 'Add as labels / tags']] };

  /* ================================================================ Microsoft */
  const C = {};
  C.onenote = {
    name: 'OneNote', auth: 'microsoft', scopes: ['Notes.Create'],
    steps: ['Connect your Microsoft account. PaperDesk asks only to create pages and see notebook names.', 'Choose a notebook and section.'],
    fields: [
      { key: 'notebook', label: 'Notebook', type: 'picker', load: async () => pick((await ms('/me/onenote/notebooks?$select=id,displayName&$orderby=displayName')).value, 'id', 'displayName') },
      { key: 'section', label: 'Section', type: 'picker', deps: ['notebook'], empty: 'Default section', load: async (cfg) => pick((await ms(`/me/onenote/notebooks/${cfg.notebook}/sections?$select=id,displayName`)).value, 'id', 'displayName') },
    ],
    options: [{ ...COMBINE, choices: [['each', 'One page per note'], ['one', 'One page with all notes']] }],
    async send(items, cfg, ctx) {
      const url = cfg.section ? `/me/onenote/sections/${cfg.section}/pages` : '/me/onenote/pages';
      const groups = groupsOf(items, ctx.opts.combine === 'one');
      return each(groups.map((g) => ({ title: g.length > 1 ? combinedTitle(g, ctx) : g[0].title, g })), ctx, async ({ title, g }) => {
        let n = 0; const parts = [];
        const withParts = g.map((it) => ({ ...it, attachments: it.attachments.map((a) => { const part = `p${++n}`; parts.push({ part, a }); return { ...a, part }; }) }));
        const body = withParts.map((it) => F.itemHtml(it, { flavor: 'onenote', images: 'parts', level: g.length > 1 ? 2 : 0 })).join('\n<br/>\n');
        const html = `<!DOCTYPE html><html><head><title>${F.esc(title)}</title><meta name="created" content="${new Date().toISOString()}"/></head><body>${body}</body></html>`;
        let res;
        if (!parts.length) res = await ms(url, { method: 'POST', headers: { 'Content-Type': 'text/html' }, body: html });
        else {
          const fd = new FormData();
          fd.append('Presentation', new Blob([html], { type: 'text/html' }));
          for (const { part, a } of parts) fd.append(part, blobOf(a), a.name);
          res = await ms(url, { method: 'POST', body: fd });
        }
        return { url: res?.links?.oneNoteWebUrl?.href || '' };
      });
    },
  };

  C.mstodo = {
    name: 'Microsoft To Do', auth: 'microsoft', scopes: ['Tasks.ReadWrite'],
    steps: ['Connect your Microsoft account. PaperDesk asks to read and create your tasks.', 'Choose a list, or let PaperDesk make one called "PaperDesk".'],
    fields: [{ key: 'list', label: 'List', type: 'picker', load: async () => [{ value: '__new', label: 'New list: PaperDesk' }, ...pick((await ms('/me/todo/lists')).value, 'id', 'displayName')] }],
    options: [SPLIT],
    async send(items, cfg, ctx) {
      let list = cfg.list;
      if (!list || list === '__new') {
        const lists = (await ms('/me/todo/lists')).value || [];
        list = lists.find((l) => l.displayName === 'PaperDesk')?.id || (await ms('/me/todo/lists', jsonOpts('POST', { displayName: 'PaperDesk' }))).id;
      }
      const make = async (title, it, { body = '', done = false, withDue = true } = {}) => {
        const t = { title: title.slice(0, 255), status: done ? 'completed' : 'notStarted', importance: it.priority === 'high' ? 'high' : 'normal' };
        if (body) t.body = { content: body, contentType: 'text' };
        if (withDue && it.dueDate) {
          t.dueDateTime = { dateTime: `${it.dueDate}T00:00:00`, timeZone: 'UTC' };
          if (it.dueTime) { t.isReminderOn = true; t.reminderDateTime = { dateTime: localISO(it).replace('Z', ''), timeZone: 'UTC' }; }
        }
        return ms(`/me/todo/lists/${list}/tasks`, jsonOpts('POST', t));
      };
      return each(items, ctx, async (it) => {
        if (ctx.opts.split === 'tasks' && it.tasks.length) {
          for (const s of it.tasks) await make(s.title, it, { body: `From "${it.title}"`, done: s.done });
          return { note: `${it.tasks.length} tasks` };
        }
        const task = await make(it.title, it, { body: details(it), done: it.done });
        for (const s of it.tasks) await ms(`/me/todo/lists/${list}/tasks/${task.id}/checklistItems`, jsonOpts('POST', { displayName: s.title.slice(0, 255), isChecked: s.done }));
        return { note: it.tasks.length ? `${it.tasks.length} steps` : '' };
      }).then((r) => { r.open = { url: 'https://to-do.live.com/tasks/', label: 'Open Microsoft To Do' }; return r; });
    },
  };

  C.planner = {
    name: 'Planner', auth: 'microsoft', scopes: ['Tasks.ReadWrite'], note: 'Works with Microsoft 365 work or school accounts. Personal accounts have no Planner.',
    steps: ['Connect the Microsoft 365 account that has your plans.', 'Choose a plan and a bucket.'],
    fields: [
      { key: 'plan', label: 'Plan', type: 'picker', load: async () => pick((await ms('/me/planner/plans')).value, 'id', 'title') },
      { key: 'bucket', label: 'Bucket', type: 'picker', deps: ['plan'], empty: 'No bucket', load: async (cfg) => pick((await ms(`/planner/plans/${cfg.plan}/buckets`)).value, 'id', 'name') },
    ],
    async send(items, cfg, ctx) {
      if (!cfg.plan) throw new SendError('Choose a plan first.', 'config');
      return each(items, ctx, async (it) => {
        const t = { planId: cfg.plan, title: it.title.slice(0, 255), priority: it.priority === 'high' ? 1 : it.priority === 'medium' ? 3 : 5, percentComplete: it.done ? 100 : 0 };
        if (cfg.bucket) t.bucketId = cfg.bucket;
        if (it.dueDate) t.dueDateTime = `${it.dueDate}T12:00:00Z`;
        const task = await ms('/planner/tasks', jsonOpts('POST', t));
        const desc = details(it);
        if (desc || it.tasks.length) {
          let det; for (let k = 0; k < 3; k++) { try { det = await ms(`/planner/tasks/${task.id}/details`); break; } catch (e) { if (k === 2) throw e; await sleep(800); } }
          const checklist = {}; it.tasks.slice(0, 20).forEach((s) => { checklist[uuid()] = { '@odata.type': 'microsoft.graph.plannerChecklistItem', title: s.title.slice(0, 100), isChecked: s.done }; });
          await ms(`/planner/tasks/${task.id}/details`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'If-Match': det['@odata.etag'] }, body: JSON.stringify({ description: desc, ...(it.tasks.length ? { checklist, previewType: 'checklist' } : {}) }) });
        }
        return {};
      });
    },
  };

  /* ================================================================ Google */
  const GT = 'https://tasks.googleapis.com/tasks/v1';
  C.gtasks = {
    name: 'Google Tasks', auth: 'google', scopes: ['https://www.googleapis.com/auth/tasks'],
    steps: ['Connect your Google account. PaperDesk asks to manage your Google Tasks.', 'Choose a task list.'],
    fields: [{ key: 'list', label: 'Task list', type: 'picker', load: async () => pick((await goog(`${GT}/users/@me/lists?maxResults=100`)).items, 'id', 'title') }],
    options: [SPLIT],
    async send(items, cfg, ctx) {
      const list = cfg.list || '@default';
      const add = (body, q = '') => goog(`${GT}/lists/${encodeURIComponent(list)}/tasks${q}`, jsonOpts('POST', body));
      return each(items, ctx, async (it) => {
        const base = (title, notes, done) => ({ title: title.slice(0, 1024), ...(notes ? { notes: notes.slice(0, 8000) } : {}), ...(it.dueDate ? { due: `${it.dueDate}T00:00:00.000Z` } : {}), status: done ? 'completed' : 'needsAction' });
        if (ctx.opts.split === 'tasks' && it.tasks.length) { for (const s of [...it.tasks].reverse()) await add(base(s.title, `From "${it.title}"`, s.done)); return { note: `${it.tasks.length} tasks` }; }
        const t = await add(base(it.title, details(it), it.done));
        let prev = '';
        for (const s of it.tasks) { const st = await add(base(s.title, '', s.done), `?parent=${t.id}${prev ? `&previous=${prev}` : ''}`); prev = st.id; }
        return { url: t.webViewLink || '' };
      }).then((r) => { r.open = { url: 'https://tasks.google.com/', label: 'Open Google Tasks' }; return r; });
    },
  };

  C.gdocs = {
    name: 'Google Docs', auth: 'google', scopes: ['https://www.googleapis.com/auth/drive.file'],
    steps: ['Connect your Google account. PaperDesk asks only to create files it can see itself, nothing else in your Drive.'],
    fields: [{ key: 'name', label: 'Document name', type: 'text', placeholder: 'Leave empty to use the desk name and date' }],
    options: [{ ...COMBINE, def: 'one', choices: [['one', 'One document with all notes'], ['each', 'One document per note']] }],
    async send(items, cfg, ctx) {
      const groups = groupsOf(items, ctx.opts.combine !== 'each');
      return each(groups.map((g) => ({ title: g.length > 1 ? (cfg.name || combinedTitle(g, ctx)) : g[0].title, g })), ctx, async ({ title, g }) => {
        const html = F.toHtml(g, { standalone: true, title: g.length > 1 ? title : '' });
        const boundary = 'pd' + Math.random().toString(36).slice(2);
        const body = `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify({ name: title, mimeType: 'application/vnd.google-apps.document' })}\r\n--${boundary}\r\nContent-Type: text/html; charset=UTF-8\r\n\r\n${html}\r\n--${boundary}--`;
        const f = await goog('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,webViewLink', { method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body });
        return { url: f.webViewLink || `https://docs.google.com/document/d/${f.id}/edit` };
      });
    },
  };

  /* ================================================================ Token-based tools */
  const TD = 'https://api.todoist.com/api/v1';
  const tdH = (cfg) => ({ Authorization: `Bearer ${cfg.token}` });
  const listOf = (j) => (Array.isArray(j) ? j : j?.results || j?.items || []);
  C.todoist = {
    name: 'Todoist', auth: 'token',
    steps: ['In Todoist open Settings → Integrations → Developer and copy your API token.', 'Paste it below. It stays on this device.'],
    fields: [
      { key: 'token', label: 'API token', type: 'password', required: true },
      { key: 'project', label: 'Project', type: 'picker', deps: ['token'], empty: 'Inbox', load: async (cfg) => pick(listOf(await http(`${TD}/projects?limit=200`, { headers: tdH(cfg) })), 'id', 'name') },
    ],
    options: [TAGS],
    async send(items, cfg, ctx) {
      const add = (body) => http(`${TD}/tasks`, jsonOpts('POST', body, tdH(cfg)));
      return each(items, ctx, async (it) => {
        const body = { content: it.title.slice(0, 500), description: details(it), priority: it.priority === 'high' ? 4 : it.priority === 'medium' ? 3 : 1 };
        if (cfg.project) body.project_id = cfg.project;
        if (it.dueTime) body.due_datetime = localISO(it); else if (it.dueDate) body.due_date = it.dueDate;
        if (ctx.opts.tags === 'on' && it.tags.length) body.labels = it.tags.map((t) => t.replace(/\s+/g, '_'));
        const t = await add(body);
        for (const s of it.tasks) {
          const st = await add({ content: s.title.slice(0, 500), parent_id: t.id, ...(cfg.project ? { project_id: cfg.project } : {}) });
          if (s.done) await http(`${TD}/tasks/${st.id}/close`, { method: 'POST', headers: tdH(cfg) });
        }
        return { url: t.url || `https://app.todoist.com/app/task/${t.id}` };
      });
    },
  };

  const TR = 'https://api.trello.com/1';
  const trQ = (cfg, extra = {}) => new URLSearchParams({ key: cfg.key, token: cfg.token, ...extra }).toString();
  C.trello = {
    name: 'Trello', auth: 'token',
    steps: [
      'Open trello.com/power-ups/admin, create a Power-Up for your workspace (any name, e.g. PaperDesk), then open its API key tab and generate a key.',
      'Paste the key below, then press "Get token" and approve. Copy the token Trello shows and paste it below.',
    ],
    fields: [
      { key: 'key', label: 'API key', type: 'text', required: true },
      { key: 'token', label: 'Token', type: 'password', required: true, action: { label: 'Get token', href: (cfg) => cfg.key ? `https://trello.com/1/authorize?expiration=never&name=PaperDesk&scope=read,write&response_type=token&key=${encodeURIComponent(cfg.key)}` : '' } },
      { key: 'board', label: 'Board', type: 'picker', deps: ['key', 'token'], load: async (cfg) => pick(await http(`${TR}/members/me/boards?${trQ(cfg, { fields: 'name', filter: 'open' })}`), 'id', 'name') },
      { key: 'list', label: 'List', type: 'picker', deps: ['board'], load: async (cfg) => pick(await http(`${TR}/boards/${cfg.board}/lists?${trQ(cfg, { fields: 'name', filter: 'open' })}`), 'id', 'name') },
    ],
    async send(items, cfg, ctx) {
      if (!cfg.list) throw new SendError('Choose a list first.', 'config');
      return each(items, ctx, async (it) => {
        const card = await http(`${TR}/cards?${trQ(cfg)}`, jsonOpts('POST', { idList: cfg.list, name: it.title.slice(0, 16384), desc: details(it), pos: 'bottom', ...(it.dueDate ? { due: localISO(it) || `${it.dueDate}T12:00:00Z` } : {}) }));
        if (it.tasks.length) {
          const cl = await http(`${TR}/checklists?${trQ(cfg)}`, jsonOpts('POST', { idCard: card.id, name: 'Checklist' }));
          for (const s of it.tasks) await http(`${TR}/checklists/${cl.id}/checkItems?${trQ(cfg)}`, jsonOpts('POST', { name: s.title, checked: s.done }));
        }
        if (it.url) await http(`${TR}/cards/${card.id}/attachments?${trQ(cfg)}`, jsonOpts('POST', { url: it.url }));
        for (const a of it.attachments) { const fd = new FormData(); fd.append('file', blobOf(a), a.name); fd.append('name', a.name); await http(`${TR}/cards/${card.id}/attachments?${trQ(cfg)}`, { method: 'POST', body: fd }); }
        return { url: card.shortUrl || card.url };
      });
    },
  };

  const NO = 'https://api.notion.com/v1';
  const noH = (cfg) => ({ Authorization: `Bearer ${cfg.token}`, 'Notion-Version': '2022-06-28' });
  const rt = (s) => F.splitText(String(s), 1900).map((c) => ({ type: 'text', text: { content: c } }));
  const titleOfNotion = (x) => {
    if (x.object === 'database') return (x.title || []).map((t) => t.plain_text).join('') || 'Untitled database';
    const p = Object.values(x.properties || {}).find((v) => v.type === 'title');
    return (p?.title || []).map((t) => t.plain_text).join('') || 'Untitled page';
  };
  function notionBlocks(it, { heading = false } = {}) {
    const b = [];
    if (heading) b.push({ object: 'block', type: 'heading_2', heading_2: { rich_text: rt(it.title) } });
    const meta = [it.due ? `Due ${it.due.replace('T', ' ')}` : '', it.location ? `At ${it.location}` : '', it.tags.length ? it.tags.join(', ') : ''].filter(Boolean).join(' · ');
    if (meta) b.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: meta }, annotations: { italic: true, color: 'gray' } }] } });
    for (const para of it.text.trim() ? it.text.trim().split(/\n{2,}/) : []) b.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: rt(para) } });
    for (const s of it.tasks) b.push({ object: 'block', type: 'to_do', to_do: { rich_text: rt(s.title), checked: s.done } });
    if (it.url) b.push({ object: 'block', type: 'bookmark', bookmark: { url: it.url } });
    for (const a of it.attachments) b.push({ object: 'block', type: 'paragraph', paragraph: { rich_text: [{ type: 'text', text: { content: `Attachment not uploaded: ${a.name}` }, annotations: { italic: true, color: 'gray' } }] } });
    return b;
  }
  C.notion = {
    name: 'Notion', auth: 'token',
    steps: [
      'Open notion.so/profile/integrations, create a new internal integration for your workspace and copy its secret.',
      'In Notion, open the page or database that should receive the notes, choose ⋯ → Connections, and add your integration.',
      'Paste the secret below and choose that page or database.',
    ],
    fields: [
      { key: 'token', label: 'Integration secret', type: 'password', required: true },
      { key: 'target', label: 'Page or database', type: 'picker', deps: ['token'], load: async (cfg) => {
        const j = await http(`${NO}/search`, jsonOpts('POST', { page_size: 100, sort: { direction: 'descending', timestamp: 'last_edited_time' } }, noH(cfg)));
        return (j.results || []).filter((x) => x.object === 'database' || x.parent?.type !== 'database_id').map((x) => ({ value: `${x.object === 'database' ? 'db' : 'page'}:${x.id}`, label: `${x.object === 'database' ? '▦ ' : ''}${titleOfNotion(x)}` }));
      } },
    ],
    options: [{ ...COMBINE, choices: [['each', 'One page per note'], ['one', 'One page with all notes']] }],
    async send(items, cfg, ctx) {
      if (!cfg.target) throw new SendError('Choose a page or database first.', 'config');
      const [kind, id] = cfg.target.split(':');
      let props = null;
      if (kind === 'db') {
        const db = await http(`${NO}/databases/${id}`, { headers: noH(cfg) });
        const by = (type) => Object.entries(db.properties || {}).find(([, v]) => v.type === type)?.[0];
        props = { title: by('title'), date: by('date'), tags: by('multi_select'), url: by('url'), done: by('checkbox') };
      }
      const create = async (title, blocks, it) => {
        const body = { parent: kind === 'db' ? { database_id: id } : { page_id: id }, properties: {} };
        if (kind === 'db') {
          body.properties[props.title] = { title: rt(title) };
          if (it && props.date && it.dueDate) body.properties[props.date] = { date: { start: it.dueTime ? localISO(it) : it.dueDate } };
          if (it && props.tags && it.tags.length) body.properties[props.tags] = { multi_select: it.tags.map((name) => ({ name: name.replace(/,/g, ' ') })) };
          if (it && props.url && it.url) body.properties[props.url] = { url: it.url };
          if (it && props.done) body.properties[props.done] = { checkbox: !!it.done };
        } else body.properties.title = { title: rt(title) };
        body.children = blocks.slice(0, 100);
        const page = await http(`${NO}/pages`, jsonOpts('POST', body, noH(cfg)));
        for (let i = 100; i < blocks.length; i += 100) await http(`${NO}/blocks/${page.id}/children`, jsonOpts('PATCH', { children: blocks.slice(i, i + 100) }, noH(cfg)));
        return { url: page.url };
      };
      if (ctx.opts.combine === 'one') {
        const title = combinedTitle(items, ctx);
        return each([{ title }], ctx, () => create(title, items.flatMap((it) => notionBlocks(it, { heading: true })), null));
      }
      return each(items, ctx, (it) => create(it.title, notionBlocks(it), it));
    },
  };

  const AS = 'https://app.asana.com/api/1.0';
  const asH = (cfg) => ({ Authorization: `Bearer ${cfg.token}` });
  C.asana = {
    name: 'Asana', auth: 'token',
    steps: ['Open app.asana.com/0/my-apps, create a personal access token and copy it.', 'Paste it below and choose the workspace and project.'],
    fields: [
      { key: 'token', label: 'Personal access token', type: 'password', required: true },
      { key: 'workspace', label: 'Workspace', type: 'picker', deps: ['token'], load: async (cfg) => pick((await http(`${AS}/workspaces?limit=100`, { headers: asH(cfg) })).data, 'gid', 'name') },
      { key: 'project', label: 'Project', type: 'picker', deps: ['workspace'], empty: 'My Tasks', load: async (cfg) => pick((await http(`${AS}/projects?workspace=${cfg.workspace}&archived=false&limit=100`, { headers: asH(cfg) })).data, 'gid', 'name') },
    ],
    async send(items, cfg, ctx) {
      if (!cfg.workspace) throw new SendError('Choose a workspace first.', 'config');
      return each(items, ctx, async (it) => {
        const data = { name: it.title, notes: details(it), workspace: cfg.workspace, completed: it.done };
        if (cfg.project) data.projects = [cfg.project]; else data.assignee = 'me';
        if (it.dueTime) data.due_at = localISO(it); else if (it.dueDate) data.due_on = it.dueDate;
        const t = (await http(`${AS}/tasks?opt_fields=permalink_url`, jsonOpts('POST', { data }, asH(cfg)))).data;
        for (const s of it.tasks) await http(`${AS}/tasks/${t.gid}/subtasks`, jsonOpts('POST', { data: { name: s.title, completed: s.done } }, asH(cfg)));
        return { url: t.permalink_url };
      });
    },
  };

  const LIN = 'https://api.linear.app/graphql';
  const gql = (cfg, query, variables) => http(LIN, jsonOpts('POST', { query, variables }, { Authorization: cfg.token })).then((j) => { if (j.errors?.length) throw new SendError(j.errors[0].message, 'http'); return j.data; });
  C.linear = {
    name: 'Linear', auth: 'token',
    steps: ['In Linear open Settings → Security & access → Personal API keys, create a key and copy it.', 'Paste it below and choose the team.'],
    fields: [
      { key: 'token', label: 'API key', type: 'password', required: true },
      { key: 'team', label: 'Team', type: 'picker', deps: ['token'], load: async (cfg) => pick((await gql(cfg, '{ teams(first: 100) { nodes { id name key } } }')).teams.nodes, 'id', (t) => `${t.name} (${t.key})`) },
    ],
    async send(items, cfg, ctx) {
      if (!cfg.team) throw new SendError('Choose a team first.', 'config');
      return each(items, ctx, async (it) => {
        const input = { teamId: cfg.team, title: it.title, description: [it.text.trim(), it.tasks.map((s) => `- [${s.done ? 'x' : ' '}] ${s.title}`).join('\n'), it.url].filter(Boolean).join('\n\n'), priority: it.priority === 'high' ? 2 : it.priority === 'medium' ? 3 : 0 };
        if (it.dueDate) input.dueDate = it.dueDate;
        const d = await gql(cfg, 'mutation($input: IssueCreateInput!) { issueCreate(input: $input) { success issue { url identifier } } }', { input });
        return { url: d.issueCreate.issue?.url, note: d.issueCreate.issue?.identifier };
      });
    },
  };

  C.github = {
    name: 'GitHub Issues', auth: 'token',
    steps: ['On GitHub open Settings → Developer settings → Personal access tokens → Fine-grained tokens.', 'Create a token for the repository with "Issues: Read and write", copy it and paste it below.'],
    fields: [
      { key: 'token', label: 'Token', type: 'password', required: true },
      { key: 'repo', label: 'Repository', type: 'picker', deps: ['token'], load: async (cfg) => pick(await http('https://api.github.com/user/repos?per_page=100&sort=updated', { headers: { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' } }), 'full_name', 'full_name') },
    ],
    options: [TAGS],
    async send(items, cfg, ctx) {
      if (!cfg.repo) throw new SendError('Choose a repository first.', 'config');
      return each(items, ctx, async (it) => {
        const body = { title: it.title, body: F.itemMarkdown(it, { level: 0 }) };
        if (ctx.opts.tags === 'on' && it.tags.length) body.labels = it.tags;
        const r = await http(`https://api.github.com/repos/${cfg.repo}/issues`, jsonOpts('POST', body, { Authorization: `Bearer ${cfg.token}`, Accept: 'application/vnd.github+json' }));
        return { url: r.html_url, note: `#${r.number}` };
      });
    },
  };

  const glBase = (cfg) => `${(cfg.host || 'https://gitlab.com').replace(/\/+$/, '')}/api/v4`;
  C.gitlab = {
    name: 'GitLab Issues', auth: 'token',
    steps: ['In GitLab open Preferences → Access tokens, create a token with the "api" scope and copy it.', 'Paste it below. For your own GitLab server, change the address.'],
    fields: [
      { key: 'host', label: 'GitLab address', type: 'url', placeholder: 'https://gitlab.com' },
      { key: 'token', label: 'Access token', type: 'password', required: true },
      { key: 'project', label: 'Project', type: 'picker', deps: ['token'], load: async (cfg) => pick(await http(`${glBase(cfg)}/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at`, { headers: { Authorization: `Bearer ${cfg.token}` } }), 'id', 'path_with_namespace') },
    ],
    options: [TAGS],
    async send(items, cfg, ctx) {
      if (!cfg.project) throw new SendError('Choose a project first.', 'config');
      return each(items, ctx, async (it) => {
        const body = { title: it.title, description: F.itemMarkdown(it, { level: 0 }) };
        if (it.dueDate) body.due_date = it.dueDate;
        if (ctx.opts.tags === 'on' && it.tags.length) body.labels = it.tags.join(',');
        const r = await http(`${glBase(cfg)}/projects/${encodeURIComponent(cfg.project)}/issues`, jsonOpts('POST', body, { Authorization: `Bearer ${cfg.token}` }));
        return { url: r.web_url, note: `#${r.iid}` };
      });
    },
  };

  const CU = 'https://api.clickup.com/api/v2';
  const cuH = (cfg) => ({ Authorization: cfg.token });
  C.clickup = {
    name: 'ClickUp', auth: 'token', beta: true, note: 'ClickUp does not always answer web apps. If sending fails, use the CSV route or an automation service.',
    steps: ['In ClickUp open your avatar → Settings → Apps and generate a personal API token (starts with pk_).', 'Paste it below and choose the list.'],
    fields: [
      { key: 'token', label: 'API token', type: 'password', required: true },
      { key: 'list', label: 'List', type: 'picker', deps: ['token'], load: async (cfg) => {
        const out = [];
        for (const team of (await http(`${CU}/team`, { headers: cuH(cfg) })).teams || []) {
          for (const space of (await http(`${CU}/team/${team.id}/space?archived=false`, { headers: cuH(cfg) })).spaces || []) {
            for (const l of (await http(`${CU}/space/${space.id}/list?archived=false`, { headers: cuH(cfg) })).lists || []) out.push({ value: l.id, label: `${space.name} / ${l.name}` });
            for (const f of (await http(`${CU}/space/${space.id}/folder?archived=false`, { headers: cuH(cfg) })).folders || []) for (const l of f.lists || []) out.push({ value: l.id, label: `${space.name} / ${f.name} / ${l.name}` });
          }
        }
        return out;
      } },
    ],
    async send(items, cfg, ctx) {
      if (!cfg.list) throw new SendError('Choose a list first.', 'config');
      return each(items, ctx, async (it) => {
        const body = { name: it.title, markdown_description: [it.text.trim(), it.url].filter(Boolean).join('\n\n'), ...(it.priority ? { priority: it.priority === 'high' ? 1 : 2 } : {}) };
        if (it.dueDate) { body.due_date = new Date(`${it.dueDate}T${it.dueTime || '12:00'}:00`).getTime(); body.due_date_time = !!it.dueTime; }
        const t = await http(`${CU}/list/${cfg.list}/task`, jsonOpts('POST', body, cuH(cfg)));
        if (it.tasks.length) {
          const cl = (await http(`${CU}/task/${t.id}/checklist`, jsonOpts('POST', { name: 'Checklist' }, cuH(cfg)))).checklist;
          for (const s of it.tasks) await http(`${CU}/checklist/${cl.id}/checklist_item`, jsonOpts('POST', { name: s.title, resolved: s.done }, cuH(cfg)));
        }
        return { url: t.url };
      });
    },
  };

  const MO = 'https://api.monday.com/v2';
  const mo = (cfg, query, variables) => http(MO, jsonOpts('POST', { query, variables }, { Authorization: cfg.token })).then((j) => { if (j.errors?.length || j.error_message) throw new SendError(j.errors?.[0]?.message || j.error_message, 'http'); return j.data; });
  C.monday = {
    name: 'monday.com', auth: 'token', beta: true, note: 'monday.com does not always answer web apps. If sending fails, use the CSV route or an automation service.',
    steps: ['In monday.com open your avatar → Developers → My access tokens, and copy the token.', 'Paste it below and choose the board.'],
    fields: [
      { key: 'token', label: 'Access token', type: 'password', required: true },
      { key: 'board', label: 'Board', type: 'picker', deps: ['token'], load: async (cfg) => pick((await mo(cfg, '{ boards(limit: 100, state: active) { id name } }')).boards, 'id', 'name') },
    ],
    async send(items, cfg, ctx) {
      if (!cfg.board) throw new SendError('Choose a board first.', 'config');
      return each(items, ctx, async (it) => {
        const item = (await mo(cfg, 'mutation($b: ID!, $n: String!) { create_item(board_id: $b, item_name: $n) { id } }', { b: cfg.board, n: it.title.slice(0, 255) })).create_item;
        const html = F.itemHtml({ ...it, attachments: [] }, { level: 0 });
        if (html.trim()) await mo(cfg, 'mutation($i: ID!, $body: String!) { create_update(item_id: $i, body: $body) { id } }', { i: item.id, body: html });
        for (const s of it.tasks) await mo(cfg, 'mutation($p: ID!, $n: String!) { create_subitem(parent_item_id: $p, item_name: $n) { id } }', { p: item.id, n: s.title.slice(0, 255) });
        return {};
      });
    },
  };

  const AT = 'https://api.airtable.com/v0';
  const atH = (cfg) => ({ Authorization: `Bearer ${cfg.token}` });
  C.airtable = {
    name: 'Airtable', auth: 'token',
    steps: ['Open airtable.com/create/tokens and create a token with the scopes data.records:write and schema.bases:read, and access to your base.', 'Paste it below and choose the base and table. PaperDesk fills the first matching fields: name, long text, date, multiple select, URL and checkbox.'],
    fields: [
      { key: 'token', label: 'Personal access token', type: 'password', required: true },
      { key: 'base', label: 'Base', type: 'picker', deps: ['token'], load: async (cfg) => pick((await http(`${AT}/meta/bases`, { headers: atH(cfg) })).bases, 'id', 'name') },
      { key: 'table', label: 'Table', type: 'picker', deps: ['base'], load: async (cfg) => pick((await http(`${AT}/meta/bases/${cfg.base}/tables`, { headers: atH(cfg) })).tables, 'id', 'name') },
    ],
    async send(items, cfg, ctx) {
      if (!cfg.table) throw new SendError('Choose a table first.', 'config');
      const table = ((await http(`${AT}/meta/bases/${cfg.base}/tables`, { headers: atH(cfg) })).tables || []).find((t) => t.id === cfg.table);
      if (!table) throw new SendError('That table was not found.', 'config');
      const fields = table.fields || [];
      const f = (types) => fields.find((x) => types.includes(x.type))?.name;
      const map = { title: fields.find((x) => x.id === table.primaryFieldId)?.name, text: f(['multilineText', 'richText']), date: f(['date', 'dateTime']), tags: f(['multipleSelects']), url: f(['url']), done: f(['checkbox']) };
      const rec = (it) => {
        const o = {};
        if (map.title) o[map.title] = it.title;
        if (map.text) o[map.text] = details(it, { tasks: true });
        if (map.date && it.dueDate) o[map.date] = it.dueTime ? localISO(it) : it.dueDate;
        if (map.tags && it.tags.length) o[map.tags] = it.tags;
        if (map.url && it.url) o[map.url] = it.url;
        if (map.done) o[map.done] = !!it.done;
        return { fields: o };
      };
      const out = [];
      for (let i = 0; i < items.length; i += 10) {
        const chunk = items.slice(i, i + 10);
        ctx.progress?.(i, items.length);
        try {
          const r = await http(`${AT}/${cfg.base}/${cfg.table}`, jsonOpts('POST', { records: chunk.map(rec), typecast: true }, atH(cfg)));
          (r.records || []).forEach((x, k) => out.push({ title: chunk[k].title, ok: true, url: `https://airtable.com/${cfg.base}/${cfg.table}/${x.id}` }));
        } catch (e) { chunk.forEach((it) => out.push({ title: it.title, ok: false, error: e.message, code: e.code })); if (e.code === 'auth' || e.code === 'net') break; }
      }
      return out;
    },
  };

  C.raindrop = {
    name: 'Raindrop.io', auth: 'token',
    steps: ['Open app.raindrop.io/settings/integrations, create an app (any name), open it and press "Create test token".', 'Paste the token below. Only notes with a web link are saved.'],
    fields: [
      { key: 'token', label: 'Test token', type: 'password', required: true },
      { key: 'collection', label: 'Collection', type: 'picker', deps: ['token'], empty: 'Unsorted', load: async (cfg) => pick((await http('https://api.raindrop.io/rest/v1/collections', { headers: { Authorization: `Bearer ${cfg.token}` } })).items, '_id', 'title') },
    ],
    async send(items, cfg, ctx) {
      const withUrl = items.filter((it) => /^https?:/i.test(it.url));
      const skipped = items.filter((it) => !withUrl.includes(it)).map((it) => ({ title: it.title, ok: false, error: 'No web link in this note', code: 'skipped' }));
      if (!withUrl.length) return skipped;
      const res = await each([{ title: `${withUrl.length} bookmarks` }], ctx, async () => {
        await http('https://api.raindrop.io/rest/v1/raindrops', jsonOpts('POST', { items: withUrl.map((it) => ({ link: it.url, title: it.title, excerpt: it.text.slice(0, 10000), tags: it.tags, pleaseParse: {}, collection: { $id: Number(cfg.collection || -1) } })) }, { Authorization: `Bearer ${cfg.token}` }));
        return { url: 'https://app.raindrop.io/' };
      });
      return [...res, ...skipped];
    },
  };

  /* ================================================================ Chat */
  C.slack = {
    name: 'Slack', auth: 'token',
    steps: ['Create a Slack app at api.slack.com/apps (From scratch), turn on Incoming Webhooks and add a webhook to the channel.', 'Copy the webhook URL (https://hooks.slack.com/services/…) and paste it below.'],
    fields: [{ key: 'url', label: 'Webhook URL', type: 'url', required: true, placeholder: 'https://hooks.slack.com/services/…' }],
    options: [{ ...COMBINE, def: 'one', choices: [['one', 'One message'], ['each', 'One message per note']] }],
    async send(items, cfg, ctx) {
      const mrk = (it) => [`*${it.title}*`, it.text.trim(), ...it.tasks.map((s) => `${s.done ? '☑' : '☐'} ${s.title}`), it.url].filter(Boolean).join('\n');
      const groups = groupsOf(items, ctx.opts.combine !== 'each');
      return each(groups.map((g) => ({ title: g.length > 1 ? `${g.length} notes` : g[0].title, g })), ctx, async ({ g }) => {
        // Form-encoded, so the browser sends it without a pre-flight check.
        await http(cfg.url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ payload: JSON.stringify({ text: g.map(mrk).join('\n\n') }) }) });
        return {};
      });
    },
  };

  C.discord = {
    name: 'Discord', auth: 'token',
    steps: ['In Discord open the channel settings → Integrations → Webhooks → New Webhook, and copy its URL.', 'Paste it below.'],
    fields: [{ key: 'url', label: 'Webhook URL', type: 'url', required: true, placeholder: 'https://discord.com/api/webhooks/…' }],
    async send(items, cfg, ctx) {
      return each(items, ctx, async (it) => {
        const text = [`**${it.title}**`, it.text.trim(), ...it.tasks.map((s) => `${s.done ? '☑' : '☐'} ${s.title}`), it.url].filter(Boolean).join('\n');
        for (const part of F.splitText(text, 1900)) await http(cfg.url, jsonOpts('POST', { content: part, username: 'PaperDesk', allowed_mentions: { parse: [] } }));
        return {};
      });
    },
  };

  C.ntfy = {
    name: 'ntfy', auth: 'token',
    steps: ['Install the ntfy app on your phone (Android or iPhone) and subscribe to a topic with a hard-to-guess name, e.g. paperdesk-7f3k2.', 'Enter the same topic below. Anyone who knows the topic name can read it, so keep it unusual, or use your own ntfy server with a token.'],
    fields: [
      { key: 'server', label: 'Server', type: 'url', placeholder: 'https://ntfy.sh' },
      { key: 'topic', label: 'Topic', type: 'text', required: true },
      { key: 'token', label: 'Access token (optional)', type: 'password' },
    ],
    async send(items, cfg, ctx) {
      const server = (cfg.server || 'https://ntfy.sh').replace(/\/+$/, '');
      return each(items, ctx, async (it) => {
        const msg = { topic: cfg.topic, title: it.title.slice(0, 250), message: F.itemText({ ...it, title: '' }).trim().slice(0, 4000) || it.title, tags: ['memo'], priority: it.priority === 'high' ? 4 : 3 };
        if (it.url) msg.click = it.url;
        await http(server, jsonOpts('POST', msg, cfg.token ? { Authorization: `Bearer ${cfg.token}` } : {}));
        return {};
      });
    },
  };

  /* ================================================================ Webhooks (automation, custom) */
  const TEAMS_TEMPLATE = '{"type":"message","attachments":[{"contentType":"application/vnd.microsoft.card.adaptive","content":{"$schema":"http://adaptivecards.io/schemas/adaptive-card.json","type":"AdaptiveCard","version":"1.4","body":[{"type":"TextBlock","text":{{title|json}},"weight":"Bolder","size":"Medium","wrap":true},{"type":"TextBlock","text":{{plain|json}},"wrap":true}]}}]}';
  /**
   * cfg: { url, method, headers (lines "Name: value"), body: 'standard'|'template', template, contentType, mode: 'batch'|'each' }
   * Standard body = the PaperDesk Send JSON (format, version, items[]).
   */
  async function postHook(cfg, items, all, ctx) {
    const headers = {};
    for (const line of String(cfg.headers || '').split('\n')) { const i = line.indexOf(':'); if (i > 0) headers[line.slice(0, i).trim()] = line.slice(i + 1).trim(); }
    let body, type = 'application/json';
    if (cfg.body === 'template' || cfg.template) {
      body = F.renderTemplate(cfg.template || '', items[0], all);
      type = cfg.contentType || 'application/json';
    } else body = F.toJSON(items, { desk: ctx.desk, withAttachments: !!cfg.attachments, pretty: false });
    const opts = { method: cfg.method || 'POST', headers: { 'Content-Type': type, ...headers }, body };
    try { await http(cfg.url, opts); return { ok: true }; }
    catch (e) {
      if (e.code !== 'net') throw e;
      // The tool did not allow a readable reply. Send again as a "simple" request the browser
      // can deliver without asking; we just cannot see the answer.
      await fetch(cfg.url, { method: 'POST', mode: 'no-cors', headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body }).catch(() => { throw new SendError(NET_MSG, 'net'); });
      return { ok: true, note: 'Sent; the service does not let the browser confirm delivery' };
    }
  }
  C.webhook = {
    name: 'Webhook', auth: 'none',
    async send(items, cfg, ctx) {
      if (!/^https?:\/\//i.test(cfg.url || '')) throw new SendError('Enter the web address (it starts with https://).', 'config');
      const tcfg = { ...cfg, template: cfg.body === 'template' ? cfg.template : cfg.preset === 'teams' ? TEAMS_TEMPLATE : '' };
      if (cfg.mode === 'each' || tcfg.template) return each(items, ctx, (it) => postHook(tcfg, [it], items, ctx));
      return each([{ title: items.length === 1 ? items[0].title : `${items.length} notes in one request` }], ctx, () => postHook(tcfg, items, items, ctx));
    },
  };

  window.PDSendConnectors = { C, http, SendError, TEAMS_TEMPLATE };
})();

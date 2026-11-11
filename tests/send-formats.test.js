const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const zlib = require('node:zlib');
const F = require('../web/send-formats.js');

const ctx = {
  desk: 'Main desk',
  types: { text: { label: 'Text' }, checklist: { label: 'Checklist' }, alarm: { label: 'Reminder' }, calendar: { label: 'Event' }, hyperlink: { label: 'Link' }, screenClip: { label: 'Screen clip' } },
  badges: { urgent: { label: 'Urgent' }, star: { label: 'Star' } },
  inkSvg: () => '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0L5 5"/></svg>',
};
const PNG = 'data:image/png;base64,' + Buffer.from('fake-png-bytes').toString('base64');
const notes = [
  { id: 'c', type: 'calendar', title: 'Release, v2', body: 'All day', x: 0, y: 400, meta: { date: '2026-11-20' } },
  { id: 'a', type: 'text', title: '', body: 'First line becomes the title\nsecond "line", with comma', x: 300, y: 10, badges: ['star'], scribbles: [{ points: [[0, 0], [5, 5]] }] },
  { id: 'b', type: 'checklist', title: 'Launch', x: 0, y: 0, badges: ['urgent'], tasks: [{ title: 'Write post', done: true }, { title: 'Ship it', done: false }] },
  { id: 'd', type: 'alarm', title: 'Call Ana', x: 600, y: 0, meta: { dateIso: '2026-11-12', time24: '9:30' } },
  { id: 'e', type: 'screenClip', title: 'Clip', x: 900, y: 0, url: PNG },
  { id: 'f', type: 'hyperlink', title: 'Docs', x: 900, y: 400, url: 'https://example.com/a?b=1' },
];
const items = F.buildItems(notes, ctx);
const byId = Object.fromEntries(items.map((i) => [i.id, i]));

test('items come out in reading order with derived fields', () => {
  assert.deepEqual(items.map((i) => i.id), ['b', 'a', 'd', 'e', 'c', 'f']);
  assert.equal(byId.a.title, 'First line becomes the title');
  assert.equal(byId.b.priority, 'high');
  assert.deepEqual(byId.b.tags, ['Urgent']);
  assert.equal(byId.d.due, '2026-11-12T09:30');
  assert.equal(byId.c.due, '2026-11-20');
  assert.equal(byId.e.url, '', 'data URLs are attachments, not links');
  assert.equal(byId.e.attachments[0].mime, 'image/png');
  assert.ok(byId.a.attachments[0].name.endsWith('(ink).svg'));
  assert.equal(byId.f.url, 'https://example.com/a?b=1');
});

test('markdown has task lists, meta and links', () => {
  const md = F.toMarkdown(items, { heading: 'Main desk' });
  assert.match(md, /^# Main desk/);
  assert.match(md, /- \[x\] Write post\n- \[ \] Ship it/);
  assert.match(md, /\*Reminder · Due 2026-11-12 09:30\*/);
  assert.match(md, /<https:\/\/example.com\/a\?b=1>/);
});

test('html escapes text and uses the right to-do style per flavor', () => {
  const evil = F.buildItem({ id: 'x', type: 'checklist', title: '<b>x</b>', tasks: [{ title: 'a & b', done: false }] }, ctx);
  const generic = F.toHtml([evil]);
  assert.ok(generic.includes('&lt;b&gt;x&lt;/b&gt;') && generic.includes('☐ a &amp; b'));
  assert.ok(F.toHtml([evil], { flavor: 'onenote' }).includes('<p data-tag="to-do">a &amp; b</p>'));
  assert.ok(F.toHtml([byId.b], { flavor: 'onenote' }).includes('data-tag="to-do:completed"'));
  assert.match(F.toHtml(items, { standalone: true, title: 'T' }), /^<!doctype html>/);
});

test('csv quotes cells, adds a BOM and can split checklist items into rows', () => {
  const csv = F.toCSV(items);
  assert.ok(csv.startsWith('﻿Title,Description'));
  assert.ok(csv.includes('"First line becomes the title\nsecond ""line"", with comma"'));
  const split = F.toCSV([byId.b], { cols: F.CSV_PRESETS.asana.cols, splitTasks: true, bom: false }).trim().split('\r\n');
  assert.equal(split[0], 'Name,Description,Due Date,Tags,Parent');
  assert.equal(split.length, 4);
  assert.ok(split[3].startsWith('Ship it,') && split[3].endsWith(',Launch'));
  const todo = F.toTodoistCSV([byId.b, byId.d]).trim().split('\r\n');
  assert.equal(todo[0].split(',')[0], 'TYPE');
  assert.ok(todo[1].startsWith('task,Launch,,4,1'));
  assert.ok(todo[2].startsWith('task,Ship it,,1,2'), 'done items are skipped, open ones are sub-tasks');
  assert.ok(todo[3].includes('2026-11-12 09:30'));
});

test('md5 matches node crypto', () => {
  for (const s of ['', 'a', 'The quick brown fox jumps over the lazy dog', 'x'.repeat(1000)]) {
    assert.equal(F.md5Hex(new TextEncoder().encode(s)), crypto.createHash('md5').update(s).digest('hex'));
  }
});

test('enex embeds resources with matching hashes and en-todo boxes', () => {
  const x = F.toENEX([byId.b, byId.e]);
  assert.match(x, /<en-export/);
  assert.ok(x.includes('<en-todo checked="true"/>Write post'));
  const hash = crypto.createHash('md5').update('fake-png-bytes').digest('hex');
  assert.ok(x.includes(`hash="${hash}"`));
  assert.ok(x.includes(Buffer.from('fake-png-bytes').toString('base64')));
  assert.ok(!x.includes('<h1>'), 'the title is not repeated inside the note');
});

test('ics has an all-day event, a timed to-do with alarm, and folds long lines', () => {
  const long = F.buildItem({ id: 'l', type: 'alarm', title: 'L'.repeat(200), meta: { dateIso: '2026-11-12', time24: '09:30' } }, ctx);
  const ics = F.toICS([...items, long]);
  assert.ok(ics.includes('BEGIN:VEVENT') && ics.includes('DTSTART;VALUE=DATE:20261120') && ics.includes('DTEND;VALUE=DATE:20261121'));
  assert.ok(ics.includes('DUE:20261112T093000') && ics.includes('BEGIN:VALARM'));
  assert.ok(ics.includes('SUMMARY:Release\\, v2'));
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l) <= 75));
  assert.ok(!ics.includes('First line'), 'undated notes are left out by default');
  const ev = F.toICS(items, { allEvents: true });
  assert.ok(!ev.includes('BEGIN:VTODO') && ev.includes('DTSTART:20261112T093000'), 'calendar apps get events only');
});

test('opml nests body lines and tasks', () => {
  const o = F.toOPML([byId.b, byId.a]);
  assert.ok(o.includes('<outline text="Launch" _note="Checklist · High priority · #Urgent"><outline text="Write post" _complete="true"/>'));
  assert.ok(o.includes('second &quot;line&quot;'));
});

test('json is the documented send format', () => {
  const j = JSON.parse(F.toJSON(items, { desk: 'Main desk', withAttachments: false }));
  assert.equal(j.format, 'paperdesk-send'); assert.equal(j.version, 1); assert.equal(j.items.length, 6);
  assert.equal(j.items.find((i) => i.id === 'e').attachments[0].dataUrl, undefined);
});

test('templates fill fields and apply filters', () => {
  const t = F.renderTemplate('{"name": {{title|json}}, "due": {{due|json}}, "n": {{tasks|json}}}', byId.b, items);
  assert.deepEqual(JSON.parse(t), { name: 'Launch', due: '', n: [{ title: 'Write post', done: true }, { title: 'Ship it', done: false }] });
  assert.equal(F.renderTemplate('x?t={{title|url}}&tags={{tags}}', byId.b), 'x?t=Launch&tags=Urgent');
  assert.equal(F.renderTemplate('{{unknown}} {{count}}', byId.b, items), '{{unknown}} 6');
  assert.equal(F.renderTemplate('{{title|upper|first:3}}', byId.b), 'LAU');
});

test('zip is readable: names, sizes and CRCs line up', () => {
  const files = F.markdownBundle(items, { desk: 'Main desk' });
  assert.ok(files.some((f) => f.name.startsWith('attachments/') && f.name.endsWith('.png')));
  const md = files.find((f) => f.name === 'Launch.md');
  assert.match(md.data, /^---\ntitle: "Launch"\ntags: \["Urgent"\]/);
  const z = Buffer.from(F.zip(files));
  // Walk the local headers and check each entry against the original data.
  let p = 0, n = 0;
  while (z.readUInt32LE(p) === 0x04034b50) {
    const crc = z.readUInt32LE(p + 14), size = z.readUInt32LE(p + 18), nameLen = z.readUInt16LE(p + 26);
    const name = z.subarray(p + 30, p + 30 + nameLen).toString('utf8');
    const data = z.subarray(p + 30 + nameLen, p + 30 + nameLen + size);
    const orig = files.find((f) => f.name === name);
    assert.ok(orig, name);
    assert.equal(data.toString('latin1'), Buffer.from(orig.data).toString('latin1'));
    assert.equal(crc, zlib.crc32 ? zlib.crc32(data) : F.crc32(data));
    p += 30 + nameLen + size; n++;
  }
  assert.equal(n, files.length);
  assert.equal(z.readUInt32LE(z.length - 22), 0x06054b50);
});

test('charts and sketches go out as pictures, and a chart keeps its numbers as text', () => {
  const chart = { id: 'ch', type: 'chart', title: 'Costs', body: 'Monthly', meta: { chart: { type: 'bar', unit: 'EUR', labels: ['Rent', 'Food'], series: [{ name: 'Value', values: [900, 400] }] } } };
  const two = { id: 'c2', type: 'chart', title: 'Two', meta: { chart: { labels: ['Jan'], series: [{ name: 'A', values: [1] }, { name: 'B', values: [2] }] } } };
  const ctx2 = { ...ctx, extraSvg: (n) => (n.type === 'chart' ? '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>' : '') };
  const [a, b] = F.buildItems([chart, two], ctx2);
  assert.equal(a.text, 'Monthly\n\nRent: 900 EUR\nFood: 400 EUR');
  assert.equal(b.text, 'Jan: A 1, B 2');
  assert.equal(a.attachments.length, 1);
  assert.ok(a.attachments[0].ink && a.attachments[0].name === 'Costs.svg');
  assert.equal(F.buildItem({ id: 't', type: 'text', body: 'x' }, ctx2).attachments.length, 0);
});

test('mailto stays under the limit and says when it cut the text', () => {
  const short = F.mailtoUrl({ to: 'me@onenote.com', subject: 'Hi', body: 'x' });
  assert.equal(short.truncated, false); assert.ok(short.url.startsWith('mailto:me@onenote.com?subject=Hi'));
  assert.ok(F.mailtoUrl({ to: 'board+abc@boards.trello.com' }).url.startsWith('mailto:board+abc@boards.trello.com?'));
  const long = F.mailtoUrl({ to: 'a@b.c', subject: 's', body: 'é '.repeat(3000) });
  assert.ok(long.truncated && long.url.length <= 1900);
  assert.deepEqual(F.splitText('aaa bbb ccc', 5), ['aaa', 'bbb', 'ccc']);
});

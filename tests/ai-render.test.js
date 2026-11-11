const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../web/ai-render.js');

test('parseJSON reads fenced, wrapped, trailing-comma and cut-off output', () => {
  assert.deepEqual(R.parseJSON('```json\n{"a":1}\n```'), { a: 1 });
  assert.deepEqual(R.parseJSON('<think>hmm</think>Here you go: {"tasks":["x","y",],} thanks'), { tasks: ['x', 'y'] });
  assert.deepEqual(R.parseJSON('{"title":"Trip","tasks":["Pack","Book hot'), { title: 'Trip', tasks: ['Pack', 'Book hot'] });
  assert.deepEqual(R.parseJSON('{title: "x", n: 2}'), { title: 'x', n: 2 });
  assert.equal(R.parseJSON('no json here'), null);
  assert.equal(R.cleanText('<think>a</think>\n"Short title"'), 'Short title');
});

test('schemas become a compact-JSON grammar with bounded lists', () => {
  const g = R.schemaToGrammar({ type: 'object', properties: { title: { type: 'string' }, kind: { type: 'string', enum: ['a', 'b'] }, tasks: { type: 'array', maxItems: 5, items: { type: 'string' } }, xyz: { type: 'array', minItems: 3, maxItems: 3, items: { type: 'number' } }, done: { type: 'boolean' } }, required: ['title', 'tasks'] });
  assert.match(g, /^root ::= obj$/m);
  assert.match(g, /^obj ::= "\{" "\\"title\\":" str "," "\\"tasks\\":" obj_tasks \("," "\\"kind\\":" obj_kind\)\? \("," "\\"xyz\\":" obj_xyz\)\? \("," "\\"done\\":" bool\)\? "\}"$/m);
  assert.match(g, /^obj_tasks ::= "\[" \(str \(","\s*str\)\{0,4\}\)\? "\]"$/m);
  assert.match(g, /^obj_xyz ::= "\[" num \(","\s*num\)\{2,2\} "\]"$/m);
  assert.match(g, /^obj_kind ::= "\\"a\\"" \| "\\"b\\""$/m);
  assert.ok(!/\s"\s"/.test(g), 'no whitespace is allowed between tokens');
});

test('long text splits into parts at line and sentence ends', () => {
  const s = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} is here.`).join(' ');
  const parts = R.splitText(`Title line\n${s}\nLast line`, 300);
  assert.ok(parts.length > 3);
  assert.ok(parts.every((p) => p.length <= 300), parts.map((p) => p.length).join(','));
  assert.equal(parts.join(' ').replace(/\n/g, ' ').replace(/\s+/g, ' '), `Title line ${s} Last line`, 'nothing is lost');
  assert.deepEqual(R.splitText('short'), ['short']);
});

test('charts normalise loose input and render each type', () => {
  const c = R.normalizeChart({ type: 'column', data: [{ label: 'Jan', value: '1,200' }, { label: 'Feb', value: 950.5 }] });
  assert.equal(c.type, 'bar');
  assert.deepEqual(c.labels, ['Jan', 'Feb']);
  assert.deepEqual(c.series[0].values, [1200, 950.5]);
  for (const type of R.CHART_TYPES) {
    const svg = R.chartSvg({ type, labels: ['A', 'B', 'C'], series: [{ name: 'One', values: [3, -1, 7] }, { name: 'Two', values: [1, 2, 3] }] }, { w: 300, h: 180 });
    assert.match(svg, /^<svg class="ai-chart"/, type);
    assert.ok(!svg.includes('NaN'), type + ' has no NaN');
  }
  assert.match(R.chartSvg({ labels: [], series: [] }), /No data yet/);
  const flat = R.normalizeChart({ unit: 'EUR', labels: ['rent', 'food'], series: [{ name: 'rent', values: [900] }, { name: 'food', values: [400] }] });
  assert.deepEqual(flat.series, [{ name: 'EUR', values: [900, 400] }], 'one series per category becomes one series');
  assert.ok(R.chartSvg({ labels: ['<b>'], series: [{ values: [1] }] }).includes('&lt;b&gt;'));
});

test('chart CSV round-trips with a header', () => {
  const spec = { type: 'line', labels: ['Mon', 'Tue, late'], series: [{ name: 'Steps', values: [4000, 5200] }, { name: 'Sleep', values: [7, 6.5] }] };
  const csv = R.chartToCSV(spec);
  assert.equal(csv.split('\n')[0], 'Label, Steps, Sleep');
  const back = R.chartFromCSV(csv, { type: 'line' });
  assert.deepEqual(back.labels, spec.labels);
  assert.deepEqual(back.series.map((s) => s.values), [[4000, 5200], [7, 6.5]]);
  assert.deepEqual(R.chartFromCSV('a\t1\nb\t2').series[0].values, [1, 2]);
  const years = R.chartFromCSV('Label, 2025, 2026\nRent, 850, 900\nFood, 380, 400');
  assert.deepEqual(years.labels, ['Rent', 'Food']);
  assert.deepEqual(years.series.map((x) => x.name), ['2025', '2026'], 'numeric series names in a header');
});

test('diagram becomes boxes, arrows and labels without overlaps', () => {
  const spec = { layout: 'down', nodes: [{ id: 'a', label: 'Start' }, { id: 'b', label: 'Check the order details', shape: 'diamond' }, { id: 'c', label: 'Ship' }, { id: 'd', label: 'Refund' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'c', label: 'ok' }, { from: 'b', to: 'd', label: 'no' }] };
  const { strokes, width, height } = R.sketchToStrokes(spec);
  assert.equal(strokes.filter((s) => s.kind === 'shape' && s.shape === 'arrow').length, 3);
  assert.ok(strokes.some((s) => s.kind === 'text' && s.text === 'ok'));
  assert.ok(width > 0 && height > 0);
  const boxes = R.layoutDiagram(spec.nodes, spec.edges, 'down').boxes;
  for (let i = 0; i < boxes.length; i++) for (let j = i + 1; j < boxes.length; j++) {
    const a = boxes[i], b = boxes[j];
    assert.ok(a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y, `${a.id} overlaps ${b.id}`);
  }
  assert.ok(boxes[0].y < boxes[1].y && boxes[1].y < boxes[2].y, 'layers go down');
  const radial = R.sketchToStrokes({ layout: 'mind map', nodes: [{ id: 'm', label: 'Trip' }, { id: '1', label: 'Hotel' }, { id: '2', label: 'Food' }], edges: [{ from: 'm', to: '1' }, { from: 'm', to: '2' }] });
  assert.ok(radial.strokes.every((s) => s.points.every((p) => p[0] >= 0 && p[1] >= 0)));
});

test('free shapes use a 0–100 grid and fit into a note', () => {
  const { strokes, width, height } = R.sketchToStrokes({ shapes: [{ shape: 'square', x: 10, y: 10, w: 30, h: 30, color: 'red', fill: true }, { shape: 'circle', x: 60, y: 10, w: 20, h: 20 }], lines: [{ x1: 40, y1: 25, x2: 60, y2: 20, arrow: true }], texts: [{ text: 'Hi', x: 50, y: 80 }] }, { width: 200, height: 100 });
  assert.equal(strokes[0].shape, 'rect'); assert.equal(strokes[0].color, '#B42318'); assert.equal(strokes[0].fill, true);
  assert.equal(strokes[1].shape, 'ellipse');
  const fitted = R.fitStrokes(strokes, width, height, 100, 50);
  const b = R.bbox(fitted);
  assert.ok(b.x >= -0.5 && b.y >= -0.5 && b.x + b.w <= 100.5 && b.y + b.h <= 50.5, JSON.stringify(b));
  assert.ok(fitted.find((s) => s.kind === 'text').size < 12, 'text shrinks with the drawing');
});

test('3D scenes are clamped and fill in defaults', () => {
  const s = R.normalizeScene({ title: 'Table', parts: [{ shape: 'cube', size: [2, 0.1, 1], position: { x: 0, y: 1, z: 0 }, color: 'brown' }, { type: 'tube', radius: 0.05, height: 1, position: [0.9, 0.5, 0.4] }, { shape: 'sphere', size: 9999, position: [500, 0, 0] }] });
  assert.equal(s.parts[0].shape, 'box'); assert.deepEqual(s.parts[0].position, [0, 1, 0]); assert.equal(s.parts[0].color, '#7A4B26');
  assert.equal(s.parts[1].shape, 'cylinder'); assert.deepEqual(s.parts[1].size, [0.1, 1, 0.1]);
  assert.equal(s.parts[2].size[0], 40); assert.equal(s.parts[2].position[0], 60);
  assert.match(s.parts[1].color, /^#[0-9A-F]{6}$/i);
});

test('common objects get a ready-made 3D shape in the requested colour', () => {
  const chair = R.sceneTemplate('3D model of a red chair');
  assert.equal(chair.title, 'Chair');
  assert.ok(chair.parts.some((p) => p.name === 'seat' && p.color === '#C0392B'));
  assert.equal(chair.parts.filter((p) => p.name === 'leg').length, 4);
  assert.equal(R.sceneTemplate('μια μπλε καρέκλα').parts.find((p) => p.name === 'seat').color, '#2E6DB4');
  assert.equal(R.sceneTemplate('bookshelf').parts.filter((p) => p.name === 'shelf').length, 5, 'templates keep all their parts');
  assert.equal(R.sceneTemplate('a spaceship with three engines'), null);
  assert.equal(R.sceneTemplate('a very long and detailed description of an unusual chair with many unusual parts and colours'), null, 'long requests go to the model');
  for (const p of chair.parts) assert.ok(p.position[1] >= 0, 'nothing below the floor');
});

test('audio splits at quiet moments and finds phrase ends', () => {
  const rate = 16000, tone = (sec, amp) => Float32Array.from({ length: sec * rate }, (_, i) => amp * Math.sin(i / 3));
  const join = (...parts) => { const out = new Float32Array(parts.reduce((s, p) => s + p.length, 0)); let o = 0; for (const p of parts) { out.set(p, o); o += p.length; } return out; };
  const long = join(tone(25, 0.3), tone(1, 0), tone(20, 0.3));
  const parts = R.splitAudio(long, rate, { maxSec: 28 });
  assert.equal(parts.length, 2);
  assert.ok(parts[0][1] / rate > 25 && parts[0][1] / rate < 26, `cut at ${parts[0][1] / rate}s`);
  assert.equal(parts[1][1], long.length);
  assert.ok(R.isSilent(tone(2, 0.001), rate));
  assert.equal(R.phraseCut(tone(1, 0.3), rate), -1, 'too short');
  assert.equal(R.phraseCut(tone(3, 0.3), rate), -1, 'still talking');
  const cut = R.phraseCut(join(tone(2, 0.3), tone(1, 0.0005)), rate);
  assert.ok(cut > 2 * rate && cut < 3 * rate, `phrase ends in the pause (${cut / rate})`);
  assert.ok(R.phraseCut(tone(21, 0.3), rate, { maxSec: 20 }) > 0, 'long speech is cut anyway');
  assert.equal(R.fmtTime(75.9), '01:15');
});

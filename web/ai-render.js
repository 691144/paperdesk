/* PaperDesk AI helpers that need no browser APIs (tested in Node):
   reading model output, charts as SVG, sketches and diagrams as ink strokes,
   3D scene specs, and finding pauses in audio for transcription. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PDAIRender = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  const r1 = (v) => Math.round(v * 10) / 10;

  /* ------------------------------------------------------------ model output */
  /** Removes reasoning blocks some models add before the answer. */
  function stripThink(s) { return String(s ?? '').replace(/<think>[\s\S]*?(<\/think>|$)/gi, '').trim(); }

  /** Reads JSON from model output: tolerates code fences, text around it, trailing commas and a cut-off end. */
  function parseJSON(text) {
    let s = stripThink(text).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(s); } catch { /* repair below */ }
    const start = s.search(/[[{]/);
    if (start < 0) return null;
    const scan = (t) => {
      const stack = []; let inStr = false, escp = false;
      for (let i = 0; i < t.length; i++) {
        const c = t[i];
        if (inStr) { if (escp) escp = false; else if (c === '\\') escp = true; else if (c === '"') inStr = false; continue; }
        if (c === '"') inStr = true;
        else if (c === '{' || c === '[') stack.push(c);
        else if (c === '}' || c === ']') { stack.pop(); if (!stack.length) return { end: i }; }
      }
      return { end: -1, inStr, stack };
    };
    const t0 = s.slice(start), first = scan(t0);
    const bodies = [];
    if (first.end >= 0) bodies.push(t0.slice(0, first.end + 1));
    else {
      // Cut off (ran out of tokens): close what is open, dropping a half-written key if needed.
      for (const t of [t0, t0.replace(/,\s*"[^"]*"\s*:\s*$/, ''), t0.replace(/,\s*"[^"]*$/, ''), t0.replace(/[,:]\s*$/, '')]) {
        const r = scan(t); if (r.end >= 0) continue;
        bodies.push(t + (r.inStr ? '"' : '') + r.stack.reverse().map((c) => (c === '{' ? '}' : ']')).join(''));
      }
    }
    for (const body of bodies) {
      const tries = [body, body.replace(/,\s*([}\]])/g, '$1'), body.replace(/,\s*([}\]])/g, '$1').replace(/([{,]\s*)([A-Za-z_][\w]*)\s*:/g, '$1"$2":')];
      for (const t of tries) { try { return JSON.parse(t); } catch { /* next */ } }
    }
    return null;
  }

  /**
   * A grammar (EBNF, as XGrammar/WebLLM read it) for compact JSON matching a small
   * JSON schema: objects (required properties first, then optional ones, in order),
   * arrays, strings, numbers, booleans and string enums. No whitespace is allowed, so
   * the model spends no tokens on indentation.
   */
  function schemaToGrammar(schema) {
    const rules = [], names = new Map();
    const lit = (s) => JSON.stringify(s);
    const rule = (base, body) => { let n = base, i = 2; while (names.has(n)) n = `${base}_${i++}`; names.set(n, true); rules.push(`${n} ::= ${body}`); return n; };
    function emit(s, base) {
      if (s.enum) return rule(base, s.enum.map((v) => lit(JSON.stringify(v))).join(' | '));
      if (s.type === 'string') return 'str';
      if (s.type === 'number' || s.type === 'integer') return 'num';
      if (s.type === 'boolean') return 'bool';
      if (s.type === 'array') {
        const it = emit(s.items || { type: 'string' }, `${base}_item`);
        // maxItems bounds runaway lists (and so the time a small model can spend).
        const min = Math.max(0, s.minItems || 0), max = s.maxItems || 0;
        const more = max ? `{${Math.max(0, min - 1)},${max - 1}}` : min > 1 ? `{${min - 1},}` : '*';
        return rule(base, min ? `"[" ${it} ("," ${it})${more} "]"` : `"[" (${it} ("," ${it})${more})? "]"`);
      }
      if (s.type === 'object') {
        const props = Object.entries(s.properties || {}), req = new Set(s.required || []);
        const parts = [...props.filter(([k]) => req.has(k)), ...props.filter(([k]) => !req.has(k))].map(([k, v]) => ({ k, r: emit(v, `${base}_${k.replace(/\W/g, '')}`), need: req.has(k) }));
        if (!parts.length) return rule(base, '"{}"');
        const first = parts[0];
        let body = `"{" ${lit(JSON.stringify(first.k) + ':')} ${first.r}`;
        if (!first.need) body = `"{" (${lit(JSON.stringify(first.k) + ':')} ${first.r})?`; // only optional properties: rare
        for (const p of parts.slice(1)) body += p.need ? ` "," ${lit(JSON.stringify(p.k) + ':')} ${p.r}` : ` ("," ${lit(JSON.stringify(p.k) + ':')} ${p.r})?`;
        return rule(base, `${body} "}"`);
      }
      return 'str';
    }
    const top = emit(schema, 'obj');
    return [`root ::= ${top}`, ...rules,
      'str ::= "\\"" ([^"\\\\\\x00-\\x1f] | "\\\\" ["\\\\/bfnrt] | "\\\\u" [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F] [0-9a-fA-F])* "\\""',
      'num ::= "-"? ("0" | [1-9] [0-9]*) ("." [0-9]+)? ([eE] [-+]? [0-9]+)?',
      'bool ::= "true" | "false"'].join('\n');
  }

  /**
   * Splits long text into parts of about `max` characters at line ends, or sentence ends
   * inside very long lines, so a small model reads one manageable part at a time.
   */
  function splitText(text, max = 2200) {
    const units = [];
    for (const line of String(text ?? '').split('\n')) {
      if (line.length <= max) { units.push(line); continue; }
      let cur = '';
      for (const s of line.split(/(?<=[.!?;…])\s+/)) { if (cur && (cur + ' ' + s).length > max) { units.push(cur); cur = s; } else cur = cur ? `${cur} ${s}` : s; }
      if (cur) units.push(cur);
    }
    const out = []; let buf = [], size = 0;
    for (const u of units) { if (buf.length && size + 1 + u.length > max) { out.push(buf.join('\n')); buf = []; size = 0; } buf.push(u); size += u.length + 1; }
    if (buf.length) out.push(buf.join('\n'));
    return out.filter((p) => p.trim());
  }

  /** Plain-text cleanup: no reasoning, no wrapping quotes or code fences. */
  function cleanText(s) {
    let t = stripThink(s).replace(/^```[a-z]*\n?|```$/gi, '').trim();
    if (/^"[^"]*"$/.test(t) || /^“[^”]*”$/.test(t)) t = t.slice(1, -1);
    return t.trim();
  }

  /* ------------------------------------------------------------ charts */
  const CHART_TYPES = ['bar', 'hbar', 'line', 'area', 'pie', 'doughnut'];
  const PALETTE = ['#2D55D9', '#E0692B', '#0B8F5A', '#B42318', '#8A4FD6', '#C99A06', '#0E8FA8', '#6B665C'];
  function num(v) {
    if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
    const m = String(v ?? '').replace(/(\d)[,\s](?=\d{3}\b)/g, '$1').replace(',', '.').match(/-?\d+(\.\d+)?/);
    return m ? parseFloat(m[0]) : 0;
  }
  function normalizeChart(c) {
    c = c && typeof c === 'object' ? c : {};
    let labels = Array.isArray(c.labels) ? c.labels.map((l) => String(l ?? '')) : [];
    let series = Array.isArray(c.series) ? c.series : [];
    if (!series.length && Array.isArray(c.data)) {
      if (c.data.every((d) => d && typeof d === 'object' && !Array.isArray(d))) {
        labels = c.data.map((d) => String(d.label ?? d.name ?? d.x ?? d.category ?? ''));
        series = [{ name: c.unit || 'Value', values: c.data.map((d) => d.value ?? d.y ?? d.count ?? d.amount) }];
      } else series = [{ name: c.unit || 'Value', values: c.data }];
    }
    if (!series.length && Array.isArray(c.values)) series = [{ name: c.unit || 'Value', values: c.values }];
    series = series.filter((s) => s && Array.isArray(s.values ?? s.data)).slice(0, 40).map((s, i) => ({ name: String(s.name ?? s.label ?? `Series ${i + 1}`), values: (s.values ?? s.data).map(num) }));
    // Small models often write one series per category, each with a single value: make that one series.
    if (series.length > 1 && series.every((s) => s.values.length <= 1)) {
      if (labels.length !== series.length) labels = series.map((s) => s.name);
      series = [{ name: String(c.unit || 'Value'), values: series.map((s) => s.values[0] ?? 0) }];
    }
    series = series.slice(0, 6);
    const n = Math.min(40, Math.max(labels.length, ...series.map((s) => s.values.length), 0));
    labels = Array.from({ length: n }, (_, i) => labels[i] || `${i + 1}`);
    for (const s of series) s.values = Array.from({ length: n }, (_, i) => s.values[i] ?? 0);
    const alias = { column: 'bar', columns: 'bar', bars: 'bar', horizontal: 'hbar', donut: 'doughnut', ring: 'doughnut', lines: 'line', area: 'area' };
    const t = String(c.type || '').toLowerCase();
    const type = CHART_TYPES.includes(t) ? t : alias[t] || (/pie/.test(t) ? 'pie' : /line|trend/.test(t) ? 'line' : 'bar');
    return { type, title: String(c.title || ''), unit: String(c.unit || ''), labels, series };
  }
  function niceStep(range, ticks = 4) {
    if (!(range > 0)) return 1;
    const raw = range / ticks, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
  }
  function fmtNum(v) {
    const a = Math.abs(v);
    if (a >= 1e9) return r1(v / 1e9) + 'B';
    if (a >= 1e6) return r1(v / 1e6) + 'M';
    if (a >= 1e4) return r1(v / 1e3) + 'k';
    return String(Math.round(v * 100) / 100);
  }
  const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

  /** An SVG chart. Text uses class "t" so the app can theme it; the colours inline keep exports readable. */
  function chartSvg(spec, { w = 320, h = 200 } = {}) {
    const c = normalizeChart(spec);
    const head = `<svg class="ai-chart" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" font-family="Inter, system-ui, sans-serif" font-size="10">`;
    if (!c.series.length || !c.labels.length) return `${head}<text class="t" x="${w / 2}" y="${h / 2}" text-anchor="middle" fill="#6B665C">No data yet</text></svg>`;
    let out = '';
    const legend = c.series.length > 1 && c.type !== 'pie' && c.type !== 'doughnut';
    if (c.type === 'pie' || c.type === 'doughnut') {
      const vals = c.series[0].values.map((v) => Math.max(0, v)), total = vals.reduce((a, b) => a + b, 0) || 1;
      const side = w > h * 1.25, R = Math.max(10, Math.min(side ? h / 2 - 8 : w / 2 - 8, side ? w * 0.28 : (h - 16 * Math.min(vals.length, 6)) / 2 - 6));
      const cx = side ? R + 8 : w / 2, cy = side ? h / 2 : R + 8;
      let a0 = -Math.PI / 2;
      vals.forEach((v, i) => {
        const a1 = a0 + (v / total) * Math.PI * 2, col = PALETTE[i % PALETTE.length];
        if (v / total >= 0.9999) out += `<circle cx="${cx}" cy="${cy}" r="${R}" fill="${col}"/>`;
        else if (v > 0) {
          const large = a1 - a0 > Math.PI ? 1 : 0;
          out += `<path d="M${r1(cx)} ${r1(cy)}L${r1(cx + R * Math.cos(a0))} ${r1(cy + R * Math.sin(a0))}A${r1(R)} ${r1(R)} 0 ${large} 1 ${r1(cx + R * Math.cos(a1))} ${r1(cy + R * Math.sin(a1))}Z" fill="${col}" stroke="#fff" stroke-width="1"/>`;
        }
        a0 = a1;
      });
      if (c.type === 'doughnut') out += `<circle class="hole" cx="${cx}" cy="${cy}" r="${r1(R * 0.55)}" fill="#fff"/>`;
      const maxRows = side ? Math.floor((h - 8) / 15) : Math.floor((h - (cy + R + 8)) / 15);
      const lx = side ? cx + R + 14 : 10, ly0 = side ? Math.max(10, cy - (Math.min(vals.length, maxRows) * 15) / 2 + 6) : cy + R + 16;
      const cols = side ? 1 : 2, colW = side ? w - lx - 4 : (w - 20) / 2;
      vals.slice(0, maxRows * cols).forEach((v, i) => {
        const x = lx + (i % cols) * colW, y = ly0 + Math.floor(i / cols) * 15;
        out += `<rect x="${r1(x)}" y="${r1(y - 7)}" width="9" height="9" rx="2" fill="${PALETTE[i % PALETTE.length]}"/><text class="t" x="${r1(x + 13)}" y="${r1(y + 1)}" fill="#3A3833">${esc(trunc(c.labels[i], Math.max(6, Math.floor(colW / 6.2) - 6)))} ${Math.round((v / total) * 100)}%</text>`;
      });
      return head + out + '</svg>';
    }
    const all = c.series.flatMap((s) => s.values);
    let lo = Math.min(0, ...all), hi = Math.max(0, ...all);
    if (hi === lo) hi = lo + 1;
    const step = niceStep(hi - lo); lo = Math.floor(lo / step) * step; hi = Math.ceil(hi / step) * step;
    const top = legend ? 22 : 8, horiz = c.type === 'hbar';
    const labW = horiz ? Math.min(w * 0.38, 8 + 6 * Math.max(...c.labels.map((l) => Math.min(l.length, 18)))) : 0;
    const yLabW = horiz ? 0 : 8 + 6 * Math.max(...[lo, hi, step].map((v) => fmtNum(v).length));
    const L = horiz ? labW : yLabW, R = w - 8, T = top, B = h - (horiz ? 16 : 20);
    const n = c.labels.length;
    if (legend) {
      let x = L;
      c.series.forEach((s, i) => { const t = trunc(s.name, 16); out += `<rect x="${r1(x)}" y="5" width="9" height="9" rx="2" fill="${PALETTE[i % PALETTE.length]}"/><text class="t" x="${r1(x + 13)}" y="13" fill="#3A3833">${esc(t)}</text>`; x += 22 + t.length * 6; });
    }
    // Grid and value axis
    for (let v = lo; v <= hi + step / 2; v += step) {
      if (horiz) { const x = L + ((v - lo) / (hi - lo)) * (R - L); out += `<line x1="${r1(x)}" y1="${T}" x2="${r1(x)}" y2="${B}" stroke="#8884" stroke-width="${v === 0 ? 1 : 0.5}"/><text class="t" x="${r1(x)}" y="${B + 12}" text-anchor="middle" fill="#6B665C">${fmtNum(v)}</text>`; }
      else { const y = B - ((v - lo) / (hi - lo)) * (B - T); out += `<line x1="${L}" y1="${r1(y)}" x2="${R}" y2="${r1(y)}" stroke="#8884" stroke-width="${v === 0 ? 1 : 0.5}"/><text class="t" x="${L - 4}" y="${r1(y + 3)}" text-anchor="end" fill="#6B665C">${fmtNum(v)}</text>`; }
    }
    const band = ((horiz ? B - T : R - L) / n);
    const every = Math.max(1, Math.ceil((horiz ? 13 : 6.2 * Math.min(10, Math.max(...c.labels.map((l) => l.length)))) / band));
    c.labels.forEach((l, i) => {
      if (i % every) return;
      if (horiz) out += `<text class="t" x="${L - 4}" y="${r1(T + band * (i + 0.5) + 3)}" text-anchor="end" fill="#3A3833">${esc(trunc(l, 18))}</text>`;
      else out += `<text class="t" x="${r1(L + band * (i + 0.5))}" y="${B + 13}" text-anchor="middle" fill="#3A3833">${esc(trunc(l, Math.max(4, Math.floor((band * every) / 6))))}</text>`;
    });
    const pos = (v) => (horiz ? L + ((v - lo) / (hi - lo)) * (R - L) : B - ((v - lo) / (hi - lo)) * (B - T));
    const zero = pos(0);
    if (c.type === 'bar' || c.type === 'hbar') {
      const k = c.series.length, gap = band * 0.18, bw = (band - gap * 2) / k;
      c.series.forEach((s, si) => s.values.forEach((v, i) => {
        const a = (horiz ? T : L) + band * i + gap + bw * si, p = pos(v);
        out += horiz ? `<rect x="${r1(Math.min(p, zero))}" y="${r1(a)}" width="${r1(Math.max(0.5, Math.abs(p - zero)))}" height="${r1(Math.max(1, bw - 1))}" rx="1.5" fill="${PALETTE[si % PALETTE.length]}"/>`
          : `<rect x="${r1(a)}" y="${r1(Math.min(p, zero))}" width="${r1(Math.max(1, bw - 1))}" height="${r1(Math.max(0.5, Math.abs(p - zero)))}" rx="1.5" fill="${PALETTE[si % PALETTE.length]}"/>`;
      }));
    } else {
      c.series.forEach((s, si) => {
        const col = PALETTE[si % PALETTE.length];
        const pts = s.values.map((v, i) => [L + band * (i + 0.5), pos(v)]);
        const d = pts.map((p, i) => `${i ? 'L' : 'M'}${r1(p[0])} ${r1(p[1])}`).join('');
        if (c.type === 'area') out += `<path d="${d}L${r1(pts[pts.length - 1][0])} ${r1(zero)}L${r1(pts[0][0])} ${r1(zero)}Z" fill="${col}" fill-opacity=".18"/>`;
        out += `<path d="${d}" fill="none" stroke="${col}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
        if (n <= 24) out += pts.map((p) => `<circle cx="${r1(p[0])}" cy="${r1(p[1])}" r="2.4" fill="${col}"/>`).join('');
      });
    }
    return head + out + '</svg>';
  }
  /** Table text for editing: "Label, Series 1, Series 2" then one row per label. */
  function chartToCSV(spec) {
    const c = normalizeChart(spec);
    const cell = (v) => (/[",\n]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
    return [['Label', ...c.series.map((s) => s.name)], ...c.labels.map((l, i) => [l, ...c.series.map((s) => s.values[i])])].map((r) => r.map(cell).join(', ')).join('\n');
  }
  function chartFromCSV(text, base = {}) {
    const rows = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
      const sep = l.includes('\t') ? '\t' : l.includes(';') && !l.includes(',') ? ';' : ',';
      const out = []; let cur = '', q = false;
      for (let i = 0; i < l.length; i++) {
        const ch = l[i];
        if (q) { if (ch === '"' && l[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
        else if (ch === '"') q = true; else if (ch === sep) { out.push(cur.trim()); cur = ''; } else cur += ch;
      }
      out.push(cur.trim()); return out;
    });
    if (!rows.length) return normalizeChart({ ...base, labels: [], series: [] });
    const isNum = (v) => /^-?[\d.,\s]+%?$/.test(v) && /\d/.test(v);
    // A first row is a header if it names its columns, or starts with a word like "Label" (series may be years).
    const headWord = /^(label|labels|category|categories|name|item|items|x|month|year|date|day|ετικέτα|κατηγορία|όνομα|μήνας|έτος)$/i;
    const header = rows.length > 1 && (headWord.test(rows[0][0]) || rows[0].slice(1).some((v) => v && !isNum(v))) ? rows.shift() : null;
    const k = Math.max(1, ...rows.map((r) => r.length - 1));
    const series = Array.from({ length: k }, (_, j) => ({ name: header?.[j + 1] || (k === 1 ? base.series?.[0]?.name || 'Value' : `Series ${j + 1}`), values: rows.map((r) => num(r[j + 1])) }));
    return normalizeChart({ ...base, labels: rows.map((r) => r[0]), series });
  }

  /* ------------------------------------------------------------ sketches and diagrams */
  const INK = { black: '#1C1B18', ink: '#1C1B18', dark: '#1C1B18', red: '#B42318', blue: '#2D55D9', green: '#0B7342', orange: '#C2410C', purple: '#7A3FC4', violet: '#7A3FC4', gray: '#6B665C', grey: '#6B665C', brown: '#7A4B26', yellow: '#C99A06', pink: '#C2417A', teal: '#0E7C86' };
  const colorOf = (c, d = '#1C1B18') => (/^#[0-9a-f]{6}$/i.test(String(c || '')) ? String(c) : INK[String(c || '').toLowerCase().trim()] || d);
  const SHAPE_ALIAS = { box: 'rect', rectangle: 'rect', square: 'rect', process: 'rect', circle: 'ellipse', oval: 'ellipse', round: 'ellipse', start: 'ellipse', end: 'ellipse', decision: 'diamond', rhombus: 'diamond', triangle: 'triangle', star: 'star', arrow: 'arrow', line: 'line', text: 'text', label: 'text' };
  const shapeName = (s) => { const k = String(s || '').toLowerCase().trim(); return ['rect', 'ellipse', 'diamond', 'triangle', 'star', 'line', 'arrow', 'text'].includes(k) ? k : SHAPE_ALIAS[k] || 'rect'; };

  function outline(shape, x, y, w, h) {
    const cx = x + w / 2, cy = y + h / 2, rx = w / 2, ry = h / 2;
    if (shape === 'ellipse') return Array.from({ length: 41 }, (_, i) => { const a = (i / 40) * Math.PI * 2; return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]; });
    if (shape === 'diamond') return [[cx, y], [x + w, cy], [cx, y + h], [x, cy], [cx, y]];
    if (shape === 'triangle') return [[cx, y], [x + w, y + h], [x, y + h], [cx, y]];
    if (shape === 'star') return Array.from({ length: 11 }, (_, i) => { const k = i % 10, rad = k % 2 ? 0.45 : 1, a = -Math.PI / 2 + (k * Math.PI) / 5; return [cx + Math.cos(a) * rx * rad, cy + Math.sin(a) * ry * rad]; });
    return [[x, y], [x + w, y], [x + w, y + h], [x, y + h], [x, y]];
  }
  function arrowPoints(a, b, width = 2.6) {
    const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), len = Math.hypot(b[0] - a[0], b[1] - a[1]), head = Math.min(14, Math.max(7, width * 3.2), len * 0.4);
    return [a, b, [b[0] - head * Math.cos(ang - 0.45), b[1] - head * Math.sin(ang - 0.45)], b, [b[0] - head * Math.cos(ang + 0.45), b[1] - head * Math.sin(ang + 0.45)]];
  }
  const textW = (t, size) => Math.max(size, String(t).length * size * 0.56);
  function textStroke(text, x, y, size = 12, color = '#1C1B18', anchor = 'middle') {
    const tw = textW(text, size), x0 = anchor === 'middle' ? x - tw / 2 : anchor === 'end' ? x - tw : x;
    return { kind: 'text', text: String(text).slice(0, 80), x: r1(x), y: r1(y), size: r1(size), color, anchor, points: [[x0, y - size / 2], [x0 + tw, y - size / 2], [x0 + tw, y + size / 2], [x0, y + size / 2], [x0, y - size / 2]].map((p) => p.map(r1)) };
  }
  /** Splits a label into lines of about maxChars. */
  function wrap(label, maxChars) {
    const words = String(label || '').split(/\s+/).filter(Boolean), lines = [];
    let cur = '';
    for (const w of words) { if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim(); }
    if (cur) lines.push(cur);
    return lines.slice(0, 3);
  }
  // Where the line from a box centre towards (tx, ty) leaves the box.
  function borderPoint(b, tx, ty) {
    const cx = b.x + b.w / 2, cy = b.y + b.h / 2, dx = tx - cx, dy = ty - cy;
    if (!dx && !dy) return [cx, cy];
    if (b.shape === 'ellipse') { const t = 1 / Math.sqrt((dx * dx) / ((b.w / 2) ** 2) + (dy * dy) / ((b.h / 2) ** 2)); return [cx + dx * t, cy + dy * t]; }
    if (b.shape === 'diamond') { const t = 1 / (Math.abs(dx) / (b.w / 2) + Math.abs(dy) / (b.h / 2)); return [cx + dx * t, cy + dy * t]; }
    const t = Math.min(Math.abs((b.w / 2) / (dx || 1e-9)), Math.abs((b.h / 2) / (dy || 1e-9)));
    return [cx + dx * t, cy + dy * t];
  }

  /** Lays out a node-and-edge diagram: "down"/"right" as layers, "radial" as a mind map. */
  function layoutDiagram(nodes, edges, dir = 'down') {
    const ids = nodes.map((n) => n.id), idx = new Map(ids.map((id, i) => [id, i]));
    const E = edges.filter((e) => idx.has(e.from) && idx.has(e.to) && e.from !== e.to);
    const boxes = nodes.map((n) => {
      const lines = wrap(n.label || n.id, 18), shape = shapeName(n.shape || 'rect');
      const w = Math.max(64, Math.min(170, Math.max(...lines.map((l) => textW(l, 12))) + 24)) * (shape === 'diamond' ? 1.4 : shape === 'ellipse' ? 1.15 : 1);
      const h = (lines.length * 15 + 16) * (shape === 'diamond' ? 1.5 : 1);
      return { id: n.id, lines, shape, w, h, x: 0, y: 0, color: colorOf(n.color, '#1C1B18'), fill: n.fill !== false };
    });
    if (dir === 'radial') {
      const deg = boxes.map((_, i) => E.filter((e) => idx.get(e.from) === i || idx.get(e.to) === i).length);
      const root = E.length ? deg.indexOf(Math.max(...deg)) : 0;
      const level = new Map([[root, 0]]), parent = new Map(), q = [root];
      while (q.length) { const u = q.shift(); for (const e of E) { const a = idx.get(e.from), b = idx.get(e.to), v = a === u ? b : b === u ? a : -1; if (v >= 0 && !level.has(v)) { level.set(v, level.get(u) + 1); parent.set(v, u); q.push(v); } } }
      boxes.forEach((_, i) => { if (!level.has(i)) { level.set(i, 1); parent.set(i, root); } });
      const first = boxes.map((_, i) => i).filter((i) => level.get(i) === 1);
      const R1 = Math.max(150, first.length * 34);
      boxes[root].x = -boxes[root].w / 2; boxes[root].y = -boxes[root].h / 2;
      const angle = new Map();
      first.forEach((i, k) => { const a = (k / first.length) * Math.PI * 2 - Math.PI / 2; angle.set(i, a); boxes[i].x = Math.cos(a) * R1 * 1.25 - boxes[i].w / 2; boxes[i].y = Math.sin(a) * R1 * 0.8 - boxes[i].h / 2; });
      for (let L = 2; L < 6; L++) {
        const at = boxes.map((_, i) => i).filter((i) => level.get(i) === L);
        const byParent = new Map(); for (const i of at) { const p = parent.get(i); byParent.set(p, [...(byParent.get(p) || []), i]); }
        for (const [p, kids] of byParent) {
          const base = angle.get(p) ?? 0, spread = Math.min(1.1, 0.42 * kids.length);
          kids.forEach((i, k) => { const a = base + (kids.length > 1 ? -spread / 2 + (spread * k) / (kids.length - 1) : 0); angle.set(i, a); const R = R1 + (L - 1) * 130; boxes[i].x = Math.cos(a) * R * 1.25 - boxes[i].w / 2; boxes[i].y = Math.sin(a) * R * 0.8 - boxes[i].h / 2; });
        }
      }
    } else {
      // Longest-path layers (cycles are cut by a step limit), ordered by parents' positions.
      const layer = boxes.map(() => 0);
      for (let k = 0; k < boxes.length; k++) { let moved = false; for (const e of E) { const a = idx.get(e.from), b = idx.get(e.to); if (layer[b] < layer[a] + 1 && layer[a] + 1 < boxes.length) { layer[b] = layer[a] + 1; moved = true; } } if (!moved) break; }
      const layers = []; layer.forEach((l, i) => (layers[l] = layers[l] || []).push(i));
      const order = new Map();
      layers.forEach((L, li) => {
        if (li) L.sort((a, b) => { const pa = E.filter((e) => idx.get(e.to) === a).map((e) => order.get(idx.get(e.from)) ?? 0), pb = E.filter((e) => idx.get(e.to) === b).map((e) => order.get(idx.get(e.from)) ?? 0); return (pa.length ? pa.reduce((x, y) => x + y) / pa.length : 0) - (pb.length ? pb.reduce((x, y) => x + y) / pb.length : 0); });
        L.forEach((i, k) => order.set(i, k));
      });
      const gapMain = 56, gapCross = 28;
      let main = 0;
      for (const L of layers.filter(Boolean)) {
        const sizeMain = Math.max(...L.map((i) => (dir === 'right' ? boxes[i].w : boxes[i].h)));
        const total = L.reduce((s, i) => s + (dir === 'right' ? boxes[i].h : boxes[i].w), 0) + gapCross * (L.length - 1);
        let cross = -total / 2;
        for (const i of L) {
          const b = boxes[i];
          if (dir === 'right') { b.x = main + (sizeMain - b.w) / 2; b.y = cross; cross += b.h + gapCross; }
          else { b.y = main + (sizeMain - b.h) / 2; b.x = cross; cross += b.w + gapCross; }
        }
        main += sizeMain + gapMain;
      }
    }
    return { boxes, edges: E.map((e) => ({ a: idx.get(e.from), b: idx.get(e.to), label: e.label || '', arrow: e.arrow !== false })) };
  }

  /**
   * Turns an AI sketch spec into ink strokes in pixels. The spec may hold a diagram
   * ({nodes, edges, layout}) and/or free shapes on a 0–100 grid ({shapes, lines, texts}).
   * Returns { strokes, width, height } with everything starting near (0, 0).
   */
  function sketchToStrokes(spec, { width = 360, height = 260, pen = 2.2 } = {}) {
    spec = spec && typeof spec === 'object' ? spec : {};
    const strokes = [];
    const nodes = Array.isArray(spec.nodes) ? spec.nodes.filter((n) => n && (n.id != null || n.label)).slice(0, 40).map((n, i) => ({ ...n, id: String(n.id ?? n.label ?? i) })) : [];
    if (nodes.length) {
      const edges = (Array.isArray(spec.edges) ? spec.edges : []).filter(Boolean).slice(0, 80).map((e) => ({ from: String(e.from ?? e.source ?? ''), to: String(e.to ?? e.target ?? ''), label: e.label, arrow: e.arrow }));
      const dir = /radial|mind|center|centre/i.test(spec.layout || '') ? 'radial' : /right|horizontal|left/i.test(spec.layout || '') ? 'right' : 'down';
      const { boxes, edges: E } = layoutDiagram(nodes, edges, dir);
      for (const e of E) {
        const A = boxes[e.a], Bx = boxes[e.b];
        const p1 = borderPoint(A, Bx.x + Bx.w / 2, Bx.y + Bx.h / 2), p2 = borderPoint(Bx, A.x + A.w / 2, A.y + A.h / 2);
        strokes.push({ kind: 'shape', shape: e.arrow ? 'arrow' : 'line', fill: false, color: '#6B665C', width: 1.6, points: (e.arrow ? arrowPoints(p1, p2, 1.6) : [p1, p2]).map((p) => p.map(r1)) });
        if (e.label) strokes.push(textStroke(e.label, (p1[0] + p2[0]) / 2, (p1[1] + p2[1]) / 2 - 7, 10, '#6B665C'));
      }
      for (const b of boxes) {
        strokes.push({ kind: 'shape', shape: b.shape === 'text' ? 'rect' : b.shape, fill: b.fill, color: b.color, width: pen, points: outline(b.shape === 'text' ? 'rect' : b.shape, b.x, b.y, b.w, b.h).map((p) => p.map(r1)) });
        b.lines.forEach((l, i) => strokes.push(textStroke(l, b.x + b.w / 2, b.y + b.h / 2 + (i - (b.lines.length - 1) / 2) * 15, 12, '#1C1B18')));
      }
    }
    // Free drawing on a 0–100 grid, placed under or beside the diagram.
    const seen = new Set();
    const shapes = (Array.isArray(spec.shapes) ? spec.shapes : []).filter((s) => { if (!s || typeof s !== 'object') return false; const k = JSON.stringify(s); if (seen.has(k)) return false; seen.add(k); return true; }).slice(0, 80);
    const lines = (Array.isArray(spec.lines) ? spec.lines : []).filter(Boolean).slice(0, 80);
    const texts = (Array.isArray(spec.texts) ? spec.texts : []).filter(Boolean).slice(0, 40);
    if (shapes.length || lines.length || texts.length) {
      const bb = bbox(strokes), ox = 0, oy = strokes.length ? bb.y + bb.h + 30 : 0;
      const sx = width / 100, sy = height / 100, g = (v) => clamp(num(v), -10, 110);
      for (const s of shapes) {
        const shape = shapeName(s.shape), col = colorOf(s.color);
        if (shape === 'line' || shape === 'arrow') { lines.push({ ...s, arrow: shape === 'arrow' }); continue; }
        if (shape === 'text') { texts.push(s); continue; }
        const x = ox + g(s.x) * sx, y = oy + g(s.y) * sy, w = Math.max(4, g(s.w ?? s.width ?? 10) * sx), h = Math.max(4, g(s.h ?? s.height ?? s.w ?? 10) * sy);
        strokes.push({ kind: 'shape', shape, fill: !!s.fill, color: col, width: pen, points: outline(shape, x, y, w, h).map((p) => p.map(r1)) });
        if (s.label) strokes.push(textStroke(s.label, x + w / 2, y + h / 2, 11, '#1C1B18'));
      }
      for (const l of lines) {
        const a = [ox + g(l.x1 ?? l.x) * sx, oy + g(l.y1 ?? l.y) * sy], b = [ox + g(l.x2 ?? (num(l.x) + num(l.w))) * sx, oy + g(l.y2 ?? (num(l.y) + num(l.h))) * sy];
        const arrow = l.arrow === true || shapeName(l.shape) === 'arrow';
        strokes.push({ kind: 'shape', shape: arrow ? 'arrow' : 'line', fill: false, color: colorOf(l.color), width: pen, points: (arrow ? arrowPoints(a, b, pen) : [a, b]).map((p) => p.map(r1)) });
        if (l.label) strokes.push(textStroke(l.label, (a[0] + b[0]) / 2, (a[1] + b[1]) / 2 - 8, 10, '#6B665C'));
      }
      for (const t of texts) strokes.push(textStroke(t.text ?? t.label ?? '', ox + g(t.x) * sx, oy + g(t.y) * sy, clamp(num(t.size) || 12, 8, 28), colorOf(t.color)));
    }
    return normalizeStrokes(strokes);
  }
  function bbox(strokes) {
    const pts = strokes.flatMap((s) => s.points || []);
    if (!pts.length) return { x: 0, y: 0, w: 0, h: 0 };
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const x = Math.min(...xs), y = Math.min(...ys);
    return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
  }
  /** Moves strokes so they start at (pad, pad); returns the size they need. */
  function normalizeStrokes(strokes, pad = 8) {
    const b = bbox(strokes);
    const dx = pad - b.x, dy = pad - b.y;
    const out = strokes.map((s) => ({ ...s, points: s.points.map(([x, y]) => [r1(x + dx), r1(y + dy)]), ...(s.kind === 'text' ? { x: r1(s.x + dx), y: r1(s.y + dy) } : {}) }));
    return { strokes: out, width: Math.ceil(b.w + pad * 2), height: Math.ceil(b.h + pad * 2) };
  }
  /** Scales strokes (and text sizes) into a box, keeping proportions and centring. */
  function fitStrokes(strokes, srcW, srcH, boxW, boxH, maxScale = 1.6) {
    const k = Math.min(boxW / Math.max(1, srcW), boxH / Math.max(1, srcH), maxScale);
    const ox = (boxW - srcW * k) / 2, oy = (boxH - srcH * k) / 2;
    return strokes.map((s) => ({
      ...s, points: s.points.map(([x, y]) => [r1(ox + x * k), r1(oy + y * k)]),
      ...(s.kind === 'text' ? { x: r1(ox + s.x * k), y: r1(oy + s.y * k), size: r1(Math.max(6, s.size * k)) } : { width: r1(Math.max(1, (s.width || 2.2) * Math.min(1, Math.max(0.6, k)))) }),
    }));
  }

  /* ------------------------------------------------------------ 3D concept scenes */
  const PRIMS = ['box', 'sphere', 'cylinder', 'cone', 'torus', 'capsule', 'plane', 'pyramid'];
  const PRIM_ALIAS = { cube: 'box', cuboid: 'box', block: 'box', ball: 'sphere', globe: 'sphere', tube: 'cylinder', pipe: 'cylinder', disc: 'cylinder', disk: 'cylinder', ring: 'torus', donut: 'torus', pill: 'capsule', floor: 'plane', ground: 'plane' };
  const PALETTE3D = ['#C9A27E', '#6F8FAF', '#B8B8B8', '#7FA36B', '#D9734E', '#E8D6B0', '#8B6F5A', '#4F6D8F'];
  function vec3(v, d) {
    if (Array.isArray(v)) return [0, 1, 2].map((i) => (Number.isFinite(num(v[i])) && v[i] != null ? num(v[i]) : d[i]));
    if (v && typeof v === 'object') return [num(v.x ?? d[0]), num(v.y ?? d[1]), num(v.z ?? d[2])];
    if (v != null && Number.isFinite(num(v))) return [num(v), num(v), num(v)];
    return d.slice();
  }
  function normalizeScene(spec, { maxCopies = 4 } = {}) {
    spec = spec && typeof spec === 'object' ? spec : {};
    const list = Array.isArray(spec.parts) ? spec.parts : Array.isArray(spec.objects) ? spec.objects : Array.isArray(spec.shapes) ? spec.shapes : [];
    // Small models sometimes repeat one part over and over: keep at most 4 copies of any part.
    const copies = new Map();
    const kept = list.filter((p) => {
      if (!p || typeof p !== 'object') return false;
      const k = JSON.stringify([p.shape || p.type, p.size, p.color, p.rotation]);
      copies.set(k, (copies.get(k) || 0) + 1);
      return copies.get(k) <= maxCopies;
    });
    const parts = kept.slice(0, 80).map((p, i) => {
      const k = String(p.shape || p.type || p.kind || 'box').toLowerCase();
      const shape = PRIMS.includes(k) ? k : PRIM_ALIAS[k] || 'box';
      const size = vec3(p.size ?? p.scale ?? p.dimensions, [1, 1, 1]).map((v) => clamp(Math.abs(v) || 1, 0.02, 40));
      if (p.radius != null && shape !== 'box') size[0] = size[2] = clamp(num(p.radius) * 2, 0.02, 40);
      if (p.height != null && shape !== 'sphere') size[1] = clamp(num(p.height), 0.02, 40);
      return {
        name: String(p.name || p.label || `${shape} ${i + 1}`).slice(0, 40), shape, size,
        position: vec3(p.position ?? p.pos ?? p.at, [0, 0, 0]).map((v) => clamp(v, -60, 60)),
        rotation: vec3(p.rotation ?? p.rot, [0, 0, 0]).map((v) => clamp(v, -720, 720)),
        color: colorOf(p.color, '') || (/^#[0-9a-f]{3}$/i.test(p.color || '') ? p.color : PALETTE3D[i % PALETTE3D.length]),
        metal: clamp(num(p.metalness ?? p.metal ?? 0), 0, 1), rough: clamp(num(p.roughness ?? 0.6) || 0.6, 0.05, 1),
      };
    });
    return { title: String(spec.title || spec.name || '3D concept'), parts };
  }

  /* Ready-made concept models for common objects: instant, and better proportioned than a
     small language model's guess. Colours come from the words in the request (English or Greek). */
  const COLOR_WORDS = [['red', '#C0392B'], ['κόκκιν', '#C0392B'], ['blue', '#2E6DB4'], ['μπλε', '#2E6DB4'], ['green', '#3E8E41'], ['πράσιν', '#3E8E41'], ['yellow', '#E5B92B'], ['κίτριν', '#E5B92B'], ['black', '#2A2A2A'], ['μαύρ', '#2A2A2A'], ['white', '#F2F2F2'], ['λευκ', '#F2F2F2'], ['άσπρ', '#F2F2F2'], ['grey', '#8A8A8A'], ['gray', '#8A8A8A'], ['γκρι', '#8A8A8A'], ['orange', '#E07B2E'], ['πορτοκαλ', '#E07B2E'], ['purple', '#7B4FA6'], ['μωβ', '#7B4FA6'], ['pink', '#E58FB0'], ['ροζ', '#E58FB0'], ['brown', '#8B5A2B'], ['καφέ', '#8B5A2B'], ['wood', '#A0703C'], ['ξύλ', '#A0703C'], ['silver', '#B8BCC2'], ['metal', '#B8BCC2'], ['μεταλλ', '#B8BCC2'], ['gold', '#C9A227'], ['χρυσ', '#C9A227']];
  const shade = (hex, k) => '#' + [1, 3, 5].map((i) => Math.round(clamp(parseInt(hex.slice(i, i + 2), 16) * (1 + k), 0, 255)).toString(16).padStart(2, '0')).join('');
  const P3 = (name, shape, size, position, color, rotation = [0, 0, 0]) => ({ name, shape, size, position, rotation, color });
  const corners = (x, z) => [[-x, -z], [x, -z], [-x, z], [x, z]];
  const TEMPLATES = [
    { re: /\bchair\b|\bstool\b|καρέκλ|σκαμπό/, title: 'Chair', make: (c = '#A0703C') => [
      ...corners(0.2, 0.2).map(([x, z]) => P3('leg', 'box', [0.05, 0.45, 0.05], [x, 0.225, z], shade(c, -0.25))),
      P3('seat', 'box', [0.48, 0.05, 0.48], [0, 0.47, 0], c), P3('back', 'box', [0.48, 0.5, 0.05], [0, 0.745, -0.215], c)] },
    { re: /\btable\b|\bdesk\b|τραπέζ|γραφεί/, title: 'Table', make: (c = '#A0703C') => [
      P3('top', 'box', [1.2, 0.05, 0.7], [0, 0.745, 0], c), ...corners(0.54, 0.29).map(([x, z]) => P3('leg', 'box', [0.06, 0.72, 0.06], [x, 0.36, z], shade(c, -0.25)))] },
    { re: /\blamp\b|λάμπα|φωτιστικ|πορτατίφ/, title: 'Desk lamp', make: (c = '#2E6DB4') => [
      P3('base', 'cylinder', [0.22, 0.03, 0.22], [0, 0.015, 0], shade(c, -0.3)), P3('stand', 'cylinder', [0.025, 0.38, 0.025], [0, 0.2, 0], '#B8BCC2'),
      P3('arm', 'cylinder', [0.025, 0.3, 0.025], [0.11, 0.48, 0], '#B8BCC2', [0, 0, -50]), P3('shade', 'cone', [0.2, 0.16, 0.2], [0.24, 0.52, 0], c, [0, 0, 150]),
      P3('bulb', 'sphere', [0.06, 0.06, 0.06], [0.215, 0.47, 0], '#FFE38A')] },
    { re: /\btree\b|δέντρ/, title: 'Tree', make: (c = '#3E8E41') => [
      P3('trunk', 'cylinder', [0.25, 1.2, 0.25], [0, 0.6, 0], '#7A4B26'), P3('crown', 'sphere', [1.2, 1.1, 1.2], [0, 1.6, 0], c),
      P3('crown', 'sphere', [0.8, 0.75, 0.8], [0.4, 1.35, 0.2], shade(c, 0.12)), P3('crown', 'sphere', [0.8, 0.75, 0.8], [-0.35, 1.4, -0.2], shade(c, -0.12))] },
    { re: /\bhouse\b|\bhome\b|σπίτι/, title: 'House', make: (c = '#E8D6B0') => [
      P3('walls', 'box', [2, 1.5, 1.6], [0, 0.75, 0], c), P3('roof', 'pyramid', [2.3, 1, 1.9], [0, 2, 0], '#B5432F'),
      P3('door', 'box', [0.4, 0.8, 0.05], [0, 0.4, 0.81], '#7A4B26'), P3('window', 'box', [0.4, 0.35, 0.05], [-0.6, 0.95, 0.81], '#9CC3E6'),
      P3('window', 'box', [0.4, 0.35, 0.05], [0.6, 0.95, 0.81], '#9CC3E6'), P3('chimney', 'box', [0.22, 0.6, 0.22], [0.55, 2.05, -0.3], '#8A8A8A')] },
    { re: /\bmug\b|\bcup\b|κούπα|φλιτζάν/, title: 'Mug', make: (c = '#F2F2F2') => [
      P3('body', 'cylinder', [0.09, 0.1, 0.09], [0, 0.05, 0], c), P3('coffee', 'cylinder', [0.08, 0.002, 0.08], [0, 0.09, 0], '#4A2C17'),
      P3('handle', 'torus', [0.06, 0.06, 0.012], [0.055, 0.052, 0], c)] },
    { re: /\bcar\b|αυτοκίνητ|αμάξι/, title: 'Car', make: (c = '#C0392B') => [
      P3('body', 'box', [1.8, 0.45, 0.85], [0, 0.45, 0], c), P3('cabin', 'box', [1, 0.4, 0.8], [-0.1, 0.87, 0], shade(c, 0.1)),
      P3('windscreen', 'box', [0.04, 0.32, 0.72], [0.41, 0.87, 0], '#9CC3E6'),
      ...corners(0.6, 0.45).map(([x, z]) => P3('wheel', 'cylinder', [0.4, 0.15, 0.4], [x, 0.2, z], '#2A2A2A', [90, 0, 0]))] },
    { re: /\bbook ?(shelf|case)\b|\bshel(f|ves)\b|βιβλιοθήκ|ράφι/, title: 'Bookshelf', make: (c = '#A0703C') => [
      P3('side', 'box', [0.03, 1.8, 0.3], [-0.4, 0.9, 0], c), P3('side', 'box', [0.03, 1.8, 0.3], [0.4, 0.9, 0], c), P3('back', 'box', [0.83, 1.8, 0.01], [0, 0.9, -0.145], shade(c, -0.2)),
      ...[0.015, 0.45, 0.9, 1.35, 1.785].map((y) => P3('shelf', 'box', [0.8, 0.03, 0.3], [0, y, 0], c)),
      P3('books', 'box', [0.3, 0.3, 0.22], [-0.2, 0.62, 0], '#2E6DB4'), P3('books', 'box', [0.25, 0.28, 0.22], [0.15, 1.06, 0], '#C0392B'), P3('books', 'box', [0.35, 0.3, 0.22], [0, 1.52, 0], '#3E8E41')] },
    { re: /\bbed\b|κρεβάτ/, title: 'Bed', make: (c = '#8B5A2B') => [
      P3('frame', 'box', [1.6, 0.3, 2.1], [0, 0.25, 0], c), P3('mattress', 'box', [1.5, 0.2, 2], [0, 0.5, 0], '#F2F2F2'),
      P3('headboard', 'box', [1.6, 0.8, 0.08], [0, 0.6, -1.04], c), P3('blanket', 'box', [1.52, 0.04, 1.2], [0, 0.61, 0.38], '#2E6DB4'),
      P3('pillow', 'box', [0.6, 0.12, 0.35], [-0.38, 0.66, -0.75], '#FFFFFF'), P3('pillow', 'box', [0.6, 0.12, 0.35], [0.38, 0.66, -0.75], '#FFFFFF')] },
    { re: /\brocket\b|πύραυλ/, title: 'Rocket', make: (c = '#C0392B') => [
      P3('body', 'cylinder', [0.4, 1.6, 0.4], [0, 0.9, 0], '#F2F2F2'), P3('nose', 'cone', [0.4, 0.5, 0.4], [0, 1.95, 0], c),
      P3('window', 'sphere', [0.15, 0.15, 0.15], [0, 1.3, 0.19], '#9CC3E6'),
      P3('fin', 'box', [0.05, 0.4, 0.35], [0.22, 0.3, 0], c), P3('fin', 'box', [0.05, 0.4, 0.35], [-0.22, 0.3, 0], c), P3('fin', 'box', [0.35, 0.4, 0.05], [0, 0.3, 0.22], c), P3('fin', 'box', [0.35, 0.4, 0.05], [0, 0.3, -0.22], c)] },
  ];
  /** A ready-made scene when the request is a short description of a common object, else null. */
  function sceneTemplate(q) {
    const s = String(q || '').toLowerCase();
    if (s.split(/\s+/).filter(Boolean).length > 12) return null;
    const t = TEMPLATES.find((x) => x.re.test(s));
    if (!t) return null;
    const col = COLOR_WORDS.find(([w]) => s.includes(w))?.[1];
    return normalizeScene({ title: t.title, parts: col ? t.make(col) : t.make() }, { maxCopies: Infinity });
  }

  /* ------------------------------------------------------------ audio */
  /** RMS level of 20 ms frames. */
  function frameLevels(samples, rate, frameMs = 20) {
    const n = Math.max(1, Math.round((rate * frameMs) / 1000)), out = new Float32Array(Math.floor(samples.length / n));
    for (let f = 0; f < out.length; f++) { let s = 0; for (let i = f * n; i < (f + 1) * n; i++) s += samples[i] * samples[i]; out[f] = Math.sqrt(s / n); }
    return { levels: out, frame: n };
  }
  function percentile(arr, p) { if (!arr.length) return 0; const a = Array.from(arr).sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; }
  /** Splits long audio into pieces of at most maxSec, cutting at the quietest moment near each limit. */
  function splitAudio(samples, rate, { maxSec = 28, lookSec = 6 } = {}) {
    const out = [], max = Math.floor(maxSec * rate);
    let start = 0;
    while (samples.length - start > max) {
      const { levels, frame } = frameLevels(samples.subarray(start + max - Math.floor(lookSec * rate), start + max), rate);
      let best = 0; for (let i = 1; i < levels.length; i++) if (levels[i] < levels[best]) best = i;
      const cut = start + max - Math.floor(lookSec * rate) + best * frame + (frame >> 1);
      out.push([start, cut]); start = cut;
    }
    if (samples.length - start > rate * 0.2) out.push([start, samples.length]);
    return out;
  }
  /** True when the audio is (nearly) silent. */
  function isSilent(samples, rate) { const { levels } = frameLevels(samples, rate); return !levels.length || percentile(levels, 0.95) < 0.006; }
  /**
   * For live dictation: where to end the current phrase. Returns a sample index, or -1 to keep listening.
   * Cuts at a pause of pauseSec after at least minSec of audio, or at the quietest point once maxSec is reached.
   */
  function phraseCut(samples, rate, { minSec = 1.6, pauseSec = 0.6, maxSec = 20, floor = null } = {}) {
    if (samples.length < minSec * rate) return -1;
    const { levels, frame } = frameLevels(samples, rate);
    const noise = floor ?? percentile(levels, 0.15);
    const thr = Math.max(0.008, noise * 2.6), need = Math.ceil((pauseSec * 1000) / 20);
    const speech = levels.some((l) => l > thr * 1.6);
    let quiet = 0;
    for (let i = levels.length - 1; i >= 0 && levels[i] < thr; i--) quiet++;
    if (quiet >= need && speech && levels.length - quiet >= (minSec * 1000) / 20 / 2) return Math.min(samples.length, (levels.length - quiet + Math.floor(need / 2)) * frame);
    if (samples.length >= maxSec * rate) {
      const from = Math.floor(levels.length * 0.7); let best = from;
      for (let i = from; i < levels.length; i++) if (levels[i] < levels[best]) best = i;
      return best * frame;
    }
    return -1;
  }
  const fmtTime = (sec) => { const s = Math.max(0, Math.floor(sec)); return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`; };

  return { esc, stripThink, parseJSON, cleanText, schemaToGrammar, sceneTemplate, splitText, CHART_TYPES, PALETTE, num, normalizeChart, chartSvg, chartToCSV, chartFromCSV, colorOf, outline, arrowPoints, textStroke, layoutDiagram, sketchToStrokes, normalizeStrokes, fitStrokes, bbox, normalizeScene, PRIMS, frameLevels, splitAudio, isSilent, phraseCut, fmtTime };
});

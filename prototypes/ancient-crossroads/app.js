(() => {
const MIN = -3000, MAX = 1500;
const BW = 1000, BH = 520;
const proj = d3.geoNaturalEarth1().rotate([-20, 0]).fitExtent([[0, 0], [BW, BH]], { type: 'Sphere' });
const gpath = d3.geoPath(proj);
const pr = (p) => proj(p);

const state = { year: 100, playing: false, layers: { civs: true, routes: true, journeys: true, ideas: true, wars: true }, sel: null, chapter: -1, view: 'silk' };
let T = d3.zoomIdentity;

const fmtYear = (y) => { const r = Math.round(y); return r < 0 ? `${-r} BC` : `AD ${Math.max(r, 1)}`; };
const fmtSpan = (a, b) => (a < 0 && b < 0) ? `${-a}–${-b} BC` : (a < 0 ? `${-a} BC – AD ${Math.max(b, 1)}` : `AD ${Math.max(a, 1)}–${b}`);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const sphereName = Object.fromEntries(SPHERES.map((s) => [s.id, s.name]));

// ---------- prepare data ----------
const line = d3.line().curve(d3.curveCatmullRomClosed.alpha(0.5));
for (const c of CIVS) {
  c.frames = c.shape.map(([y, rings]) => {
    const pts = rings.map((r) => r.map(pr));
    const area = d3.sum(pts, (r) => Math.abs(d3.polygonArea(r)));
    return { y, pts, area, d: pts.map((r) => line(r)).join('') };
  });
  c.peak = c.frames.reduce((a, b) => (b.area > a.area ? b : a));
  c.capPt = pr(c.cap[0]);
}
const isActive = (c, y) => y >= c.from && (c.to >= MAX ? y <= MAX : y < c.to);
const frameAt = (c, y) => { let f = c.frames[0]; for (const fr of c.frames) if (fr.y <= y) f = fr; return f; };
const peakYear = (c) => Math.max(c.from, Math.min(c.peak.y === c.from ? Math.round((c.from + Math.min(c.to, MAX)) / 2) : c.peak.y, Math.min(c.to, MAX) - 1));

for (const r of ROUTES) r.pts = r.paths.map((p) => p.map(pr));
const routeActive = (r, y) => y >= r.from && y <= r.to;
const levelAt = (r, y) => {
  if (!r.level) return 2;
  let v = r.level[0][1];
  for (let i = 0; i < r.level.length; i++) {
    const [ya, va] = r.level[i]; const nx = r.level[i + 1];
    if (y >= ya) v = nx && y < nx[0] ? va + (nx[1] - va) * (y - ya) / (nx[0] - ya) : va;
  }
  return v;
};

for (const e of EVENTS) {
  if (e.kind === 'conflict') { e.start = e.year; e.end = e.year; e.win = [e.year - 2, e.year + 35]; e.pt = pr(e.at); continue; }
  e.br = e.branches.map((b) => b.map(([lon, lat, y, label]) => ({ p: pr([lon, lat]), y, label })));
  const ys = e.br.flat().map((s) => s.y);
  e.start = Math.min(...ys); e.end = Math.max(...ys);
  e.win = [e.start - 1, e.end + (e.linger || 60)];
}
const evVisible = (e, y) => y >= e.win[0] && y <= e.win[1];
const evLayer = (e) => (e.kind === 'conflict' ? 'wars' : e.kind === 'journey' ? 'journeys' : 'ideas');
const evYears = (e) => (e.kind === 'conflict' ? fmtYear(e.year) : (Math.round(e.start) === Math.round(e.end) ? fmtYear(e.start) : fmtSpan(Math.round(e.start), Math.round(e.end)))) + (e.c ? ' (c.)' : '');

// ---------- map scaffold ----------
const svg = d3.select('#map');
const land = topojson.feature(GEO.land, GEO.land.objects.land);
const defs = svg.append('defs');
defs.append('clipPath').attr('id', 'landclip').attr('clipPathUnits', 'userSpaceOnUse').append('path').attr('d', gpath(land));
const zg = svg.append('g');
zg.append('path').attr('class', 'grat').attr('d', gpath(d3.geoGraticule10()));
zg.append('path').attr('class', 'landp').attr('d', gpath(land));
const civG = zg.append('g').attr('clip-path', 'url(#landclip)');
zg.append('path').attr('class', 'lakes').attr('d', gpath({ type: 'MultiPolygon', coordinates: GEO.lakes }));
zg.append('path').attr('class', 'rivers').attr('d', gpath({ type: 'MultiLineString', coordinates: GEO.rivers }));
const ov = svg.append('g');
const routeG = ov.append('g'), evG = ov.append('g'), labG = ov.append('g'), warG = ov.append('g');

const zoom = d3.zoom().scaleExtent([0.8, 16]).on('zoom', (ev) => { T = ev.transform; zg.attr('transform', T); drawOverlay(); });
svg.call(zoom).on('dblclick.zoom', null);
const size = () => { const n = svg.node(); return [n.clientWidth || 800, n.clientHeight || 500]; };
function viewTransform(name) {
  const [[x0, y0], [x1, y1]] = VIEWS[name].box;
  const pts = [];
  for (let i = 0; i <= 8; i++) { const lx = x0 + (x1 - x0) * i / 8; pts.push(pr([lx, y0]), pr([lx, y1])); const ly = y0 + (y1 - y0) * i / 8; pts.push(pr([x0, ly]), pr([x1, ly])); }
  const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
  const bx = [Math.min(...xs), Math.max(...xs)], by = [Math.min(...ys), Math.max(...ys)];
  const [w, h] = size();
  const k = Math.min(w / (bx[1] - bx[0]), h / (by[1] - by[0])) * 0.96;
  return d3.zoomIdentity.translate(w / 2 - k * (bx[0] + bx[1]) / 2, h / 2 - k * (by[0] + by[1]) / 2).scale(k);
}
function setView(name, animate = true) {
  state.view = name;
  const t = viewTransform(name);
  (animate ? svg.transition().duration(900).ease(d3.easeCubicInOut) : svg).call(zoom.transform, t);
  d3.selectAll('#views button').attr('aria-pressed', (d) => String(d === name));
}
d3.select('#zin').on('click', () => svg.transition().duration(300).call(zoom.scaleBy, 1.6));
d3.select('#zout').on('click', () => svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.6));

// ---------- tooltip ----------
const tip = d3.select('#tip');
const wrap = document.getElementById('mapwrap');
function showTip(ev, html) {
  tip.html(html).attr('hidden', null);
  const r = wrap.getBoundingClientRect(); const tw = tip.node().offsetWidth, th = tip.node().offsetHeight;
  let x = ev.clientX - r.left + 14, y = ev.clientY - r.top + 14;
  if (x + tw > r.width - 8) x = ev.clientX - r.left - tw - 14;
  if (y + th > r.height - 8) y = ev.clientY - r.top - th - 14;
  tip.style('left', Math.max(6, x) + 'px').style('top', Math.max(6, y) + 'px');
}
const hideTip = () => tip.attr('hidden', '');
const civTip = (c) => `<b>${esc(c.name)}</b><span class="yrs">${fmtSpan(c.from, Math.min(c.to, MAX))}${c.kind === 'culture' ? ' · culture' : ''}</span><br>${esc(sphereName[c.s])}`;
const routeTip = (r) => `<b>${esc(r.name)}</b><span class="yrs">${fmtSpan(r.from, r.to)}</span><br>${esc(r.goods)}`;
const evTip = (e) => `<b>${esc(e.title)}</b><span class="yrs">${evYears(e)}</span>`;

// ---------- drawing ----------
const sx = (p) => T.applyX(p[0]), sy = (p) => T.applyY(p[1]);
const sp = (p) => [sx(p), sy(p)];
const openLine = d3.line().curve(d3.curveCatmullRom.alpha(0.5));
let activeCivs = [];

function drawCivs() {
  const y = state.year;
  activeCivs = state.layers.civs ? CIVS.filter((c) => isActive(c, y)) : [];
  const rows = activeCivs.map((c) => ({ c, f: frameAt(c, y) })).sort((a, b) => b.f.area - a.f.area);
  const sel = state.sel && state.sel.type === 'civ' ? state.sel.id : null;
  civG.selectAll('path.civ').data(rows, (d) => d.c.id).join(
    (en) => en.append('path').on('mousemove', (ev, d) => showTip(ev, civTip(d.c))).on('mouseleave', hideTip).on('click', (ev, d) => { ev.stopPropagation(); select({ type: 'civ', id: d.c.id }); }),
  )
    .attr('class', (d) => `civ${d.c.kind === 'culture' ? ' culture' : ''}${sel ? (d.c.id === sel ? ' sel' : ' dim') : ''}`)
    .attr('d', (d) => d.f.d)
    .style('fill', (d) => `var(--c-${d.c.s})`).style('stroke', (d) => `var(--c-${d.c.s})`)
    .style('opacity', (d) => {
      const a = Math.min(1, (y - d.c.from) / 20 + 0.25), b = d.c.to >= MAX ? 1 : Math.min(1, (d.c.to - y) / 20 + 0.25);
      return Math.min(a, b);
    })
    .order();
  const selRow = rows.find((d) => d.c.id === sel);
  civG.selectAll('path.halo').data(selRow ? [selRow] : []).join('path').attr('class', 'halo').attr('d', (d) => d.f.d).style('stroke', (d) => `var(--c-${d.c.s})`);
}

function drawRoutes() {
  const y = state.year;
  const list = state.layers.routes ? ROUTES.filter((r) => routeActive(r, y)) : [];
  const sel = state.sel && state.sel.type === 'route' ? state.sel.id : null;
  const g = routeG.selectAll('g.route').data(list, (d) => d.id).join((en) => {
    const g = en.append('g');
    g.on('mousemove', (ev, d) => showTip(ev, routeTip(d))).on('mouseleave', hideTip).on('click', (ev, d) => { ev.stopPropagation(); select({ type: 'route', id: d.id }); });
    return g;
  }).attr('class', (d) => `route ${d.kind}${sel ? (d.id === sel ? ' sel' : ' fade') : ''}`);
  g.each(function (r) {
    const w = 0.8 + levelAt(r, y) * 0.9;
    const ds = r.pts.map((pts) => openLine(pts.map(sp)));
    const s = d3.select(this);
    s.selectAll('path.case').data(ds).join('path').attr('class', 'case').attr('d', (d) => d).attr('stroke-width', w + 3);
    s.selectAll('path.ln').data(ds).join('path').attr('class', 'ln').attr('d', (d) => d).attr('stroke-width', w);
    s.selectAll('path.hit').data(ds).join('path').attr('class', 'hit').attr('d', (d) => d);
  });
}

function arcCtrl(a, b) {
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2, dx = b[0] - a[0], dy = b[1] - a[1];
  return [mx - dy * 0.16, my + dx * 0.16];
}
function trail(stops, y) {
  // Quadratic arcs between successive stops, cut at the current year.
  let d = ''; let head = null; let last = null; const reached = [];
  for (let i = 0; i < stops.length; i++) {
    const s = stops[i]; const p = sp(s.p);
    if (i === 0) { if (y < s.y) break; d = `M${p[0]},${p[1]}`; reached.push(s); last = s; continue; }
    const a = sp(stops[i - 1].p), c = arcCtrl(a, p);
    if (y >= s.y) { d += `Q${c[0]},${c[1]} ${p[0]},${p[1]}`; reached.push(s); last = s; continue; }
    const u = (y - stops[i - 1].y) / (s.y - stops[i - 1].y);
    if (u > 0) {
      const q0 = [a[0] + (c[0] - a[0]) * u, a[1] + (c[1] - a[1]) * u];
      const q1 = [c[0] + (p[0] - c[0]) * u, c[1] + (p[1] - c[1]) * u];
      const b = [q0[0] + (q1[0] - q0[0]) * u, q0[1] + (q1[1] - q0[1]) * u];
      d += `Q${q0[0]},${q0[1]} ${b[0]},${b[1]}`; head = b;
    }
    break;
  }
  return { d, head, reached, last };
}

function drawEvents() {
  const y = state.year;
  const sel = state.sel && state.sel.type === 'event' ? state.sel.id : null;
  const paths = EVENTS.filter((e) => e.kind !== 'conflict' && state.layers[evLayer(e)] && evVisible(e, y));
  const g = evG.selectAll('g.ev').data(paths, (d) => d.id).join((en) => en.append('g')
    .on('mousemove', (ev, d) => showTip(ev, evTip(d))).on('mouseleave', hideTip).on('click', (ev, d) => { ev.stopPropagation(); select({ type: 'event', id: d.id }); }))
    .attr('class', (d) => `ev ${d.kind}${d.id === sel ? ' sel' : ''}`)
    .style('opacity', (d) => (y > d.end ? Math.max(0.35, 1 - (y - d.end) / (d.win[1] - d.end) * 0.65) : 1));
  g.each(function (e) {
    const s = d3.select(this);
    const tr = e.mode === 'points' ? null : e.br.map((b) => trail(b, y));
    const stops = e.mode === 'points' ? e.br.flat().filter((st) => st.y <= y) : [...new Map(tr.flatMap((t) => t.reached).map((st) => [st.label + st.y, st])).values()];
    if (tr) {
      s.selectAll('path.trail').data(tr.filter((t) => t.d)).join('path').attr('class', 'trail').attr('d', (t) => t.d);
      s.selectAll('path.hit').data(tr.filter((t) => t.d)).join('path').attr('class', 'hit').attr('d', (t) => t.d);
      s.selectAll('circle.head').data(tr.filter((t) => t.head)).join('circle').attr('class', 'head').attr('r', 4).attr('cx', (t) => t.head[0]).attr('cy', (t) => t.head[1]);
    }
    s.selectAll('circle.stop').data(stops).join('circle').attr('class', 'stop').attr('r', e.mode === 'points' ? 4 : 2.6).attr('cx', (st) => sx(st.p)).attr('cy', (st) => sy(st.p));
    // Label the newest stop on each branch, and everything when selected.
    let tags;
    if (e.id === sel) tags = stops;
    else if (e.mode === 'points') tags = stops.filter((st) => y - st.y < 120);
    else tags = tr.map((t) => t.last).filter((st) => st && y - st.y < 60);
    tags = [...new Set(tags)];
    s.selectAll('text.tag').data(tags).join('text').attr('class', 'tag').attr('x', (st) => sx(st.p) + 6).attr('y', (st) => sy(st.p) - 5)
      .text((st) => `${st.label} ${fmtYear(st.y)}`);
  });

  const wars = state.layers.wars ? EVENTS.filter((e) => e.kind === 'conflict' && evVisible(e, y)) : [];
  const w = warG.selectAll('g.war').data(wars, (d) => d.id).join((en) => {
    const g = en.append('g').attr('class', 'war');
    g.append('circle').attr('class', 'ring');
    g.append('path').attr('d', 'M0,-6L1.8,-1.8L6,0L1.8,1.8L0,6L-1.8,1.8L-6,0L-1.8,-1.8Z');
    g.append('text').attr('class', 'tag');
    g.on('mousemove', (ev, d) => showTip(ev, evTip(d))).on('mouseleave', hideTip).on('click', (ev, d) => { ev.stopPropagation(); select({ type: 'event', id: d.id }); });
    return g;
  });
  w.attr('transform', (d) => `translate(${sx(d.pt)},${sy(d.pt)})`)
    .style('opacity', (d) => (y < d.year ? 0.5 : Math.max(0.3, 1 - (y - d.year) / 40)));
  w.select('circle.ring').attr('r', (d) => (y >= d.year && y - d.year < 12 ? 8 + (y - d.year) : 0)).style('opacity', (d) => Math.max(0, 1 - (y - d.year) / 12));
  w.select('text').attr('x', 8).attr('y', -6).text((d) => (y - d.year < 15 || d.id === sel ? `${d.title} ${fmtYear(d.year)}` : ''));
}

function drawLabels() {
  const [w, h] = size();
  const sel = state.sel && state.sel.type === 'civ' ? state.sel.id : null;
  const cands = activeCivs.map((c) => {
    const f = frameAt(c, state.year); const a = f.area * T.k * T.k;
    const size = Math.max(10, Math.min(15, 8.5 + Math.sqrt(a) / 22));
    return { c, a, size, x: sx(c.capPt), y: sy(c.capPt) };
  }).filter((d) => d.x > -50 && d.x < w + 50 && d.y > -20 && d.y < h + 20 && (d.a > 260 || d.c.id === sel))
    .sort((a, b) => (b.c.id === sel) - (a.c.id === sel) || b.a - a.a);
  const boxes = []; const out = [];
  for (const d of cands) {
    const tw = d.c.name.length * d.size * (d.c.kind === 'culture' ? 0.5 : 0.68) + 6;
    const bx = [d.x - tw / 2, d.y - d.size - 6, d.x + tw / 2, d.y - 3];
    if (d.c.id !== sel && boxes.some((b) => bx[0] < b[2] && bx[2] > b[0] && bx[1] < b[3] && bx[3] > b[1])) continue;
    boxes.push(bx); out.push(d);
  }
  labG.selectAll('circle.capdot').data(out, (d) => d.c.id).join('circle').attr('class', 'capdot').attr('r', 2.6)
    .attr('cx', (d) => d.x).attr('cy', (d) => d.y).style('fill', (d) => `var(--c-${d.c.s})`);
  labG.selectAll('text.lab').data(out, (d) => d.c.id).join('text').attr('class', (d) => `lab${d.c.kind === 'culture' ? ' culture' : ''}`)
    .attr('x', (d) => d.x).attr('y', (d) => d.y - 6).style('font-size', (d) => d.size + 'px').text((d) => d.c.name);
}

function drawOverlay() { drawRoutes(); drawEvents(); drawLabels(); }
function drawMap() { drawCivs(); drawOverlay(); }

// ---------- header controls ----------
const VIEW_BUTTONS = ['silk', 'med', 'ocean', 'east', 'world'];
d3.select('#views').selectAll('button').data(VIEW_BUTTONS).join('button').attr('type', 'button').text((d) => VIEWS[d].name).on('click', (ev, d) => setView(d));
const LAYERS = [
  { id: 'civs', name: 'Civilisations', glyph: '<rect x="1" y="1" width="20" height="8" rx="2" fill="var(--c-ne)" fill-opacity=".45" stroke="var(--c-ne)"/>' },
  { id: 'routes', name: 'Trade routes', glyph: '<path d="M0,3H22" stroke="var(--gold)" stroke-width="2" stroke-dasharray="5 3"/><path d="M0,8H22" stroke="var(--searoute)" stroke-width="2" stroke-dasharray="1.5 3.5" stroke-linecap="round"/>' },
  { id: 'journeys', name: 'Journeys', glyph: '<path d="M1,8Q11,-2 21,6" fill="none" stroke="var(--journey)" stroke-width="1.6" stroke-dasharray="4 2.5"/><circle cx="21" cy="6" r="2.4" fill="var(--journey)"/>' },
  { id: 'ideas', name: 'Spread of ideas', glyph: '<path d="M1,8Q11,-2 21,6" fill="none" stroke="var(--idea)" stroke-width="1.8"/><circle cx="1" cy="8" r="2.4" fill="var(--idea)"/><circle cx="21" cy="6" r="2.4" fill="var(--idea)"/>' },
  { id: 'wars', name: 'Battles', glyph: '<path transform="translate(11,5)" d="M0,-5L1.5,-1.5L5,0L1.5,1.5L0,5L-1.5,1.5L-5,0L-1.5,-1.5Z" fill="var(--war)"/>' },
];
d3.select('#layers').selectAll('button').data(LAYERS).join('button').attr('type', 'button').attr('class', 'layer')
  .html((d) => `<svg viewBox="0 0 22 10" aria-hidden="true">${d.glyph}</svg>${d.name}`)
  .attr('aria-pressed', (d) => String(state.layers[d.id]))
  .on('click', function (ev, d) { state.layers[d.id] = !state.layers[d.id]; d3.select(this).attr('aria-pressed', String(state.layers[d.id])); drawMap(); renderPanel(); });

const about = document.getElementById('about');
d3.select('#aboutbtn').on('click', () => about.showModal());
d3.select('#aboutclose').on('click', () => about.close());

// ---------- panel ----------
const panel = d3.select('#panel');
const glyphFor = (kind) => ({
  land: '<svg class="glyph" viewBox="0 0 14 10"><path d="M0,5H14" stroke="var(--gold)" stroke-width="2.2" stroke-dasharray="4 2"/></svg>',
  sea: '<svg class="glyph" viewBox="0 0 14 10"><path d="M1,5H13" stroke="var(--searoute)" stroke-width="2.2" stroke-dasharray="1 3" stroke-linecap="round"/></svg>',
  voyage: '<svg class="glyph" viewBox="0 0 14 10"><path d="M1,5H13" stroke="var(--searoute)" stroke-width="2.2" stroke-dasharray="5 2 1 2"/></svg>',
  conflict: '<svg class="glyph" viewBox="-7 -5 14 10"><path d="M0,-5L1.5,-1.5L5,0L1.5,1.5L0,5L-1.5,1.5L-5,0L-1.5,-1.5Z" fill="var(--war)"/></svg>',
  journey: '<svg class="glyph" viewBox="0 0 14 10"><path d="M1,8Q7,0 13,6" fill="none" stroke="var(--journey)" stroke-width="1.6" stroke-dasharray="3 2"/></svg>',
  spread: '<svg class="glyph" viewBox="0 0 14 10"><path d="M1,8Q7,0 13,6" fill="none" stroke="var(--idea)" stroke-width="1.8"/></svg>',
}[kind]);
const inShape = (c, y, p) => frameAt(c, y).pts.some((r) => d3.polygonContains(r, p));

function selectedHTML() {
  const s = state.sel; const y = state.year;
  if (!s) return '';
  if (s.type === 'civ') {
    const c = CIVS.find((d) => d.id === s.id);
    const on = isActive(c, y);
    let body = `<p>${esc(c.note)}</p><p class="yrs">${c.kind === 'culture' ? 'Centre' : 'Capital'}: ${esc(c.cap[1])}</p>`;
    if (on) {
      const rts = ROUTES.filter((r) => routeActive(r, y) && r.pts.flat().some((p) => inShape(c, y, p)));
      const evs = EVENTS.filter((e) => evVisible(e, y) && (e.kind === 'conflict' ? inShape(c, y, e.pt) : e.br.flat().some((st) => st.y <= y && inShape(c, y, st.p))));
      body += `<div class="group"><h3>Connected in ${fmtYear(y)}</h3>${rts.length || evs.length ? `<ul class="list">${rts.map(routeItem).join('')}${evs.map(eventItem).join('')}</ul>` : '<p class="empty">No routes or events on the map touch it this year.</p>'}</div>`;
    } else {
      body += `<p><button class="btn" type="button" data-jump="${peakYear(c)}">Go to ${fmtYear(peakYear(c))}</button></p>`;
    }
    return `<section class="card"><div class="eyebrow"><span style="color:var(--c-${c.s})">● ${esc(sphereName[c.s])}${c.kind === 'culture' ? ' · culture' : ''}</span><button class="x" type="button" data-close aria-label="Close">×</button></div><h2>${esc(c.name)}</h2><div class="yrs">${fmtSpan(c.from, Math.min(c.to, MAX))}</div>${body}</section>`;
  }
  if (s.type === 'route') {
    const r = ROUTES.find((d) => d.id === s.id);
    const on = routeActive(r, y);
    const along = on ? CIVS.filter((c) => isActive(c, y) && r.pts.flat().some((p) => inShape(c, y, p))) : [];
    return `<section class="card"><div class="eyebrow"><span>${r.kind === 'land' ? 'Overland route' : r.kind === 'voyage' ? 'Voyages' : 'Sea route'}</span><button class="x" type="button" data-close aria-label="Close">×</button></div><h2>${esc(r.name)}</h2><div class="yrs">${fmtSpan(r.from, r.to)}</div><p style="margin-top:8px">${esc(r.note)}</p><p class="yrs">Carried: ${esc(r.goods)}</p>${on ? `<div class="group"><h3>Powers along it in ${fmtYear(y)}</h3><div class="chips">${along.map(civChip).join('') || '<span class="empty">None drawn</span>'}</div></div>` : `<p><button class="btn" type="button" data-jump="${Math.round((r.from + r.to) / 2)}">Go to ${fmtYear(Math.round((r.from + r.to) / 2))}</button></p>`}</section>`;
  }
  const e = EVENTS.find((d) => d.id === s.id);
  const kindName = { conflict: 'Battle or conquest', journey: 'Journey', spread: 'Spread' }[e.kind];
  const stops = e.kind === 'conflict' ? '' : `<p class="stops">${[...new Map(e.br.flat().map((st) => [st.label + st.y, st])).values()].sort((a, b) => a.y - b.y).map((st) => `${esc(st.label)} <span class="yrs">${fmtYear(st.y)}</span>`).join(' · ')}</p>`;
  return `<section class="card"><div class="eyebrow"><span>${kindName}</span><button class="x" type="button" data-close aria-label="Close">×</button></div><h2>${esc(e.title)}</h2><div class="yrs">${evYears(e)}</div><p style="margin-top:8px">${esc(e.note)}</p>${stops}${evVisible(e, y) ? '' : `<p><button class="btn" type="button" data-jump="${Math.round(e.end)}">Go to ${fmtYear(e.end)}</button></p>`}</section>`;
}
const civChip = (c) => `<button class="chip${c.kind === 'culture' ? ' culture' : ''}" type="button" data-civ="${c.id}" style="color:var(--c-${c.s})"><i style="background:var(--c-${c.s})"></i><span style="color:var(--fg)">${esc(c.name)}</span></button>`;
const routeItem = (r) => `<li><button type="button" data-route="${r.id}">${glyphFor(r.kind)}<span>${esc(r.name)}</span><span class="yrs">${r.kind === 'land' ? 'land' : 'sea'}</span></button></li>`;
const eventItem = (e) => `<li><button type="button" data-event="${e.id}">${glyphFor(e.kind)}<span>${esc(e.title)}</span><span class="yrs">${e.kind === 'conflict' ? fmtYear(e.year) : fmtYear(e.start)}</span></button></li>`;

function tourHTML() {
  const i = state.chapter;
  if (i < 0) {
    return `<section class="card tour"><div class="eyebrow"><span>Guided tour · ${CHAPTERS.length} stops</span></div><h2>Five thousand years of contact</h2><p>Each stop moves the map to a moment when distant peoples met, traded or fought. Or drag the timeline and explore.</p><ol>${CHAPTERS.map((c, j) => `<li><button type="button" data-chapter="${j}"><span class="yrs">${fmtYear(c.year)}</span><span>${esc(c.title)}</span></button></li>`).join('')}</ol></section>`;
  }
  const c = CHAPTERS[i];
  return `<section class="card tour"><div class="eyebrow"><span>Stop ${i + 1} of ${CHAPTERS.length} · ${fmtYear(c.year)}</span><button class="x" type="button" data-endtour aria-label="Leave tour">×</button></div><h2>${esc(c.title)}</h2><p>${esc(c.text)}</p><div class="tournav"><button class="btn" type="button" data-chapter="${i - 1}" ${i === 0 ? 'disabled' : ''}>Previous</button><button class="btn primary" type="button" data-chapter="${i + 1}" ${i === CHAPTERS.length - 1 ? 'disabled' : ''}>Next stop</button><button class="btn" type="button" data-replay="${i}">Replay</button></div></section>`;
}

function nowHTML() {
  const y = state.year;
  const civs = CIVS.filter((c) => isActive(c, y));
  const groups = SPHERES.map((s) => [s, civs.filter((c) => c.s === s.id).sort((a, b) => frameAt(b, y).area - frameAt(a, y).area)]).filter(([, l]) => l.length);
  const rts = ROUTES.filter((r) => routeActive(r, y));
  const evs = EVENTS.filter((e) => evVisible(e, y) && state.layers[evLayer(e)]).sort((a, b) => b.start - a.start);
  return `<section class="card"><div class="eyebrow"><span>On the map in ${fmtYear(y)}</span><span>${civs.length} powers</span></div>
    ${groups.map(([s, l]) => `<div class="group"><h3>${esc(s.name)}</h3><div class="chips">${l.map(civChip).join('')}</div></div>`).join('') || '<p class="empty">Nothing drawn for this year.</p>'}
    <div class="group"><h3>Trade routes in use</h3>${rts.length ? `<ul class="list">${rts.map(routeItem).join('')}</ul>` : '<p class="empty">No long-distance routes drawn for this year.</p>'}</div>
    <div class="group"><h3>Events in view</h3>${evs.length ? `<ul class="list">${evs.map(eventItem).join('')}</ul>` : '<p class="empty">No journeys, spreads or battles in view.</p>'}</div></section>`;
}

let panelKey = '';
function renderPanel(force) {
  const y = Math.round(state.year);
  const key = [y, state.chapter, state.sel && state.sel.type + state.sel.id, Object.values(state.layers).join()].join('|');
  if (!force && key === panelKey) return;
  panelKey = key;
  const st = panel.node().scrollTop;
  panel.html(tourHTML() + selectedHTML() + nowHTML());
  panel.node().scrollTop = st;
}
panel.on('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const ds = b.dataset;
  if (ds.chapter !== undefined) playChapter(+ds.chapter);
  else if (ds.replay !== undefined) playChapter(+ds.replay);
  else if (ds.endtour !== undefined) { state.chapter = -1; renderPanel(true); drawTimelineMarks(); }
  else if (ds.close !== undefined) select(null);
  else if (ds.civ) select({ type: 'civ', id: ds.civ });
  else if (ds.route) select({ type: 'route', id: ds.route });
  else if (ds.event) {
    const e = EVENTS.find((d) => d.id === ds.event);
    if (!evVisible(e, state.year)) setYear(e.kind === 'conflict' ? e.year + 1 : e.end);
    select({ type: 'event', id: ds.event });
  } else if (ds.jump) { stop(); setYear(+ds.jump); }
});
panel.on('mouseover', (ev) => {
  const b = ev.target.closest('button[data-civ]');
  civG.selectAll('path.civ').classed('sel', (d) => !!b && d.c.id === b.dataset.civ);
});
panel.on('mouseout', () => drawCivs());

function select(s) {
  state.sel = s && state.sel && state.sel.type === s.type && state.sel.id === s.id ? null : s;
  drawMap(); renderPanel(true); drawTimelineMarks();
}
svg.on('click', () => { if (state.sel) select(null); });

// ---------- timeline ----------
const tl = d3.select('#timeline');
const TL = { left: 84, right: 12, top: 26, laneGap: 5, bar: 3, rowGap: 1 };
let tx = d3.scaleLinear().domain([MIN, MAX]);
const lanes = SPHERES.map((s) => {
  const civs = CIVS.filter((c) => c.s === s.id).sort((a, b) => a.from - b.from);
  const rowsEnd = [];
  for (const c of civs) {
    let r = rowsEnd.findIndex((e) => e <= c.from);
    if (r < 0) { r = rowsEnd.length; rowsEnd.push(0); }
    rowsEnd[r] = c.to; c.row = r;
  }
  return { s, civs, rows: Math.max(1, rowsEnd.length) };
});
let y0 = TL.top;
for (const l of lanes) { l.y = y0; l.h = Math.max(12, l.rows * (TL.bar + TL.rowGap)); y0 += l.h + TL.laneGap; }
const TLH = y0 + 4;
const tlAxis = tl.append('g').attr('class', 'tl-axis');
const tlLanes = tl.append('g');
const tlMarks = tl.append('g');
const tlCur = tl.append('g').style('pointer-events', 'none');
tlCur.append('line').attr('class', 'cur');
tlCur.append('rect').attr('class', 'curbox').attr('rx', 3);
tlCur.append('text').attr('class', 'curlab').attr('text-anchor', 'middle');

function layoutTimeline() {
  const w = tl.node().clientWidth || 800;
  const narrow = w < 560;
  TL.left = narrow ? 8 : 84;
  tl.attr('height', TLH).attr('viewBox', `0 0 ${w} ${TLH}`);
  tx = d3.scaleLinear().domain([MIN, MAX]).range([TL.left, w - TL.right]);
  const ticks = d3.range(MIN, MAX + 1, w < 420 ? 1500 : narrow ? 1000 : 500);
  tlAxis.selectAll('g').data(ticks).join((en) => { const g = en.append('g'); g.append('line'); g.append('text'); return g; })
    .attr('transform', (d) => `translate(${tx(d)},0)`)
    .call((g) => g.select('line').attr('y1', 14).attr('y2', TLH))
    .call((g) => g.select('text').attr('y', 10).attr('text-anchor', (d) => (d === MIN ? 'start' : d === MAX ? 'end' : 'middle')).text((d) => (d === 0 ? 'AD 1' : fmtYear(d))));
  tlLanes.selectAll('text.lane-lab').data(narrow ? [] : lanes).join('text').attr('class', 'lane-lab').attr('x', 0).attr('y', (l) => l.y + Math.min(l.h, 12) - 2)
    .text((l) => ({ med: 'Europe', ne: 'Near East', af: 'Africa', sa: 'South Asia', st: 'Steppe', ea: 'East Asia', se: 'SE Asia', am: 'Americas' }[l.s.id]))
    .style('fill', (l) => `var(--c-${l.s.id})`);
  tlLanes.selectAll('rect.bar').data(lanes.flatMap((l) => l.civs.map((c) => ({ c, l }))), (d) => d.c.id).join((en) => en.append('rect').attr('class', 'bar')
    .on('mousemove', (ev, d) => { const r = tl.node().getBoundingClientRect(); showTipAt(ev.clientX, r.top, civTip(d.c)); }).on('mouseleave', hideTip))
    .attr('x', (d) => tx(Math.max(MIN, d.c.from))).attr('width', (d) => Math.max(2, tx(Math.min(MAX, d.c.to)) - tx(Math.max(MIN, d.c.from))))
    .attr('y', (d) => d.l.y + d.c.row * (TL.bar + TL.rowGap)).attr('height', TL.bar).attr('rx', 1)
    .style('fill', (d) => `var(--c-${d.c.s})`);
  drawTimelineMarks(); drawCursor();
}
function showTipAt(cx, top, html) {
  const r = wrap.getBoundingClientRect();
  tip.html(html).attr('hidden', null);
  const tw = tip.node().offsetWidth, th = tip.node().offsetHeight;
  tip.style('left', Math.min(r.width - tw - 8, Math.max(6, cx - r.left - tw / 2)) + 'px').style('top', Math.max(6, Math.min(r.height - th - 8, top - r.top - th - 8)) + 'px');
}
function drawTimelineMarks() {
  const sel = state.sel && state.sel.type === 'civ' ? state.sel.id : null;
  tlLanes.selectAll('rect.bar').classed('off', (d) => !isActive(d.c, state.year)).classed('sel', (d) => d.c.id === sel);
  tlMarks.selectAll('path.chap').data(CHAPTERS).join((en) => en.append('path').attr('class', 'chap').attr('d', 'M0,-5L5,0L0,5L-5,0Z')
    .on('click', (ev, d) => { ev.stopPropagation(); playChapter(CHAPTERS.indexOf(d)); })
    .on('pointerdown', (ev) => ev.stopPropagation())
    .on('mousemove', (ev, d) => { const r = tl.node().getBoundingClientRect(); showTipAt(ev.clientX, r.top, `<b>${esc(d.title)}</b><span class="yrs">Tour stop · ${fmtYear(d.year)}</span>`); }).on('mouseleave', hideTip))
    .attr('transform', (d) => `translate(${tx(d.year)},19)`).classed('on', (d, i) => i === state.chapter);
}
function drawCursor() {
  const x = tx(state.year); const lab = fmtYear(state.year); const w = lab.length * 7 + 10;
  const [lo, hi] = tx.range();
  const bx = Math.max(lo, Math.min(hi - w, x - w / 2));
  tlCur.select('line').attr('x1', x).attr('x2', x).attr('y1', 14).attr('y2', TLH);
  tlCur.select('rect').attr('x', bx).attr('y', 0).attr('width', w).attr('height', 15);
  tlCur.select('text').attr('x', bx + w / 2).attr('y', 11).text(lab);
}
let dragging = false, downX = 0;
tl.on('pointerdown', (ev) => { dragging = true; downX = ev.clientX; tl.node().setPointerCapture(ev.pointerId); stop(); scrub(ev); });
tl.on('pointermove', (ev) => { if (dragging) scrub(ev); });
tl.on('pointerup', (ev) => {
  dragging = false;
  if (Math.abs(ev.clientX - downX) < 3) {
    const t = document.elementFromPoint(ev.clientX, ev.clientY);
    const d = t && t.classList.contains('bar') ? d3.select(t).datum() : null;
    if (d) { if (!isActive(d.c, state.year)) setYear(peakYear(d.c)); select({ type: 'civ', id: d.c.id }); }
  }
});
function scrub(ev) {
  const r = tl.node().getBoundingClientRect();
  setYear(Math.round(tx.invert(ev.clientX - r.left)));
}

// ---------- time ----------
function setYear(y) {
  state.year = Math.max(MIN, Math.min(MAX, y));
  d3.select('#stampyear').text(fmtYear(state.year));
  const ch = state.chapter >= 0 ? CHAPTERS[state.chapter] : null;
  d3.select('#stampsub').text(ch && Math.abs(ch.year - state.year) < 1 ? ch.title : '');
  drawMap(); drawCursor(); drawTimelineMarks(); renderPanel();
}
let raf = null, last = 0;
const playBtn = d3.select('#play');
const PLAY = '<svg viewBox="0 0 16 16"><path d="M3 1.5v13l11-6.5z"/></svg>', PAUSE = '<svg viewBox="0 0 16 16"><path d="M3 1.5h3.5v13H3zM9.5 1.5H13v13H9.5z"/></svg>';
function play() {
  if (state.year >= MAX) setYear(MIN);
  state.playing = true; playBtn.html(PAUSE).attr('aria-label', 'Pause'); last = performance.now();
  const step = (now) => {
    if (!state.playing) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    setYear(state.year + dt * +d3.select('#speed').property('value'));
    if (state.year >= MAX) { stop(); return; }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}
function stop() { state.playing = false; cancelAnimationFrame(raf); cancelAnimationFrame(tweenRaf); playBtn.html(PLAY).attr('aria-label', 'Play'); }
playBtn.on('click', () => (state.playing ? stop() : play()));
let tweenRaf = null;
function playChapter(i) {
  if (i < 0 || i >= CHAPTERS.length) return;
  stop();
  state.chapter = i; state.sel = null;
  const c = CHAPTERS[i];
  setView(c.view);
  renderPanel(true);
  const reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const from = c.from ?? c.year, dur = reduce ? 0 : Math.min(4200, Math.max(1400, Math.abs(c.year - from) * 40));
  const t0 = performance.now();
  const step = (now) => {
    const u = dur ? Math.min(1, (now - t0) / dur) : 1;
    setYear(from + (c.year - from) * d3.easeCubicOut(u));
    if (u < 1) tweenRaf = requestAnimationFrame(step); else { setYear(c.year); }
  };
  tweenRaf = requestAnimationFrame(step);
}
document.addEventListener('keydown', (ev) => {
  if (about.open || ev.target.closest('select, input')) return;
  if (ev.key === 'ArrowRight' || ev.key === 'ArrowLeft') { stop(); setYear(Math.round(state.year) + (ev.key === 'ArrowRight' ? 1 : -1) * (ev.shiftKey ? 100 : 10)); ev.preventDefault(); }
  else if (ev.key === ' ' && !ev.target.closest('button')) { state.playing ? stop() : play(); ev.preventDefault(); }
});

// ---------- boot ----------
let resizeT;
new ResizeObserver(() => { clearTimeout(resizeT); resizeT = setTimeout(() => { layoutTimeline(); setView(state.view, false); }, 60); }).observe(document.body);
layoutTimeline();
setView('silk', false);
setYear(state.year);
renderPanel(true);
})();

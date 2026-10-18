(() => {
const MIN = -3000, MAX = 1500;
const BW = 1000, BH = 520;
const proj = d3.geoNaturalEarth1().rotate([-20, 0]).fitExtent([[0, 0], [BW, BH]], { type: 'Sphere' });
const gpath = d3.geoPath(proj);
const pr = (p) => proj(p);

const state = { year: 100, playing: false, layers: { civs: true, cities: true, routes: true, journeys: true, ideas: true, wars: true }, sel: null, chapter: -1, view: 'silk' };
let T = d3.zoomIdentity;
let pinnedAt = null; // map position read from the URL, kept until the reader pans or zooms (the map may still be moving there)

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// ---------- language ----------
// English is written in data.js, details.js and UI_EN; other languages come from i18n/<lang>.js (I18N.<lang>:
// interface strings, year formats and translations of the data by id). The language is chosen like on the main
// site: ?lang=, then the saved choice (localStorage "lang", shared with the site), then the browser's languages.
const UI_EN = {
  title: 'Ancient Crossroads', range: '3000 BC – AD 1500', about: 'How this map was made', credit: 'Borders approximate · Coastlines: Natural Earth',
  'aria.views': 'Map view', 'aria.layers': 'Layers', 'aria.map': 'Map of civilisations, routes and events', 'aria.zin': 'Zoom in', 'aria.zout': 'Zoom out',
  'aria.play': 'Play', 'aria.pause': 'Pause', 'aria.speed': 'Playback speed', 'aria.timeline': 'Timeline: drag to change the year', 'aria.lang': 'Language',
  close: 'Close', leaveTour: 'Leave tour', speed: '{n} yr/s',
  'layer.civs': 'Civilisations', 'layer.routes': 'Trade routes', 'layer.journeys': 'Journeys', 'layer.ideas': 'Spread of ideas', 'layer.wars': 'Battles',
  'lane.med': 'Europe', 'lane.ne': 'Near East', 'lane.af': 'Africa', 'lane.sa': 'South Asia', 'lane.st': 'Steppe', 'lane.ea': 'East Asia', 'lane.se': 'SE Asia', 'lane.am': 'Americas',
  culture: 'culture', capital: 'capital: {name}', centre: 'centre: {name}', circa: 'c. ', circaSuffix: ' (c.)',
  'route.land': 'Overland route', 'route.sea': 'Sea route', 'route.voyage': 'Voyages', 'route.short.land': 'land', 'route.short.sea': 'sea',
  carried: 'Carried: {goods}', powersAlong: 'Powers along it in {year}', noneDrawn: 'None drawn', goTo: 'Go to {year}',
  'event.conflict': 'Battle or conquest', 'event.journey': 'Journey', 'event.spread': 'Spread',
  'status.notYet': 'Not yet founded: it begins in {year}, {n} from now.', 'status.gone': 'Gone by now: it ended in {year}, {n} earlier.',
  'status.founded': '{n} since it was founded', 'status.emerged': '{n} since it emerged', 'status.left': '; {n} left', 'status.end': '.',
  'stop.emerges': 'Emerges', 'stop.founded': 'Founded', 'stop.peak': 'Greatest extent', 'stop.borders': 'Borders redrawn', 'stop.final': 'Final years: it ends in {year}',
  'step.prev': 'Previous key moment ([ or ])', 'step.next': 'Next key moment ([ or ])', 'step.earlier': '‹ Earlier', 'step.later': 'Later ›',
  'step.noneBefore': 'Nothing before this', 'step.noneAfter': 'Nothing after this', cameBefore: 'Came before', cameAfter: 'Came after',
  inYear: 'In {year}', population: 'Population', connections: 'Connections', elsewhere: 'Meanwhile elsewhere', moments: 'Key moments',
  image: 'Image: {artist}', unknown: 'unknown', fromWiki: 'From Wikipedia', fromWikiEn: 'From Wikipedia', readWiki: 'Read “{title}” on Wikipedia ↗',
  readMore: 'Read more on Wikipedia ↗', wikiLicence: 'Text: Wikipedia, CC BY-SA 4.0',
  'tour.eyebrow': 'Guided tour · {n} stops', 'tour.title': 'Five thousand years of contact',
  'tour.intro': 'Each stop moves the map to a moment when distant peoples met, traded or fought. Or drag the timeline and explore.',
  'tour.stop': 'Stop {i} of {n} · {year}', 'tour.prev': 'Previous', 'tour.next': 'Next stop', 'tour.replay': 'Replay', 'tour.tip': 'Tour stop · {year}',
  'layer.cities': 'Cities', 'city.kind': 'City', 'city.ruler': 'Ruled by', 'city.estimate': 'rough estimate',
  'city.peak': 'Peak: {n} ({year})', 'city.chart': 'Population over time', 'city.notYet': 'Not yet a city in this year.', 'city.gone': 'Abandoned or destroyed by this year.',
  'now.cities': 'Largest cities', 'now.noCities': 'No cities drawn for this year.',
  'now.title': 'On the map in {year}', 'now.powers': '{n} powers', 'now.nothing': 'Nothing drawn for this year.', 'now.routes': 'Trade routes in use',
  'now.noRoutes': 'No long-distance routes drawn for this year.', 'now.events': 'Events in view', 'now.noEvents': 'No journeys, spreads or battles in view.',
  share: 'Copy link', shared: 'Link copied', 'share.prompt': 'Copy this link:',
};
const LANGS = { en: 'English', ...Object.fromEntries(Object.entries(I18N).map(([k, v]) => [k, v.native])) };
const LANG = (() => {
  const q = new URLSearchParams(location.search).get('lang');
  if (LANGS[q]) return q;
  try { const saved = localStorage.getItem('lang'); if (LANGS[saved]) return saved; } catch { /* storage blocked */ }
  for (const l of navigator.languages ?? [navigator.language]) { const code = l?.toLowerCase().split('-')[0]; if (LANGS[code]) return code; }
  return 'en';
})();
const TR = LANG === 'en' ? null : I18N[LANG];
const UI = { ...UI_EN, ...(TR ? TR.ui : {}) };
const msg = (k, vars = {}) => (UI[k] ?? k).replace(/\{(\w+)\}/g, (m, v) => (v in vars ? vars[v] : m));
const fmtYear = TR?.year ?? ((y) => { const r = Math.round(y); return r < 0 ? `${-r} BC` : `AD ${Math.max(r, 1)}`; });
const fmtSpan = TR?.span ?? ((a, b) => (a < 0 && b < 0) ? `${-a}–${-b} BC` : (a < 0 ? `${-a} BC – AD ${Math.max(b, 1)}` : `AD ${Math.max(a, 1)}–${b}`));
const fmtTick = TR?.tick ?? fmtYear; // timeline axis labels
// Population given in thousands, rounded to two significant figures.
const fmtPeople = TR?.people ?? ((k) => (k >= 1000 ? `about ${+(k / 1000).toFixed(1)} million` : `about ${(+k.toPrecision(2) * 1000).toLocaleString('en')}`));
const plural = TR?.years ?? ((n) => `${n.toLocaleString('en')} year${n === 1 ? '' : 's'}`);

// Translate the data in place. Anything without a translation stays in English and is listed in
// window.__i18nMissing (the smoke test requires it to be empty).
const missing = [];
if (TR) {
  const each = (list, table, kind, apply) => { for (const d of list) { const v = table[d.id]; if (v) apply(d, v); else missing.push(`${kind} ${d.id}`); } };
  each(SPHERES, TR.spheres, 'sphere', (s, v) => { s.name = v; });
  each(Object.entries(VIEWS).map(([id, v]) => ({ id, v })), TR.views, 'view', (d, v) => { d.v.name = v; });
  each(CIVS, TR.civs, 'civ', (c, [name, cap, note]) => { c.name = name; c.cap = [c.cap[0], cap]; c.note = note; });
  each(ROUTES, TR.routes, 'route', (r, [name, goods, note]) => { r.name = name; r.goods = goods; r.note = note; });
  each(EVENTS, TR.events, 'event', (e, [title, note]) => { e.title = title; e.note = note; });
  each(CITIES, TR.cities, 'city', (c, [name, note]) => { c.name = name; c.note = note; });
  for (const e of EVENTS) for (const b of e.branches || []) for (const st of b) {
    if (TR.places[st[3]]) st[3] = TR.places[st[3]]; else missing.push(`place ${st[3]}`);
  }
  CHAPTERS.forEach((c, i) => { const v = TR.chapters[i]; if (v) [c.title, c.text] = v; else missing.push(`chapter ${i}`); });
  for (const [id, list] of Object.entries(MOMENTS)) {
    const v = TR.moments[id];
    if (v && v.length === list.length) list.forEach((m, i) => { m[1] = v[i]; }); else missing.push(`moments ${id}`);
  }
  for (const [id, list] of Object.entries(POP)) {
    const v = TR.pop[id];
    if (v && v.length === list.length) list.forEach((p, i) => { [p[1], p[2]] = v[i]; }); else missing.push(`pop ${id}`);
  }
  for (const k of Object.keys(SUCCESSIONS)) if (!TR.successions[k]) missing.push(`succession ${k}`);
  for (const k of Object.keys(UI_EN)) if (!(k in TR.ui)) missing.push(`ui ${k}`);
  if (missing.length) console.warn(`${LANG}: ${missing.length} missing translations`, missing);
}
window.__i18nMissing = missing;
const successionName = (k) => (TR ? TR.successions[k] || k : k);
// Rough text width for label placement: CJK characters are about one em wide.
const textWidth = (s, size, latin) => [...s].reduce((w, ch) => w + (ch.codePointAt(0) >= 0x2e80 ? size : size * latin), 0);

// Static text in page.html, the language menu and the document language.
document.documentElement.lang = TR?.htmlLang ?? 'en';
document.title = msg('title');
if (TR) {
  for (const el of document.querySelectorAll('[data-i18n]')) el.innerHTML = msg(el.dataset.i18n);
  for (const el of document.querySelectorAll('[data-i18n-aria]')) el.setAttribute('aria-label', msg(el.dataset.i18nAria));
  if (TR.about) document.getElementById('aboutbody').innerHTML = TR.about;
}
for (const o of document.querySelectorAll('#speed option')) o.textContent = msg('speed', { n: o.value });
d3.select('#lang').attr('aria-label', msg('aria.lang')).selectAll('option').data(Object.entries(LANGS)).join('option')
  .attr('value', (d) => d[0]).property('selected', (d) => d[0] === LANG).text((d) => d[1]);
d3.select('#lang').on('change', function () {
  try { localStorage.setItem('lang', this.value); } catch { /* storage blocked */ }
  flushURL();
  const u = new URL(location.href);
  if (this.value === 'en') u.searchParams.delete('lang'); else u.searchParams.set('lang', this.value);
  location.href = u.href;
});
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
for (const c of CITIES) { c.p = pr(c.at); c.from = c.pop[0][0]; c.peak = c.pop.reduce((a, b) => (b[1] > a[1] ? b : a)); }
// Population (thousands) at a year: interpolated between keyframes, 0 before the first, the last value after the last.
function cityPop(c, y) {
  const k = c.pop;
  if (y < k[0][0]) return 0;
  for (let i = 1; i < k.length; i++) if (y < k[i][0]) return k[i - 1][1] + (k[i][1] - k[i - 1][1]) * (y - k[i - 1][0]) / (k[i][0] - k[i - 1][0]);
  return k[k.length - 1][1];
}
const cityR = (k) => 2.2 + 0.2 * Math.sqrt(k);
// The state whose shape holds a city in a year (states before cultures, then the smallest shape).
const rulerOf = (city, y) => CIVS.filter((c) => isActive(c, y) && frameAt(c, y).pts.some((r) => d3.polygonContains(r, city.p)))
  .sort((a, b) => (a.kind === 'culture') - (b.kind === 'culture') || frameAt(a, y).area - frameAt(b, y).area)[0];
const evVisible = (e, y) => y >= e.win[0] && y <= e.win[1];
const evLayer = (e) => (e.kind === 'conflict' ? 'wars' : e.kind === 'journey' ? 'journeys' : 'ideas');
const evYears = (e) => (e.kind === 'conflict' ? fmtYear(e.year) : (Math.round(e.start) === Math.round(e.end) ? fmtYear(e.start) : fmtSpan(Math.round(e.start), Math.round(e.end)))) + (e.c ? msg('circaSuffix') : '');

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
const routeG = ov.append('g'), evG = ov.append('g'), cityG = ov.append('g'), labG = ov.append('g'), warG = ov.append('g');

const zoom = d3.zoom().scaleExtent([0.8, 16])
  .on('zoom', (ev) => { T = ev.transform; zg.attr('transform', T); drawOverlay(); if (ev.sourceEvent) customView(); })
  .on('end', () => scheduleURL());
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
function setView(name, animate = true, t = viewTransform(name)) {
  state.view = name;
  (animate ? svg.transition().duration(900).ease(d3.easeCubicInOut) : svg).call(zoom.transform, t);
  d3.selectAll('#views button').attr('aria-pressed', (d) => String(d === name));
}
// After the reader pans or zooms, the map no longer shows a named view; the URL then keeps its centre and zoom.
function customView() {
  pinnedAt = null;
  if (state.view === null) return;
  state.view = null;
  d3.selectAll('#views button').attr('aria-pressed', 'false');
}
// Centre and zoom relative to the world view, so a shared position looks alike on other screen sizes.
function mapPosition() {
  const [w, h] = size();
  const [lon, lat] = proj.invert(T.invert([w / 2, h / 2]));
  return [lon, lat, T.k / viewTransform('world').k];
}
function positionTransform([lon, lat, z]) {
  const [w, h] = size(), k = z * viewTransform('world').k, [px, py] = pr([lon, lat]);
  return d3.zoomIdentity.translate(w / 2 - k * px, h / 2 - k * py).scale(k);
}
d3.select('#zin').on('click', () => { customView(); svg.transition().duration(300).call(zoom.scaleBy, 1.6); });
d3.select('#zout').on('click', () => { customView(); svg.transition().duration(300).call(zoom.scaleBy, 1 / 1.6); });

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
const civTip = (c) => `<b>${esc(c.name)}</b><span class="yrs">${fmtSpan(c.from, Math.min(c.to, MAX))}${c.kind === 'culture' ? ` · ${msg('culture')}` : ''}</span><br>${esc(sphereName[c.s])}`;
const routeTip = (r) => `<b>${esc(r.name)}</b><span class="yrs">${fmtSpan(r.from, r.to)}</span><br>${esc(r.goods)}`;
const cityTip = (c) => { const r = rulerOf(c, state.year); return `<b>${esc(c.name)}</b><span class="yrs">${fmtPeople(cityPop(c, state.year))}</span>${r ? `<br>${esc(r.name)}` : ''}`; };
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

let activeCities = [];
function drawCities() {
  const y = state.year;
  activeCities = state.layers.cities ? CITIES.map((c) => ({ c, k: cityPop(c, y) })).filter((d) => d.k >= 1).sort((a, b) => a.k - b.k) : [];
  const sel = state.sel && state.sel.type === 'city' ? state.sel.id : null;
  cityG.selectAll('circle.city').data(activeCities, (d) => d.c.id).join((en) => en.append('circle')
    .on('mousemove', (ev, d) => showTip(ev, cityTip(d.c))).on('mouseleave', hideTip).on('click', (ev, d) => { ev.stopPropagation(); select({ type: 'city', id: d.c.id }); }))
    .attr('class', (d) => `city${d.c.id === sel ? ' sel' : ''}`).attr('r', (d) => cityR(d.k)).attr('cx', (d) => sx(d.c.p)).attr('cy', (d) => sy(d.c.p)).order();
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
    const tw = textWidth(d.c.name, d.size, d.c.kind === 'culture' ? 0.5 : 0.68) + 6;
    const bx = [d.x - tw / 2, d.y - d.size - 6, d.x + tw / 2, d.y - 3];
    if (d.c.id !== sel && boxes.some((b) => bx[0] < b[2] && bx[2] > b[0] && bx[1] < b[3] && bx[3] > b[1])) continue;
    boxes.push(bx); out.push(d);
  }
  // City names fill the gaps, largest first; small towns only when zoomed in.
  const csel = state.sel && state.sel.type === 'city' ? state.sel.id : null;
  const cout = [];
  for (const d of [...activeCities].sort((a, b) => (b.c.id === csel) - (a.c.id === csel) || b.k - a.k)) {
    const x = sx(d.c.p), y = sy(d.c.p);
    if (x < -20 || x > w + 20 || y < -10 || y > h + 10 || (d.c.id !== csel && d.k * T.k * T.k < 30)) continue;
    const lx = x + cityR(d.k) + 3, tw = textWidth(d.c.name, 11, 0.55);
    const bx = [lx, y - 8, lx + tw, y + 5];
    if (d.c.id !== csel && boxes.some((b) => bx[0] < b[2] && bx[2] > b[0] && bx[1] < b[3] && bx[3] > b[1])) continue;
    boxes.push(bx); cout.push({ c: d.c, x: lx, y });
  }
  labG.selectAll('text.ctag').data(cout, (d) => d.c.id).join('text').attr('class', (d) => `ctag${d.c.id === csel ? ' sel' : ''}`)
    .attr('x', (d) => d.x).attr('y', (d) => d.y + 4).text((d) => d.c.name);
  labG.selectAll('circle.capdot').data(out, (d) => d.c.id).join('circle').attr('class', 'capdot').attr('r', 2.6)
    .attr('cx', (d) => d.x).attr('cy', (d) => d.y).style('fill', (d) => `var(--c-${d.c.s})`);
  labG.selectAll('text.lab').data(out, (d) => d.c.id).join('text').attr('class', (d) => `lab${d.c.kind === 'culture' ? ' culture' : ''}`)
    .attr('x', (d) => d.x).attr('y', (d) => d.y - 6).style('font-size', (d) => d.size + 'px').text((d) => d.c.name);
}

function drawOverlay() { drawRoutes(); drawEvents(); drawCities(); drawLabels(); }
function drawMap() { drawCivs(); drawOverlay(); }

// ---------- header controls ----------
const VIEW_BUTTONS = ['silk', 'med', 'ocean', 'east', 'world'];
d3.select('#views').selectAll('button').data(VIEW_BUTTONS).join('button').attr('type', 'button').text((d) => VIEWS[d].name).on('click', (ev, d) => { markNav(); setView(d); });
const LAYERS = [
  { id: 'civs', glyph: '<rect x="1" y="1" width="20" height="8" rx="2" fill="var(--c-ne)" fill-opacity=".45" stroke="var(--c-ne)"/>' },
  { id: 'cities', glyph: '<circle cx="6" cy="5" r="4" class="city"/><circle cx="16" cy="6" r="2.6" class="city"/>' },
  { id: 'routes', glyph: '<path d="M0,3H22" stroke="var(--gold)" stroke-width="2" stroke-dasharray="5 3"/><path d="M0,8H22" stroke="var(--searoute)" stroke-width="2" stroke-dasharray="1.5 3.5" stroke-linecap="round"/>' },
  { id: 'journeys', glyph: '<path d="M1,8Q11,-2 21,6" fill="none" stroke="var(--journey)" stroke-width="1.6" stroke-dasharray="4 2.5"/><circle cx="21" cy="6" r="2.4" fill="var(--journey)"/>' },
  { id: 'ideas', glyph: '<path d="M1,8Q11,-2 21,6" fill="none" stroke="var(--idea)" stroke-width="1.8"/><circle cx="1" cy="8" r="2.4" fill="var(--idea)"/><circle cx="21" cy="6" r="2.4" fill="var(--idea)"/>' },
  { id: 'wars', glyph: '<path transform="translate(11,5)" d="M0,-5L1.5,-1.5L5,0L1.5,1.5L0,5L-1.5,1.5L-5,0L-1.5,-1.5Z" fill="var(--war)"/>' },
];
d3.select('#layers').selectAll('button').data(LAYERS).join('button').attr('type', 'button').attr('class', 'layer')
  .html((d) => `<svg viewBox="0 0 22 10" aria-hidden="true">${d.glyph}</svg>${msg(`layer.${d.id}`)}`)
  .attr('aria-pressed', (d) => String(state.layers[d.id]))
  .on('click', function (ev, d) { state.layers[d.id] = !state.layers[d.id]; d3.select(this).attr('aria-pressed', String(state.layers[d.id])); drawMap(); renderPanel(); scheduleURL(); });

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
  if (s.type === 'civ') return civHTML(CIVS.find((d) => d.id === s.id), y);
  if (s.type === 'city') return cityHTML(CITIES.find((d) => d.id === s.id), y);
  if (s.type === 'route') {
    const r = ROUTES.find((d) => d.id === s.id);
    const on = routeActive(r, y);
    const along = on ? CIVS.filter((c) => isActive(c, y) && r.pts.flat().some((p) => inShape(c, y, p))) : [];
    return `<section class="card"><div class="eyebrow"><span>${msg(`route.${r.kind}`)}</span>${closeBtn()}</div><h2>${esc(r.name)}</h2><div class="yrs">${fmtSpan(r.from, r.to)}</div><p style="margin-top:8px">${esc(r.note)}</p><p class="yrs">${msg('carried', { goods: esc(r.goods) })}</p>${on ? `<div class="group"><h3>${msg('powersAlong', { year: fmtYear(y) })}</h3><div class="chips">${along.map(civChip).join('') || `<span class="empty">${msg('noneDrawn')}</span>`}</div></div>` : goBtn(Math.round((r.from + r.to) / 2))}</section>`;
  }
  const e = EVENTS.find((d) => d.id === s.id);
  const kindName = msg(`event.${e.kind}`);
  const stops = e.kind === 'conflict' ? '' : `<p class="stops">${[...new Map(e.br.flat().map((st) => [st.label + st.y, st])).values()].sort((a, b) => a.y - b.y).map((st) => `${esc(st.label)} <span class="yrs">${fmtYear(st.y)}</span>`).join(' · ')}</p>`;
  return `<section class="card"><div class="eyebrow"><span>${kindName}</span>${closeBtn()}</div><h2>${esc(e.title)}</h2><div class="yrs">${evYears(e)}</div><p style="margin-top:8px">${esc(e.note)}</p>${stops}${evVisible(e, y) ? '' : goBtn(Math.round(e.end))}</section>`;
}
const closeBtn = () => `<button class="x" type="button" data-close aria-label="${msg('close')}">×</button>`;
const goBtn = (y) => `<p><button class="btn" type="button" data-jump="${y}">${msg('goTo', { year: fmtYear(y) })}</button></p>`;
const yearsBetween = (a, b) => b - a - (a < 0 && b > 0 ? 1 : 0); // there is no year 0

// Significant years of a civilisation, for the card's earlier/later buttons: its key moments, founding,
// greatest drawn extent and final year (or, with no key moments, every year its borders were redrawn).
function civStops(c) {
  const last = Math.min(c.to >= MAX ? MAX : c.to - 1, MAX), at = (y) => Math.max(c.from, Math.min(last, y));
  const stops = (MOMENTS[c.id] || []).map((m) => ({ y: at(m[0]), label: m[1], c }));
  const add = (y, label) => { if (!stops.some((s) => s.y === y)) stops.push({ y, label, c }); };
  add(c.from, msg(c.kind === 'culture' ? 'stop.emerges' : 'stop.founded'));
  if (!MOMENTS[c.id]) for (const f of c.frames) if (f.y > c.from && f.y < last) add(f.y, msg(f === c.peak ? 'stop.peak' : 'stop.borders'));
  add(peakYear(c), msg('stop.peak'));
  if (c.to < MAX) add(last, msg('stop.final', { year: fmtYear(c.to) }));
  return stops;
}
// The succession a civilisation belongs to (SUCCESSIONS in details.js), as civilisations; just itself if none.
const succession = (c) => {
  const ids = Object.values(SUCCESSIONS).find((ids) => ids.includes(c.id));
  return ids ? ids.map((id) => CIVS.find((d) => d.id === id)) : [c];
};
// Steps across the whole succession; when two members share a year, the later-founded one wins.
const successionStops = (c) => succession(c).flatMap(civStops).sort((a, b) => a.y - b.y || b.c.from - a.c.from)
  .filter((s, i, a) => !i || s.y !== a[i - 1].y);
const stepBtn = (s, dir, c) => s
  ? `<button type="button" data-jump="${s.y}" data-step-civ="${s.c.id}" title="${msg(`step.${dir}`)}"><span class="yrs">${dir === 'prev' ? '‹ ' : ''}${fmtYear(s.y)}${dir === 'next' ? ' ›' : ''}</span>${s.c === c ? '' : `<span class="who" style="color:var(--c-${s.c.s})">${esc(s.c.name)}</span>`}<span>${esc(s.label)}</span></button>`
  : `<button type="button" disabled><span class="yrs">${msg(dir === 'prev' ? 'step.earlier' : 'step.later')}</span><span>${msg(dir === 'prev' ? 'step.noneBefore' : 'step.noneAfter')}</span></button>`;
function civStep(c, dir) {
  const yr = Math.round(state.year), stops = successionStops(c);
  return dir === 'prev' ? stops.filter((s) => s.y < yr).pop() : stops.find((s) => s.y > yr);
}
// Moves the year to a step and, if the step belongs to another member of the succession, selects that member.
function goStep(s) {
  stop(); markNav();
  if (state.sel?.type !== 'civ' || state.sel.id !== s.c.id) state.sel = { type: 'civ', id: s.c.id };
  setYear(s.y);
}

function civHTML(c, y) {
  const on = isActive(c, y); const end = Math.min(c.to, MAX); const yr = Math.round(y);
  const info = (typeof WIKI_INFO !== 'undefined' && WIKI_INFO[c.id]) || null;
  const moments = (MOMENTS[c.id] || []).slice().sort((a, b) => a[0] - b[0]);
  const latest = moments.filter((m) => m[0] <= yr).pop();
  const momentYear = (m) => `${m[2] ? msg('circa') : ''}${fmtYear(m[0])}`;

  let status;
  if (yr < c.from) status = msg('status.notYet', { year: fmtYear(c.from), n: plural(yearsBetween(yr, c.from)) });
  else if (!on) status = msg('status.gone', { year: fmtYear(end), n: plural(yearsBetween(end, yr)) });
  else status = msg(c.kind === 'culture' ? 'status.emerged' : 'status.founded', { n: plural(yearsBetween(c.from, yr)) })
    + (c.to < MAX ? msg('status.left', { n: plural(yearsBetween(yr, c.to)) }) : '') + msg('status.end');

  let now = `<div class="stepper">${stepBtn(civStep(c, 'prev'), 'prev', c)}${stepBtn(civStep(c, 'next'), 'next', c)}</div><p class="status">${status}</p>`;
  if (on && latest) now += `<p class="latest"><span class="yrs">${momentYear(latest)}</span> ${esc(latest[1])}</p>`;
  const pop = (POP[c.id] || []).filter((p) => p[0] <= yr + 25).pop() || (on && POP[c.id] ? POP[c.id][0] : null);
  if (pop) now += `<dl class="facts"><dt>${msg('population')}</dt><dd>${esc(pop[1])}<span class="src">${fmtYear(pop[0])} · ${esc(pop[2])}</span></dd></dl>`;
  if (on) {
    const rts = ROUTES.filter((r) => routeActive(r, y) && r.pts.flat().some((p) => inShape(c, y, p)));
    const evs = EVENTS.filter((e) => evVisible(e, y) && (e.kind === 'conflict' ? inShape(c, y, e.pt) : e.br.flat().some((st) => st.y <= y && inShape(c, y, st.p))));
    if (rts.length || evs.length) now += `<div class="group"><h3>${msg('connections')}</h3><ul class="list">${rts.map(routeItem).join('')}${evs.map(eventItem).join('')}</ul></div>`;
    const others = SPHERES.filter((sp) => sp.id !== c.s).map((sp) => CIVS.filter((d) => d.s === sp.id && d.kind !== 'culture' && isActive(d, y))
      .sort((a, b) => frameAt(b, y).area - frameAt(a, y).area)[0]).filter(Boolean);
    if (others.length) now += `<div class="group"><h3>${msg('elsewhere')}</h3><div class="chips">${others.map(civChip).join('')}</div></div>`;
  } else {
    now += goBtn(peakYear(c));
  }

  const img = info && info.img ? `<figure class="pic"><img src="${esc(info.img)}" alt="${esc(info.alt || c.name)}" loading="lazy"><figcaption>${info.credit ? `${msg('image', { artist: esc(info.credit.artist || msg('unknown')) })}${info.credit.license ? `, <a href="${esc(info.credit.page)}" target="_blank" rel="noopener">${esc(info.credit.license)}</a>` : ''}` : ''}</figcaption></figure>` : '';
  const timeline = moments.length ? `<div class="group"><h3>${msg('moments')}</h3><ol class="moments">${moments.map((m) => `<li class="${m[0] > yr ? 'later' : ''}${m === latest && on ? ' now' : ''}"><button type="button" data-jump="${m[0]}"><span class="yrs">${momentYear(m)}</span><span>${esc(m[1])}</span></button></li>`).join('')}</ol></div>` : '';
  // The article in the page's language if there is one, else the English one.
  const art = info && (info[LANG] || info);
  const wiki = art ? `<div class="group"><h3>${msg(art === info && TR ? 'fromWikiEn' : 'fromWiki')}</h3>${art.text ? `<p class="wiki">${esc(art.text)}</p>` : ''}<p class="wikilink"><a href="${esc(art.url)}" target="_blank" rel="noopener">${msg('readWiki', { title: esc(art.title) })}</a></p><p class="yrs">${msg('wikiLicence')}</p></div>`
    : (WIKI[c.id] ? `<div class="group"><p class="wikilink"><a href="https://en.wikipedia.org/wiki/${encodeURIComponent(WIKI[c.id].replace(/ /g, '_'))}" target="_blank" rel="noopener">${msg('readMore')}</a></p></div>` : '');

  const line = succession(c), k = line.indexOf(c), name = Object.keys(SUCCESSIONS).find((n) => SUCCESSIONS[n].includes(c.id));
  const link = (d, dir) => `<button class="chip" type="button" data-civ="${d.id}" title="${msg(dir === 'prev' ? 'cameBefore' : 'cameAfter')}"><i style="background:var(--c-${d.s})"></i><span style="color:var(--fg)">${dir === 'prev' ? '← ' : ''}${esc(d.name)}${dir === 'next' ? ' →' : ''}</span></button>`;
  const seq = name ? `<div class="succession"><span class="yrs">${esc(successionName(name))}:</span>${k > 0 ? link(line[k - 1], 'prev') : ''}${k < line.length - 1 ? link(line[k + 1], 'next') : ''}</div>` : '';
  return `<section class="card civcard"><div class="eyebrow"><span style="color:var(--c-${c.s})">● ${esc(sphereName[c.s])}${c.kind === 'culture' ? ` · ${msg('culture')}` : ''}</span>${closeBtn()}</div>
    <h2>${esc(c.name)}</h2><div class="yrs">${fmtSpan(c.from, end)} · ${msg(c.kind === 'culture' ? 'centre' : 'capital', { name: esc(c.cap[1]) })}</div>
    ${seq}${img}<div class="group"><h3>${msg('inYear', { year: fmtYear(y) })}</h3>${now}</div><p class="note">${esc(c.note)}</p>${timeline}${wiki}</section>`;
}
const civChip = (c) => `<button class="chip${c.kind === 'culture' ? ' culture' : ''}" type="button" data-civ="${c.id}" style="color:var(--c-${c.s})"><i style="background:var(--c-${c.s})"></i><span style="color:var(--fg)">${esc(c.name)}</span></button>`;
const routeItem = (r) => `<li><button type="button" data-route="${r.id}">${glyphFor(r.kind)}<span>${esc(r.name)}</span><span class="yrs">${msg(r.kind === 'land' ? 'route.short.land' : 'route.short.sea')}</span></button></li>`;
const eventItem = (e) => `<li><button type="button" data-event="${e.id}">${glyphFor(e.kind)}<span>${esc(e.title)}</span><span class="yrs">${e.kind === 'conflict' ? fmtYear(e.year) : fmtYear(e.start)}</span></button></li>`;

function tourHTML() {
  const i = state.chapter;
  if (i < 0) {
    return `<section class="card tour"><div class="eyebrow"><span>${msg('tour.eyebrow', { n: CHAPTERS.length })}</span></div><h2>${msg('tour.title')}</h2><p>${msg('tour.intro')}</p><ol>${CHAPTERS.map((c, j) => `<li><button type="button" data-chapter="${j}"><span class="yrs">${fmtYear(c.year)}</span><span>${esc(c.title)}</span></button></li>`).join('')}</ol></section>`;
  }
  const c = CHAPTERS[i];
  return `<section class="card tour"><div class="eyebrow"><span>${msg('tour.stop', { i: i + 1, n: CHAPTERS.length, year: fmtYear(c.year) })}</span><button class="x" type="button" data-endtour aria-label="${msg('leaveTour')}">×</button></div><h2>${esc(c.title)}</h2><p>${esc(c.text)}</p><div class="tournav"><button class="btn" type="button" data-chapter="${i - 1}" ${i === 0 ? 'disabled' : ''}>${msg('tour.prev')}</button><button class="btn primary" type="button" data-chapter="${i + 1}" ${i === CHAPTERS.length - 1 ? 'disabled' : ''}>${msg('tour.next')}</button><button class="btn" type="button" data-replay="${i}">${msg('tour.replay')}</button></div></section>`;
}

// A small chart of a city's population over time, with the selected year marked.
function popChart(c, y) {
  const W = 320, H = 74, P = { l: 4, r: 4, t: 14, b: 16 };
  const last = c.pop[c.pop.length - 1][0], x0 = c.from, x1 = Math.max(last, Math.min(MAX, c.from + 200));
  const xs = d3.scaleLinear([x0, x1], [P.l, W - P.r]), ys = d3.scaleLinear([0, c.peak[1]], [H - P.b, P.t]);
  const pts = [...c.pop.map(([py, k]) => [py, k]), ...(last < x1 ? [[x1, c.pop[c.pop.length - 1][1]]] : [])];
  const area = d3.area().x((d) => xs(d[0])).y0(H - P.b).y1((d) => ys(d[1]))(pts);
  const cur = y >= x0 && y <= x1 ? `<line class="pc-cur" x1="${xs(y)}" x2="${xs(y)}" y1="${P.t - 4}" y2="${H - P.b}"/><circle class="pc-dot" r="3" cx="${xs(y)}" cy="${ys(cityPop(c, y))}"/>` : '';
  return `<svg class="popchart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${msg('city.chart')}"><path class="pc-area" d="${area}"/>${cur}
    <text x="${P.l}" y="10">${msg('city.peak', { n: fmtPeople(c.peak[1]), year: fmtYear(c.peak[0]) })}</text>
    <text x="${P.l}" y="${H - 3}">${fmtYear(x0)}</text><text x="${W - P.r}" y="${H - 3}" text-anchor="end">${fmtYear(x1)}</text></svg>`;
}
function cityHTML(c, y) {
  const k = cityPop(c, y), r = k >= 1 ? rulerOf(c, y) : null;
  const info = (typeof WIKI_INFO !== 'undefined' && WIKI_INFO[`city-${c.id}`]) || null;
  const art = info && (info[LANG] || info);
  const img = info && info.img ? `<figure class="pic"><img src="${esc(info.img)}" alt="${esc(info.alt || c.name)}" loading="lazy"><figcaption>${info.credit ? `${msg('image', { artist: esc(info.credit.artist || msg('unknown')) })}${info.credit.license ? `, <a href="${esc(info.credit.page)}" target="_blank" rel="noopener">${esc(info.credit.license)}</a>` : ''}` : ''}</figcaption></figure>` : '';
  const wiki = art ? `<div class="group"><h3>${msg(art === info && TR ? 'fromWikiEn' : 'fromWiki')}</h3>${art.text ? `<p class="wiki">${esc(art.text)}</p>` : ''}<p class="wikilink"><a href="${esc(art.url)}" target="_blank" rel="noopener">${msg('readWiki', { title: esc(art.title) })}</a></p><p class="yrs">${msg('wikiLicence')}</p></div>` : '';
  const now = k >= 1
    ? `<dl class="facts"><dt>${msg('population')}</dt><dd>${fmtPeople(k)}<span class="src">${msg('city.estimate')}</span></dd>${r ? `<dt>${msg('city.ruler')}</dt><dd>${civChip(r)}</dd>` : ''}</dl>`
    : `<p class="status">${msg(y < c.from ? 'city.notYet' : 'city.gone')}</p>${goBtn(c.peak[0])}`;
  return `<section class="card civcard"><div class="eyebrow"><span>${msg('city.kind')}</span>${closeBtn()}</div><h2>${esc(c.name)}</h2>
    ${img}<div class="group"><h3>${msg('inYear', { year: fmtYear(y) })}</h3>${now}</div>${popChart(c, y)}<p class="note">${esc(c.note)}</p>${wiki}</section>`;
}
const cityItem = (d) => `<li><button type="button" data-city="${d.c.id}"><svg class="glyph" viewBox="0 0 14 10"><circle cx="7" cy="5" r="${Math.min(4.5, cityR(d.k) / 2)}" class="city"/></svg><span>${esc(d.c.name)}</span><span class="yrs">${fmtPeople(d.k)}</span></button></li>`;

function nowHTML() {
  const y = state.year;
  const civs = CIVS.filter((c) => isActive(c, y));
  const groups = SPHERES.map((s) => [s, civs.filter((c) => c.s === s.id).sort((a, b) => frameAt(b, y).area - frameAt(a, y).area)]).filter(([, l]) => l.length);
  const rts = ROUTES.filter((r) => routeActive(r, y));
  const evs = EVENTS.filter((e) => evVisible(e, y) && state.layers[evLayer(e)]).sort((a, b) => b.start - a.start);
  const bigCities = CITIES.map((c) => ({ c, k: cityPop(c, y) })).filter((d) => d.k >= 1).sort((a, b) => b.k - a.k).slice(0, 8);
  return `<section class="card"><div class="eyebrow"><span>${msg('now.title', { year: fmtYear(y) })}</span><span>${msg('now.powers', { n: civs.length })}</span></div>
    ${groups.map(([s, l]) => `<div class="group"><h3>${esc(s.name)}</h3><div class="chips">${l.map(civChip).join('')}</div></div>`).join('') || `<p class="empty">${msg('now.nothing')}</p>`}
    ${state.layers.cities ? `<div class="group"><h3>${msg('now.cities')}</h3>${bigCities.length ? `<ul class="list">${bigCities.map(cityItem).join('')}</ul>` : `<p class="empty">${msg('now.noCities')}</p>`}</div>` : ''}
    <div class="group"><h3>${msg('now.routes')}</h3>${rts.length ? `<ul class="list">${rts.map(routeItem).join('')}</ul>` : `<p class="empty">${msg('now.noRoutes')}</p>`}</div>
    <div class="group"><h3>${msg('now.events')}</h3>${evs.length ? `<ul class="list">${evs.map(eventItem).join('')}</ul>` : `<p class="empty">${msg('now.noEvents')}</p>`}</div></section>`;
}

let panelKey = '';
function renderPanel(force) {
  const y = Math.round(state.year);
  const key = [y, state.chapter, state.sel && state.sel.type + state.sel.id, Object.values(state.layers).join()].join('|');
  if (!force && key === panelKey) return;
  panelKey = key;
  const st = panel.node().scrollTop;
  panel.html(selectedHTML() + tourHTML() + nowHTML());
  panel.node().scrollTop = st;
}
panel.on('click', (ev) => {
  const b = ev.target.closest('button'); if (!b) return;
  const ds = b.dataset;
  if (ds.chapter !== undefined) playChapter(+ds.chapter);
  else if (ds.replay !== undefined) playChapter(+ds.replay);
  else if (ds.endtour !== undefined) { markNav(); state.chapter = -1; renderPanel(true); drawTimelineMarks(); scheduleURL(); }
  else if (ds.close !== undefined) select(null);
  else if (ds.civ) select({ type: 'civ', id: ds.civ });
  else if (ds.route) select({ type: 'route', id: ds.route });
  else if (ds.city) select({ type: 'city', id: ds.city });
  else if (ds.event) {
    const e = EVENTS.find((d) => d.id === ds.event);
    if (!evVisible(e, state.year)) setYear(e.kind === 'conflict' ? e.year + 1 : e.end);
    select({ type: 'event', id: ds.event });
  } else if (ds.stepCiv) goStep({ y: +ds.jump, c: CIVS.find((d) => d.id === ds.stepCiv) });
  else if (ds.jump) { stop(); markNav(); setYear(+ds.jump); }
});
panel.on('mouseover', (ev) => {
  const b = ev.target.closest('button[data-civ]');
  civG.selectAll('path.civ').classed('sel', (d) => !!b && d.c.id === b.dataset.civ);
});
panel.on('mouseout', () => drawCivs());

function select(s) {
  markNav();
  state.sel = s && state.sel && state.sel.type === s.type && state.sel.id === s.id ? null : s;
  drawMap(); renderPanel(true); drawTimelineMarks(); scheduleURL();
  if (state.sel) { panel.node().scrollTop = 0; if (matchMedia('(max-width: 860px)').matches) panel.node().scrollIntoView({ block: 'start' }); }
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
    .call((g) => g.select('text').attr('y', 10).attr('text-anchor', (d) => (d === MIN ? 'start' : d === MAX ? 'end' : 'middle')).text((d) => fmtTick(d)));
  tlLanes.selectAll('text.lane-lab').data(narrow ? [] : lanes).join('text').attr('class', 'lane-lab').attr('x', 0).attr('y', (l) => l.y + Math.min(l.h, 12) - 2)
    .text((l) => msg(`lane.${l.s.id}`))
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
    .on('mousemove', (ev, d) => { const r = tl.node().getBoundingClientRect(); showTipAt(ev.clientX, r.top, `<b>${esc(d.title)}</b><span class="yrs">${msg('tour.tip', { year: fmtYear(d.year) })}</span>`); }).on('mouseleave', hideTip))
    .attr('transform', (d) => `translate(${tx(d.year)},19)`).classed('on', (d, i) => i === state.chapter);
}
function drawCursor() {
  const x = tx(state.year); const lab = fmtYear(state.year); const w = textWidth(lab, 11, 0.64) + 10;
  const [lo, hi] = tx.range();
  const bx = Math.max(lo, Math.min(hi - w, x - w / 2));
  tlCur.select('line').attr('x1', x).attr('x2', x).attr('y1', 14).attr('y2', TLH);
  tlCur.select('rect').attr('x', bx).attr('y', 0).attr('width', w).attr('height', 15);
  tlCur.select('text').attr('x', bx + w / 2).attr('y', 11).text(lab);
}
let dragging = false, downX = 0;
tl.on('pointerdown', (ev) => { markNav(); dragging = true; downX = ev.clientX; tl.node().setPointerCapture(ev.pointerId); stop(); scrub(ev); });
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
  drawMap(); drawCursor(); drawTimelineMarks(); renderPanel(); scheduleURL();
}
let raf = null, last = 0;
const playBtn = d3.select('#play');
const PLAY = '<svg viewBox="0 0 16 16"><path d="M3 1.5v13l11-6.5z"/></svg>', PAUSE = '<svg viewBox="0 0 16 16"><path d="M3 1.5h3.5v13H3zM9.5 1.5H13v13H9.5z"/></svg>';
function play() {
  markNav();
  if (state.year >= MAX) setYear(MIN);
  state.playing = true; playBtn.html(PAUSE).attr('aria-label', msg('aria.pause')); last = performance.now();
  const step = (now) => {
    if (!state.playing) return;
    const dt = Math.min(0.1, (now - last) / 1000); last = now;
    setYear(state.year + dt * +d3.select('#speed').property('value'));
    if (state.year >= MAX) { stop(); return; }
    raf = requestAnimationFrame(step);
  };
  raf = requestAnimationFrame(step);
}
function stop() { state.playing = false; cancelAnimationFrame(raf); cancelAnimationFrame(tweenRaf); playBtn.html(PLAY).attr('aria-label', msg('aria.play')); scheduleURL(); }
playBtn.on('click', () => (state.playing ? stop() : play()));
let tweenRaf = null;
function playChapter(i) {
  if (i < 0 || i >= CHAPTERS.length) return;
  stop(); markNav();
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
  else if ((ev.key === '[' || ev.key === ']') && state.sel?.type === 'civ') {
    const s = civStep(CIVS.find((d) => d.id === state.sel.id), ev.key === '[' ? 'prev' : 'next');
    if (s) goStep(s);
    ev.preventDefault();
  } else if (ev.key === ' ' && !ev.target.closest('button')) { state.playing ? stop() : play(); ev.preventDefault(); }
});

// ---------- address ----------
// The URL hash holds what is on screen, so a link can be shared and the browser's back and forward buttons work:
// year (negative for BC), view (a named view) or at (lon,lat,zoom after panning), sel (type.id), tour (stop
// index) and hide (layers turned off). Navigation (selecting, jumping, tour stops, dragging the timeline,
// playing) adds a history entry; continuous changes such as playback and zooming update the current one.
const SEL_LISTS = { civ: CIVS, city: CITIES, route: ROUTES, event: EVENTS };
function encodeHash() {
  const p = new URLSearchParams();
  p.set('year', Math.round(state.year));
  if (state.view) p.set('view', state.view);
  else p.set('at', (pinnedAt ?? mapPosition()).map((v, i) => +v.toFixed(i < 2 ? 2 : 3)).join(','));
  if (state.sel) p.set('sel', `${state.sel.type}.${state.sel.id}`);
  if (state.chapter >= 0) p.set('tour', state.chapter + 1);
  const off = LAYERS.filter((l) => !state.layers[l.id]).map((l) => l.id);
  if (off.length) p.set('hide', off.join(','));
  return '#' + p.toString().replace(/%2C/g, ',');
}
let navPush = false, urlTimer = null, applying = false;
const markNav = () => { if (!applying) navPush = true; };
// Not while playing (stop() writes it), since browsers limit how often the history may be changed.
function scheduleURL() { if (!applying && !state.playing && !urlTimer) urlTimer = setTimeout(flushURL, 250); }
function flushURL() {
  clearTimeout(urlTimer); urlTimer = null;
  const hash = encodeHash(), push = navPush;
  navPush = false;
  if (hash === location.hash) return;
  try { history[push ? 'pushState' : 'replaceState'](null, '', hash); } catch { /* history blocked, e.g. in a sandboxed frame */ }
}
function applyHash(animate) {
  const p = new URLSearchParams(location.hash.slice(1));
  applying = true; stop();
  const hide = new Set((p.get('hide') || '').split(','));
  for (const l of LAYERS) state.layers[l.id] = !hide.has(l.id);
  d3.selectAll('#layers button').attr('aria-pressed', (d) => String(state.layers[d.id]));
  const ch = +p.get('tour') - 1;
  state.chapter = ch >= 0 && ch < CHAPTERS.length ? Math.floor(ch) : -1;
  const [type, id] = (p.get('sel') || '').split('.');
  state.sel = SEL_LISTS[type]?.some((d) => d.id === id) ? { type, id } : null;
  const at = (p.get('at') || '').split(',').map(Number);
  const chapter = CHAPTERS[state.chapter];
  if (at.length === 3 && at.every(Number.isFinite) && at[2] > 0) { pinnedAt = at; setView(null, animate, positionTransform(at)); }
  else { pinnedAt = null; const v = p.get('view'); setView(VIEWS[v] ? v : chapter ? chapter.view : 'silk', animate); }
  const y = p.get('year');
  setYear(y !== null && y !== '' && Number.isFinite(+y) ? Math.round(+y) : chapter ? chapter.year : 100);
  renderPanel(true); drawTimelineMarks();
  applying = false;
}
window.addEventListener('popstate', () => { clearTimeout(urlTimer); urlTimer = null; navPush = false; applyHash(true); });

const shareBtn = d3.select('#share');
shareBtn.on('click', async () => {
  flushURL();
  try { await navigator.clipboard.writeText(location.href); } catch { window.prompt(msg('share.prompt'), location.href); return; }
  shareBtn.text(msg('shared'));
  setTimeout(() => shareBtn.text(msg('share')), 1600);
});

// ---------- boot ----------
let resizeT;
new ResizeObserver(() => { clearTimeout(resizeT); resizeT = setTimeout(() => { layoutTimeline(); if (state.view) setView(state.view, false); }, 60); }).observe(document.body);
layoutTimeline();
applyHash(false);
})();

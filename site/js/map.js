import * as d3 from "../vendor/d3.js";
import * as topojson from "../vendor/topojson-client.js";
import { store, displayOf, groupOf, membersAt } from "./data.js";
import { t } from "./i18n.js";

/** Centroid of the largest polygon(s): keeps France's centroid in Europe, not between it and Guiana. */
function mainCentroid(geom) {
  if (!geom) return null;
  const polys = geom.type === "MultiPolygon"
    ? geom.coordinates.map((c) => ({ type: "Polygon", coordinates: c }))
    : [geom];
  const areas = polys.map((p) => d3.geoArea(p));
  const max = Math.max(...areas);
  const keep = polys.filter((_, i) => areas[i] >= max * 0.25);
  return d3.geoCentroid({ type: "MultiPolygon", coordinates: keep.map((p) => p.coordinates) });
}

export function createMap(container, { onHover, onMove, onClick }) {
  const topo = store.topo;
  const obj = topo.objects.countries;
  const features = topojson.feature(topo, obj).features;
  const geomsById = d3.group(obj.geometries.filter((g) => g.id), (g) => g.id);

  const countryCentroid = new Map();
  for (const [id, gs] of geomsById) countryCentroid.set(id, mainCentroid(topojson.merge(topo, gs)));
  const groupCentroid = new Map();
  for (const g of store.groups) {
    // all-time members, so arc endpoints stay put while membership changes
    const gs = g.members.flatMap((m) => geomsById.get(m.id) ?? []);
    if (gs.length) groupCentroid.set(g.id, mainCentroid(topojson.merge(topo, gs)));
  }

  const svg = d3.select(container).append("svg").attr("role", "img").attr("aria-label", t("map.aria"));
  const projection = d3.geoEqualEarth();
  const path = d3.geoPath(projection);
  const root = svg.append("g");
  const ocean = root.append("path").attr("class", "ocean").datum({ type: "Sphere" });
  const countries = root.append("g");
  const outlines = root.append("path").attr("class", "group-outline");
  const listOutline = root.append("path").attr("class", "list-outline");
  const hoverOutline = root.append("path").attr("class", "hover-outline");
  const arcLayer = root.append("g");
  const pinLayer = root.append("g").attr("class", "pins");

  let groupsOn = new Set();
  let highlight = null; // Set of entity ids outlined as a list (e.g. Belt and Road partners), or null
  let pi = 0;
  let hoverKey = null;
  let k = 1;
  let pinList = []; // [{at: [lon, lat], label}] placed by a story step

  const paths = countries.selectAll("path")
    .data(features)
    .join("path")
    .attr("class", "country nodata")
    .on("pointerenter", (ev, d) => {
      hoverKey = d.id ? displayOf(d.id, groupsOn, pi) : null;
      drawHover();
      onHover(hoverKey, ev, d);
    })
    .on("pointermove", (ev) => onMove(ev))
    .on("pointerleave", () => {
      hoverKey = null;
      drawHover();
      onHover(null);
    })
    .on("click", (ev, d) => {
      if (d.id) onClick(displayOf(d.id, groupsOn, pi));
    });

  const zoom = d3.zoom()
    .scaleExtent([1, 12])
    .on("zoom", (ev) => {
      k = ev.transform.k;
      root.attr("transform", ev.transform);
      arcLayer.selectAll(".node").attr("r", 3.5 / k);
      placePins();
    });
  svg.call(zoom).on("dblclick.zoom", null);

  function resize() {
    const { width, height } = container.getBoundingClientRect();
    if (!width || !height) return;
    svg.attr("viewBox", [0, 0, width, height]);
    projection.fitExtent([[8, 8], [width - 8, height - 8]], { type: "Sphere" });
    zoom.translateExtent([[0, 0], [width, height]]).extent([[0, 0], [width, height]]);
    ocean.attr("d", path);
    paths.attr("d", path);
    drawOutlines();
    lastGroupsKey = ""; // pi may be stale here (e.g. the map reappears after a frequency switch): redraw on next render
    drawList();
    drawHover();
    if (lastView) drawArcs(lastView.arcs);
    placePins();
  }

  function drawOutlines() {
    const active = (g) => g.id && groupsOn.has(groupOf(g.id, pi));
    const key = (g) => (g.id ? displayOf(g.id, groupsOn, pi) : g.properties.name);
    outlines.attr("d", path(topojson.mesh(topo, obj, (a, b) =>
      (active(a) || active(b)) && (a === b || key(a) !== key(b)))));
  }

  /** Outline around the highlighted list's members (borders with non-members and their coasts). */
  function drawList() {
    if (!highlight) return listOutline.attr("d", null);
    const inList = (g) => !!g.id && highlight.has(g.id);
    listOutline.attr("d", path(topojson.mesh(topo, obj, (a, b) => (a === b ? inList(a) : inList(a) !== inList(b)))));
  }

  function drawHover() {
    if (!hoverKey) return hoverOutline.attr("d", null);
    // a shape belongs to the key if it is that country, or is drawn as it (a merged group)
    const inKey = (g) => !!g.id && (g.id === hoverKey || displayOf(g.id, groupsOn, pi) === hoverKey);
    hoverOutline.attr("d", path(topojson.mesh(topo, obj, (a, b) => (a === b ? inKey(a) : inKey(a) !== inKey(b)))));
  }

  function centroidOf(key) {
    return groupCentroid.get(key) ?? countryCentroid.get(key) ?? null;
  }

  function arcPath(a, b) {
    const [x0, y0] = projection(a), [x1, y1] = projection(b);
    const dx = x1 - x0, dy = y1 - y0, dist = Math.hypot(dx, dy);
    const bend = Math.min(0.3, 40 / Math.max(dist, 1) + 0.15);
    const cx = (x0 + x1) / 2 - dy * bend, cy = (y0 + y1) / 2 + dx * bend;
    return `M${x0},${y0}Q${cx},${cy} ${x1},${y1}`;
  }

  function drawArcs(arcs) {
    const usable = arcs.filter((a) => centroidOf(a.from) && centroidOf(a.to));
    const max = d3.max(usable, (a) => a.value) || 1;
    const width = d3.scaleSqrt().domain([0, max]).range([0.8, 7]);
    arcLayer.selectAll(".arc")
      .data(usable, (a) => `${a.from}>${a.to}`)
      .join("path")
      .attr("class", (a) => `arc ${a.kind} ${a.animate ? "flowing" : ""}`)
      .attr("d", (a) => arcPath(centroidOf(a.from), centroidOf(a.to)))
      .attr("stroke-width", (a) => width(a.value));
    const nodes = [...new Set(usable.flatMap((a) => [a.from, a.to]))];
    arcLayer.selectAll(".node")
      .data(nodes, (d) => d)
      .join("circle")
      .attr("class", "node")
      .attr("r", 3.5 / k)
      .attr("transform", (d) => `translate(${projection(centroidOf(d))})`);
  }

  /** Labelled places (a port, a capital) that a story step points at; they keep their size when zooming. */
  function drawPins() {
    pinLayer.selectAll(".pin")
      .data(pinList, (d) => `${d.at}|${d.label}`)
      .join((enter) => {
        const g = enter.append("g").attr("class", "pin");
        g.append("circle").attr("class", "pin-pulse").attr("r", 5);
        g.append("circle").attr("class", "pin-dot").attr("r", 4);
        g.append("text").attr("y", 4);
        return g;
      })
      .classed("left", (d) => d.side === "left")
      .select("text").attr("x", (d) => (d.side === "left" ? -8 : 8)).text((d) => d.label);
    placePins();
  }

  function placePins() {
    pinLayer.selectAll(".pin").attr("transform", (d) => `translate(${projection(d.at)}) scale(${1 / k})`);
  }

  let lastView = null;
  let lastGroupsKey = "";

  function render(view) {
    lastView = view;
    groupsOn = view.groupsOn;
    pi = view.pi;
    // outlines depend on which groups are merged and on their membership that year
    const gk = [...groupsOn].sort().map((g) => `${g}:${membersAt(g, pi).join(".")}`).join("|");
    if (gk !== lastGroupsKey) {
      lastGroupsKey = gk;
      drawOutlines();
    }
    if (view.highlight !== highlight) {
      highlight = view.highlight;
      drawList();
    }
    paths.each(function (d) {
      const key = d.id ? displayOf(d.id, groupsOn, pi) : null;
      const isFocus = key && (key === view.focus || d.id === view.focus);
      const color = key && !isFocus ? view.colorOf(key) : null;
      const el = d3.select(this)
        .classed("focus", !!isFocus)
        .classed("nodata", !isFocus && !color);
      el.style("fill", color);
    });
    drawArcs(view.arcs);
  }

  function zoomBy(f) { svg.transition().duration(300).call(zoom.scaleBy, f); }
  function reset() { svg.transition().duration(400).call(zoom.transform, d3.zoomIdentity); }

  new ResizeObserver(() => resize()).observe(container);
  resize();

  /** Outline an entity or group from outside the map (e.g. hovering a country name in a story). */
  function outline(key) {
    hoverKey = key;
    drawHover();
  }

  function pins(list) {
    pinList = list ?? [];
    drawPins();
  }

  return { render, zoomBy, reset, outline, pins, hasShape: (key) => !!centroidOf(key) };
}

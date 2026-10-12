"""Publish the website's data files (site/data/) from the canonical store.

Steps, each a function over a DuckDB connection with an `obs` relation so they can be tested
on synthetic data:
    select_observations  pick one value per key using the dataset's source precedence
    derive_mirrors       rebuild flows for `derive=mirror` entities from partner reports
    build_pairs          wide (reporter, partner, period) -> exports, imports
    build_groups         group aggregates using membership as of each period's year
    covered_periods      drop trailing periods that too few reporters have published yet

Each frequency in config/datasets.json (A, M, ...) is published to site/data/<freq>/.
"""
import datetime as dt
import json
import math

from .net import log, read_manifest
from .paths import CONFIG, SITE_DATA
from .registry import WORLD, Registry, load_lists
from .sources import SOURCES
from .sources import natural_earth
from .store import REPORT_DIR, connect, create_obs_view, read_reference

FAR_PAST, FAR_FUTURE = -9999, 9999


# --------------------------------------------------------------------------- transformations

def select_observations(con, dataset: str, cfg: dict, freq: str, start: int, product: str = "TOTAL"):
    """TEMP TABLE chosen: one row per (reporter, partner, flow, period) of `freq` and `product`, highest-precedence source wins."""
    con.execute("CREATE OR REPLACE TEMP TABLE prec (source VARCHAR, rank INTEGER)")
    con.executemany("INSERT INTO prec VALUES (?, ?)", [(s, i) for i, s in enumerate(cfg["precedence"])])
    con.execute("""
        CREATE OR REPLACE TEMP TABLE chosen AS
        SELECT * EXCLUDE (rk, rank) FROM (
            SELECT o.*, p.rank, row_number() OVER (
                PARTITION BY reporter, partner, flow, product, freq, period ORDER BY p.rank) AS rk
            FROM obs o JOIN prec p USING (source)
            WHERE o.dataset = ? AND o.product = ? AND o.freq = ?
              AND CAST(left(o.period, 4) AS INTEGER) >= ?
        ) WHERE rk = 1
    """, [dataset, product, freq, start])


def derive_mirrors(con, registry: Registry) -> list[str]:
    """For entities flagged derive=mirror that report nothing, use partners' reports with flows swapped."""
    reporters = {r[0] for r in con.execute("SELECT DISTINCT reporter FROM chosen").fetchall()}
    done = []
    for e in registry.entities.values():
        if e.derive != "mirror" or e.id in reporters:
            continue
        con.execute("""
            INSERT INTO chosen
            SELECT 'mirror' AS source, dataset, partner AS reporter, reporter AS partner,
                   CASE flow WHEN 'X' THEN 'M' ELSE 'X' END AS flow,
                   product, freq, period, value, unit, valuation, 'mirror' AS flag
            FROM chosen WHERE partner = ? AND reporter <> ?
        """, [e.id, WORLD])
        con.execute("""
            INSERT INTO chosen
            SELECT 'mirror', dataset, reporter, ? AS partner, flow, product, freq, period,
                   sum(value), unit, '' AS valuation, 'mirror'
            FROM chosen WHERE reporter = ? AND flag = 'mirror'
            GROUP BY dataset, reporter, flow, product, freq, period, unit
        """, [WORLD, e.id])
        done.append(e.id)
    return done


def build_pairs(con):
    """TEMP TABLE pairs(reporter, partner, period, year, x, m). NULL = not reported (distinct from 0)."""
    con.execute("""
        CREATE OR REPLACE TEMP TABLE pairs AS
        SELECT reporter, partner, period, CAST(left(period, 4) AS INTEGER) AS year,
               sum(value) FILTER (WHERE flow = 'X') AS x,
               sum(value) FILTER (WHERE flow = 'M') AS m
        FROM chosen WHERE reporter <> partner
        GROUP BY reporter, partner, period
    """)


def build_groups(con, registry: Registry):
    """TEMP TABLEs group_pairs (flows to non-members), group_intra, group_world (extra-group trade).

    Membership is evaluated by the period's year, for both the reporting member and the partner."""
    con.execute("CREATE OR REPLACE TEMP TABLE mem (group_id VARCHAR, entity VARCHAR, y0 INTEGER, y1 INTEGER)")
    mem = [(m.group, m.entity, FAR_PAST if m.start is None else m.start, FAR_FUTURE if m.end is None else m.end)
           for m in registry.memberships()]
    if mem:
        con.executemany("INSERT INTO mem VALUES (?, ?, ?, ?)", mem)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE gm AS
        SELECT mr.group_id, p.partner, p.period, p.x, p.m, mp.entity IS NOT NULL AS intra
        FROM pairs p
        JOIN mem mr ON p.reporter = mr.entity AND p.year BETWEEN mr.y0 AND mr.y1
        LEFT JOIN mem mp ON mp.group_id = mr.group_id AND mp.entity = p.partner
                         AND p.year BETWEEN mp.y0 AND mp.y1
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE group_pairs AS
        SELECT group_id, partner, period, sum(x) AS x, sum(m) AS m
        FROM gm WHERE NOT intra AND partner <> '{WORLD}' GROUP BY ALL
    """)
    con.execute("""
        CREATE OR REPLACE TEMP TABLE group_intra AS
        SELECT group_id, period, sum(x) AS x, sum(m) AS m FROM gm WHERE intra GROUP BY ALL
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE group_world AS
        SELECT w.group_id, w.period, w.x - coalesce(i.x, 0) AS x, w.m - coalesce(i.m, 0) AS m
        FROM (SELECT group_id, period, sum(x) AS x, sum(m) AS m FROM gm
              WHERE partner = '{WORLD}' GROUP BY ALL) w
        LEFT JOIN group_intra i USING (group_id, period)
    """)


def covered_periods(con, min_coverage: float) -> list[str]:
    """All periods up to the last one in which at least `min_coverage` x (the best period's count)
    reporters published their world total. Recent periods that only some countries have reported
    would otherwise look like a collapse in trade."""
    counts = con.execute(f"""
        SELECT period, count(DISTINCT reporter) FROM pairs
        WHERE partner = '{WORLD}' AND (x IS NOT NULL OR m IS NOT NULL) GROUP BY period ORDER BY period
    """).fetchall()
    if not counts:
        return []
    best = max(n for _, n in counts)
    last = max(i for i, (_, n) in enumerate(counts) if n >= best * min_coverage)
    return [p for p, _ in counts[:last + 1]]


# --------------------------------------------------------------------------- output helpers

def sig(v, digits=4):
    """USD -> USD millions, rounded to `digits` significant figures."""
    if v is None:
        return None
    m = v / 1e6
    if m == 0:
        return 0
    r = round(m, -int(math.floor(math.log10(abs(m)))) + (digits - 1))
    return int(r) if r == int(r) else r


def collect(rows, periods):
    """[(key, period, x, m)] -> {key: [[x...], [m...]]} aligned to `periods` (USD millions)."""
    idx = {p: i for i, p in enumerate(periods)}
    out = {}
    for key, period, x, m in rows:
        if period not in idx:
            continue
        s = out.setdefault(key, [[None] * len(periods), [None] * len(periods)])
        s[0][idx[period]], s[1][idx[period]] = sig(x), sig(m)
    return dict(sorted(out.items()))  # stable order keeps data diffs readable


def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))


def world_topology(registry: Registry) -> tuple[dict, list[str]]:
    """Natural Earth TopoJSON with geometry ids rewritten to entity ids."""
    atlas = json.loads(natural_earth.TOPOJSON.read_text())
    by_m49 = {e.m49: e.id for e in registry.entities.values() if e.m49}
    by_ne = {e.codes["ne"]: e.id for e in registry.entities.values() if "ne" in e.codes}
    geoms, unmatched = [], []
    for g in atlas["objects"]["countries"]["geometries"]:
        name = g["properties"]["name"]
        if g.get("id") == "010":  # Antarctica
            continue
        eid = by_ne.get(g.get("id")) or by_ne.get(name) or by_m49.get(g.get("id"))
        g = {k: v for k, v in g.items() if k != "id"}
        g["properties"] = {"name": name}
        if eid:
            g["id"] = eid
        else:
            unmatched.append(name)
        geoms.append(g)
    atlas = dict(atlas)
    atlas["objects"] = {"countries": {"type": "GeometryCollection", "geometries": geoms}}
    return atlas, unmatched


def source_meta(source_id):
    mod = SOURCES[source_id]
    accessed = read_manifest(mod.FOLDER).get("accessed")
    meta = {"id": source_id, **mod.META, "accessed": accessed}
    if "citation" in meta:
        meta["citation"] = meta["citation"].format(accessed=accessed)
    return meta


# --------------------------------------------------------------------------- main

def publish_freq(con, registry, dataset, cfg, freq, start, out_dir, product="TOTAL", periods=None):
    """Write <out_dir>/totals.json and <out_dir>/flows/<id>.json for one frequency and product.
    `periods` fixes the time axis (products share one); otherwise it comes from covered_periods."""
    select_observations(con, dataset, cfg, freq, start, product)
    mirrored = derive_mirrors(con, registry)
    build_pairs(con)
    build_groups(con, registry)
    if periods is None:
        periods = covered_periods(con, cfg.get("min_coverage", 0))
    has_data = con.execute("SELECT count(*) FROM pairs").fetchone()[0] > 0
    if not periods or not has_data:
        log(f"  {product if product != 'TOTAL' else dataset} {freq}: no data; skipped")
        return None

    reporters = [r[0] for r in con.execute("SELECT DISTINCT reporter FROM pairs ORDER BY 1").fetchall()]
    partners = {r[0] for r in con.execute(f"SELECT DISTINCT partner FROM pairs WHERE partner <> '{WORLD}'").fetchall()}

    flows_dir = out_dir / "flows"
    for old in flows_dir.glob("*.json"):
        old.unlink()
    by_reporter = {}
    for r, p, per, x, m in con.execute(f"SELECT reporter, partner, period, x, m FROM pairs WHERE partner <> '{WORLD}'").fetchall():
        by_reporter.setdefault(r, []).append((p, per, x, m))
    for r in reporters:
        dump(flows_dir / f"{r}.json", {"p": collect(by_reporter.get(r, []), periods)})

    totals = collect(con.execute(f"SELECT reporter, period, x, m FROM pairs WHERE partner = '{WORLD}'").fetchall(), periods)
    by_group = {}
    for gid, p, per, x, m in con.execute("SELECT group_id, partner, period, x, m FROM group_pairs").fetchall():
        by_group.setdefault(gid, []).append((p, per, x, m))
    intra = collect(con.execute("SELECT group_id, period, x, m FROM group_intra").fetchall(), periods)
    totals.update(collect(con.execute("SELECT group_id, period, x, m FROM group_world").fetchall(), periods))
    empty = [[None] * len(periods), [None] * len(periods)]
    for g in registry.groups:
        dump(flows_dir / f"{g.id}.json", {"p": collect(by_group.get(g.id, []), periods), "intra": intra.get(g.id, empty)})
    dump(out_dir / "totals.json", totals)

    size = sum(f.stat().st_size for f in flows_dir.glob("*.json"))
    log(f"  {product if product != 'TOTAL' else dataset} {freq}: {periods[0]}–{periods[-1]} ({len(periods)} periods), {len(reporters)} reporters, "
        f"flows {size / 1e6:.1f} MB; mirrored {mirrored}")
    return {"periods": periods, "reporters": reporters, "partners": partners, "mirrored": mirrored,
            "has_totals": set(totals), "totals": totals, "rows_by_source": dict(con.execute(
                "SELECT source, count(*) FROM chosen GROUP BY 1 ORDER BY 1").fetchall())}


def publish_products(con, registry, cfg):
    """goods_by_product: one folder per sector/commodity, plus a per-entity breakdown by product."""
    from .sources.cepii_baci import load_taxonomy

    taxonomy = load_taxonomy()
    out = SITE_DATA / "products"
    import shutil
    shutil.rmtree(out, ignore_errors=True)  # products removed from the taxonomy must not linger
    if not con.execute("SELECT count(*) FROM obs WHERE dataset = 'goods_by_product'").fetchone()[0]:
        log("  no goods_by_product observations (run fetch + normalize for its sources); skipped")
        return {}, None
    results, breakdown = {}, {}
    # One time axis for all products, so the frontend can switch products without realigning.
    axis = {freq: [r[0] for r in con.execute("""
        SELECT DISTINCT period FROM obs WHERE dataset = 'goods_by_product' AND freq = ?
          AND CAST(left(period, 4) AS INTEGER) >= ? ORDER BY 1""", [freq, fc["start"]]).fetchall()]
        for freq, fc in cfg["freqs"].items()}
    for item in taxonomy["sectors"] + taxonomy["commodities"]:
        pid = item["id"]
        for freq, fc in cfg["freqs"].items():
            r = publish_freq(con, registry, "goods_by_product", cfg, freq, fc["start"], out / pid / freq,
                             product=pid, periods=axis[freq])
            if r is None:
                continue
            results[(pid, freq)] = r
            if freq == "A":
                for eid, series in r["totals"].items():
                    breakdown.setdefault(eid, {})[pid] = series
    if not results:
        return {}, None
    periods = axis["A"]
    # breakdown/<id>.json: {product: series} of trade with the world, for the panel's "what it trades" list
    bd_dir = out / "breakdown"
    for old in bd_dir.glob("*.json"):
        old.unlink()
    for eid, by_product in breakdown.items():
        dump(bd_dir / f"{eid}.json", by_product)
    published = {pid for pid, _ in results}
    meta = {
        "periods": {"A": periods},
        "sectors": [it for it in taxonomy["sectors"] if it["id"] in published],
        "commodities": [it for it in taxonomy["commodities"] if it["id"] in published],
    }
    return results, meta


def publish():
    """Publish every dataset in config/datasets.json."""
    datasets = json.loads((CONFIG / "datasets.json").read_text())
    datasets = {k: v for k, v in datasets.items() if not k.startswith("_")}
    con = connect()
    registry = Registry.load(read_reference(con, "un_m49"))
    create_obs_view(con)

    results, products_meta = {}, None
    if "goods_trade" in datasets:
        log("Publishing goods_trade")
        cfg = datasets["goods_trade"]
        for freq, fc in cfg["freqs"].items():
            r = publish_freq(con, registry, "goods_trade", cfg, freq, fc["start"], SITE_DATA / freq)
            if r is not None:  # a frequency with no data yet is left out of meta.periods
                results[("goods_trade", freq)] = r
    if "goods_by_product" in datasets:
        log("Publishing goods_by_product")
        prod_results, products_meta = publish_products(con, registry, datasets["goods_by_product"])
        results.update({("goods_by_product",) + k: v for k, v in prod_results.items()})

    from .indicators import publish_indicators
    log("Publishing indicators")
    indicators = publish_indicators(con, registry)
    used_extra = ["worldbank_wdi"] if indicators else []

    from .bilateral import publish_bilateral
    log("Publishing bilateral measures")
    bilateral = publish_bilateral(con, registry)
    if bilateral:
        used_extra += [m["source"] for m in bilateral["measures"] if m["source"] not in used_extra]

    topo, unmatched_shapes = world_topology(registry)
    dump(SITE_DATA / "world.json", topo)

    trade = {f: r for (d, *rest), r in results.items() if d == "goods_trade" for f in rest}
    if not trade:
        raise RuntimeError("no goods_trade data to publish: run fetch + normalize first")
    reporters = set().union(*(r["reporters"] for r in results.values()))
    partners = set().union(*(r["partners"] for r in results.values()))
    mirrored = set().union(*(r["mirrored"] for r in results.values()))
    has_totals = set().union(*(r["has_totals"] for r in trade.values()))
    member_ids = {m.entity for m in registry.memberships()}
    listed = (reporters | partners | member_ids) & set(registry.entities)
    memberships = {}
    for m in registry.memberships():
        memberships.setdefault(m.entity, []).append(_span({"g": m.group}, m))
    ents = {}
    for eid in sorted(listed):
        e = registry.entities[eid]
        # territories outside UN M49 (Taiwan) take the region of the country they are part of
        geo = e if e.region_name or not e.part_of else registry.entities[e.part_of]
        ents[eid] = {"name": e.name, "region": geo.region_name or None, "subregion": geo.subregion_name or None,
                     "reporter": eid in has_totals}
        if eid in mirrored:
            ents[eid]["mirror"] = True
        if e.part_of:
            ents[eid]["part_of"] = e.part_of
        if eid in memberships:
            ents[eid]["groups"] = memberships[eid]
    used_sources = []
    for cfg in datasets.values():
        used_sources += [s for s in cfg["precedence"] if s not in used_sources]
    used_sources += [s for s in used_extra if s not in used_sources]
    meta = {
        "periods": {freq: r["periods"] for freq, r in trade.items()},
        "products": products_meta,
        "units": "USD millions (current prices)",
        "generated": dt.date.today().isoformat(),
        "entities": ents,
        "groups": [{"id": g.id, "name": g.name, "short": g.short, "note": g.note,
                    "members": [_span({"id": m.entity}, m) for m in g.members if m.entity in listed]}
                   for g in registry.groups],
        "lists": [{k: v for k, v in lst.items() if not k.startswith("_")} for lst in load_lists(registry.entities)],
        "sources": [source_meta(s) for s in used_sources] + [source_meta("un_m49"), source_meta("natural_earth")],
    }
    dump(SITE_DATA / "meta.json", meta)

    shaped = {g.get("id") for g in topo["objects"]["countries"]["geometries"]}
    report = {
        "slices": {"/".join(k): {"periods": [r["periods"][0], r["periods"][-1]], "reporters": len(r["reporters"]),
                                 "rows_by_source": r["rows_by_source"]} for k, r in results.items()},
        "entities": len(ents), "mirrored": sorted(mirrored),
        "reporters_without_shape": sorted(r for r in reporters if r not in shaped),
        "shapes_without_entity": sorted(unmatched_shapes),
    }
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (REPORT_DIR / "publish.json").write_text(json.dumps(report, indent=2))
    log(f"  {len(ents)} entities, {len(registry.groups)} groups")
    log(f"  reporters without a map shape: {report['reporters_without_shape']}")
    log(f"  map shapes without an entity: {report['shapes_without_entity']}")
    return report


def _span(base, m):
    if m.start is not None:
        base["from"] = m.start
    if m.end is not None:
        base["to"] = m.end
    return base

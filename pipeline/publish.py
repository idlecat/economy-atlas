"""Publish the website's data files (site/data/) from the canonical store.

Steps, each a function over a DuckDB connection with an `obs` relation so they can be tested
on synthetic data:
    select_observations  pick one value per key using the dataset's source precedence
    derive_mirrors       rebuild flows for `derive=mirror` entities from partner reports
    build_pairs          wide (reporter, partner, year) -> exports, imports
    build_groups         group aggregates using membership as of each year
"""
import datetime as dt
import json
import math

from .net import log, read_manifest
from .paths import CONFIG, SITE_DATA
from .registry import WORLD, Registry
from .sources import SOURCES
from .sources import natural_earth
from .store import REPORT_DIR, connect, create_obs_view, read_reference

FAR_PAST, FAR_FUTURE = -9999, 9999


# --------------------------------------------------------------------------- transformations

def select_observations(con, dataset: str, cfg: dict):
    """TEMP TABLE chosen: one row per (reporter, partner, flow, product, freq, period), highest-precedence source wins."""
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
    """, [dataset, cfg["product"], cfg["freq"], cfg["start"]])


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
    """TEMP TABLE pairs(reporter, partner, year, x, m). NULL = not reported (distinct from 0)."""
    con.execute("""
        CREATE OR REPLACE TEMP TABLE pairs AS
        SELECT reporter, partner, CAST(period AS INTEGER) AS year,
               sum(value) FILTER (WHERE flow = 'X') AS x,
               sum(value) FILTER (WHERE flow = 'M') AS m
        FROM chosen WHERE reporter <> partner
        GROUP BY reporter, partner, year
    """)


def build_groups(con, registry: Registry):
    """TEMP TABLEs group_pairs (flows to non-members), group_intra, group_world (extra-group trade).

    Membership is evaluated per year, for both the reporting member and the partner."""
    con.execute("CREATE OR REPLACE TEMP TABLE mem (group_id VARCHAR, entity VARCHAR, y0 INTEGER, y1 INTEGER)")
    mem = [(m.group, m.entity, FAR_PAST if m.start is None else m.start, FAR_FUTURE if m.end is None else m.end)
           for m in registry.memberships()]
    if mem:
        con.executemany("INSERT INTO mem VALUES (?, ?, ?, ?)", mem)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE gm AS
        SELECT mr.group_id, p.partner, p.year, p.x, p.m, mp.entity IS NOT NULL AS intra
        FROM pairs p
        JOIN mem mr ON p.reporter = mr.entity AND p.year BETWEEN mr.y0 AND mr.y1
        LEFT JOIN mem mp ON mp.group_id = mr.group_id AND mp.entity = p.partner
                         AND p.year BETWEEN mp.y0 AND mp.y1
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE group_pairs AS
        SELECT group_id, partner, year, sum(x) AS x, sum(m) AS m
        FROM gm WHERE NOT intra AND partner <> '{WORLD}' GROUP BY ALL
    """)
    con.execute("""
        CREATE OR REPLACE TEMP TABLE group_intra AS
        SELECT group_id, year, sum(x) AS x, sum(m) AS m FROM gm WHERE intra GROUP BY ALL
    """)
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE group_world AS
        SELECT w.group_id, w.year, w.x - coalesce(i.x, 0) AS x, w.m - coalesce(i.m, 0) AS m
        FROM (SELECT group_id, year, sum(x) AS x, sum(m) AS m FROM gm
              WHERE partner = '{WORLD}' GROUP BY ALL) w
        LEFT JOIN group_intra i USING (group_id, year)
    """)


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


def collect(rows, years):
    """[(key, year, x, m)] -> {key: [[x...], [m...]]} aligned to `years` (USD millions)."""
    idx = {y: i for i, y in enumerate(years)}
    out = {}
    for key, year, x, m in rows:
        if year not in idx:
            continue
        s = out.setdefault(key, [[None] * len(years), [None] * len(years)])
        s[0][idx[year]], s[1][idx[year]] = sig(x), sig(m)
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

def publish(dataset="goods_trade"):
    cfg = json.loads((CONFIG / "datasets.json").read_text())[dataset]
    con = connect()
    registry = Registry.load(read_reference(con, "un_m49"))
    create_obs_view(con)

    select_observations(con, dataset, cfg)
    mirrored = derive_mirrors(con, registry)
    build_pairs(con)
    build_groups(con, registry)

    years = [r[0] for r in con.execute("SELECT DISTINCT year FROM pairs ORDER BY 1").fetchall()]
    reporters = [r[0] for r in con.execute("SELECT DISTINCT reporter FROM pairs ORDER BY 1").fetchall()]
    partners = {r[0] for r in con.execute(f"SELECT DISTINCT partner FROM pairs WHERE partner <> '{WORLD}'").fetchall()}

    # flows/<id>.json for every reporter and group
    flows_dir = SITE_DATA / "flows"
    for old in flows_dir.glob("*.json"):
        old.unlink()
    rows = con.execute(f"""
        SELECT reporter, partner, year, x, m FROM pairs WHERE partner <> '{WORLD}' ORDER BY reporter
    """).fetchall()
    by_reporter = {}
    for r, p, y, x, m in rows:
        by_reporter.setdefault(r, []).append((p, y, x, m))
    for r in reporters:
        dump(flows_dir / f"{r}.json", {"p": collect(by_reporter.get(r, []), years)})

    totals = collect(con.execute(f"SELECT reporter, year, x, m FROM pairs WHERE partner = '{WORLD}'").fetchall(), years)
    group_rows = con.execute("SELECT group_id, partner, year, x, m FROM group_pairs").fetchall()
    intra = collect(con.execute("SELECT group_id, year, x, m FROM group_intra").fetchall(), years)
    totals.update(collect(con.execute("SELECT group_id, year, x, m FROM group_world").fetchall(), years))
    for g in registry.groups:
        dump(flows_dir / f"{g.id}.json", {
            "p": collect([(p, y, x, m) for gid, p, y, x, m in group_rows if gid == g.id], years),
            "intra": intra.get(g.id, [[None] * len(years), [None] * len(years)]),
        })
    dump(SITE_DATA / "totals.json", totals)

    topo, unmatched_shapes = world_topology(registry)
    dump(SITE_DATA / "world.json", topo)

    # meta.json
    member_ids = {m.entity for m in registry.memberships()}
    listed = (set(reporters) | partners | member_ids) & set(registry.entities)
    memberships = {}
    for m in registry.memberships():
        memberships.setdefault(m.entity, []).append(_span({"g": m.group}, m))
    ents = {}
    for eid in sorted(listed):
        e = registry.entities[eid]
        ents[eid] = {"name": e.name, "region": e.region_name or None, "subregion": e.subregion_name or None,
                     "reporter": eid in totals}
        if eid in mirrored:
            ents[eid]["mirror"] = True
        if eid in memberships:
            ents[eid]["groups"] = memberships[eid]
    meta = {
        "dataset": dataset,
        "years": years,
        "units": "USD millions (current prices)",
        "generated": dt.date.today().isoformat(),
        "entities": ents,
        "groups": [{"id": g.id, "name": g.name, "short": g.short, "note": g.note,
                    "members": [_span({"id": m.entity}, m) for m in g.members if m.entity in listed]}
                   for g in registry.groups],
        "sources": [source_meta(s) for s in cfg["precedence"]] + [source_meta("un_m49"), source_meta("natural_earth")],
    }
    dump(SITE_DATA / "meta.json", meta)

    shaped = {g.get("id") for g in topo["objects"]["countries"]["geometries"]}
    report = {
        "dataset": dataset, "years": [years[0], years[-1]], "reporters": len(reporters),
        "entities": len(ents), "mirrored": mirrored,
        "rows_by_source": dict(con.execute("SELECT source, count(*) FROM chosen GROUP BY 1 ORDER BY 1").fetchall()),
        "reporters_without_shape": sorted(r for r in reporters if r not in shaped),
        "shapes_without_entity": sorted(unmatched_shapes),
    }
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    (REPORT_DIR / "publish.json").write_text(json.dumps(report, indent=2))
    log(f"Published {dataset}: {years[0]}–{years[-1]}, {len(reporters)} reporters, {len(ents)} entities, "
        f"{len(registry.groups)} groups; mirrored {mirrored}")
    log(f"  reporters without a map shape: {report['reporters_without_shape']}")
    log(f"  map shapes without an entity: {report['shapes_without_entity']}")
    return report


def _span(base, m):
    if m.start is not None:
        base["from"] = m.start
    if m.end is not None:
        base["to"] = m.end
    return base

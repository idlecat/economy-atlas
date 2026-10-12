"""Publish country-to-counterpart measures (config/bilateral.json) to site/data/bilateral.json.

- Source rows come from the `bil` view (data_store/bilateral/*.parquet).
- When a measure has `precedence` (several reporters of the same value, e.g. FDI reported by the host
  and by the investor), each (country, counterpart) series uses the first basis with any data, so a
  series never switches source from one year to the next. Series from a later basis are listed in
  `basis` so the site can say who reported them.
- Groups (membership as of each year) sum their members when the members that report the measure
  hold at least COVERAGE of the group's population. COVERAGE is lower than for indicators (95%) because
  the debt data covers only low- and middle-income countries by design, so e.g. ASEAN (without
  Singapore, Brunei and Malaysia) still gets a total of its reporting members. A group gets no value
  for a counterpart that is one of its own members that year (China's debt owed to China). For measures
  with `precedence`, group sums use only series of the first basis (host reports), since adding host and
  investor reports together mixes incompatible totals (e.g. offshore centres that report nothing
  themselves but receive large amounts in investors' reports). A member reports if it has a value for that year
  for any counterpart (including the WLD total); a reporting member with no value for a counterpart
  counts as 0 (e.g. a country that owes nothing to Japan). Values are published in USD millions.
"""
import json

from .indicators import members_by_year, sig
from .net import log
from .paths import CONFIG, SITE_DATA
from .registry import Registry

SCALE = {"usd": 1e-6}
COVERAGE = 0.85


def choose_basis(by_basis: dict, precedence: list) -> tuple[str, dict]:
    """by_basis: {basis: {year: value}} for one series -> (basis, {year: value}) of the first basis with data."""
    for b in precedence or [""]:
        if by_basis.get(b):
            return b, by_basis[b]
    b = next(iter(by_basis))
    return b, by_basis[b]


def group_value(series, reporting, members, pop, year):
    """Sum of members' values in `year`, or None if reporting members hold < COVERAGE of the population."""
    total_pop = sum(pop.get(m, {}).get(year) or 0 for m in members)
    have = [m for m in members if year in reporting.get(m, ())]
    have_pop = sum(pop.get(m, {}).get(year) or 0 for m in have)
    if not have or not total_pop or have_pop / total_pop < COVERAGE:
        return None
    return sum(series.get(m, {}).get(year) or 0 for m in have)


def compute(rows, cfg, registry: Registry, pop: dict):
    """rows: (measure, entity, counterpart, year, value, basis) -> ({m: {cp: {entity: {year: v}}}}, basis map, years)."""
    raw = {}
    for m, e, cp, y, v, b in rows:
        raw.setdefault(m, {}).setdefault(cp, {}).setdefault(e, {}).setdefault(b, {})[int(y)] = v
    specs = {m["id"]: m for m in cfg["measures"]}
    values, basis = {}, {}
    for m, by_cp in raw.items():
        prec = specs[m].get("precedence")
        for cp, by_e in by_cp.items():
            for e, by_basis in by_e.items():
                b, s = choose_basis(by_basis, prec)
                values.setdefault(m, {}).setdefault(cp, {})[e] = s
                if prec and b != prec[0]:
                    basis.setdefault(m, {}).setdefault(cp, {})[e] = b
    all_years = [y for by_cp in values.values() for by_e in by_cp.values() for s in by_e.values() for y in s]
    years = list(range(cfg["start"], max(all_years) + 1)) if all_years else []
    mem = members_by_year(registry, years)
    for m, by_cp in values.items():
        other = basis.get(m, {})
        first = lambda cp, by_e: {e: s for e, s in by_e.items() if e not in other.get(cp, {})}
        reporting = {}  # entity -> years with any (first-basis) value for this measure
        for cp, by_e in by_cp.items():
            for e, s in first(cp, by_e).items():
                reporting.setdefault(e, set()).update(s)
        for cp, by_e in by_cp.items():
            for gid, by_year in mem.items():
                g = {y: v for y in years
                     if cp not in by_year[y] and (v := group_value(first(cp, by_e), reporting, by_year[y], pop, y)) is not None}
                if g:
                    by_e[gid] = g
    return values, basis, years


def publish_bilateral(con, registry: Registry):
    from .store import create_bilateral_view, create_indicator_view

    if not create_bilateral_view(con):
        log("  no bilateral data (run fetch + normalize for worldbank_ids / imf_dip); skipped")
        return None
    cfg = json.loads((CONFIG / "bilateral.json").read_text())
    rows = con.execute("SELECT measure, entity, counterpart, period, value, basis FROM bil WHERE freq = 'A'").fetchall()
    pop = {}
    if create_indicator_view(con):
        for e, y, v in con.execute("SELECT entity, period, value FROM ind WHERE indicator = 'pop' AND freq = 'A'").fetchall():
            pop.setdefault(e, {})[int(y)] = v
    values, basis, years = compute(rows, cfg, registry, pop)
    published = {}
    for spec in cfg["measures"]:
        scale = SCALE.get(spec["unit"], 1)
        published[spec["id"]] = {
            cp: {e: [sig(s[y] * scale) if s.get(y) is not None else None for y in years]
                 for e, s in sorted(values.get(spec["id"], {}).get(cp, {}).items()) if s}
            for cp in spec["counterparts"]
        }
    doc = {
        "periods": [str(y) for y in years],
        "coverage_rule": f"Group sums require members with data to hold at least {COVERAGE:.0%} of the group's population.",
        "measures": [{k: spec[k] for k in ("id", "name", "unit", "description", "source")} | {"counterparts": list(spec["counterparts"])}
                     for spec in cfg["measures"]],
        "basis": basis,
        "values": published,
    }
    path = SITE_DATA / "bilateral.json"
    path.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False, sort_keys=True))
    log(f"  bilateral: {len(cfg['measures'])} measures for {years[0]}–{years[-1]}, {path.stat().st_size / 1e6:.1f} MB")
    return doc

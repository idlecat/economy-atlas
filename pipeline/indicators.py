"""Publish country-level indicators (config/indicators.json) to site/data/indicators.json.

- Source indicators come from the `ind` view (data_store/indicators/*.parquet).
- Derived indicators: gdp_pc = gdp / pop; gdp_growth = annual change of gdp_real.
- Groups (membership as of each year): `sum` indicators add up members' values, but only when the
  members with data hold at least COVERAGE of the group's population, so a missing large member
  can't silently shrink the total. Group growth compares the same members in both years, so a
  country joining doesn't show up as growth.
"""
import json

from .net import log
from .paths import CONFIG, SITE_DATA
from .registry import Registry

COVERAGE = 0.95
SCALE = {"usd": 1e-6}  # published in USD millions, like trade values


def sig(v, digits=4):
    if v is None:
        return None
    if v == 0:
        return 0
    from math import floor, log10
    r = round(v, -int(floor(log10(abs(v)))) + (digits - 1))
    return int(r) if r == int(r) else r


def members_by_year(registry: Registry, years):
    return {g.id: {y: [m.entity for m in g.members if m.covers(y)] for y in years} for g in registry.groups}


def group_sum(values, members, pop, year):
    """Sum members' values for one year, or None if members with data hold < COVERAGE of the population."""
    have = [m for m in members if values.get(m, {}).get(year) is not None]
    total_pop = sum(pop.get(m, {}).get(year) or 0 for m in members)
    have_pop = sum(pop.get(m, {}).get(year) or 0 for m in have)
    if not have or not total_pop or have_pop / total_pop < COVERAGE:
        return None
    return sum(values[m][year] for m in have)


def growth(real, members, year, pop):
    """Real growth from year-1 to year over a constant set of members (those in the group in `year`)."""
    now = group_sum(real, members, pop, year)
    before = group_sum(real, members, pop, year - 1)
    return None if now is None or not before else (now / before - 1) * 100


def compute(raw, registry: Registry, years, cfg):
    """raw: {indicator: {entity: {year: value}}} -> same shape, with derived and group values added."""
    out = {k: {e: dict(v) for e, v in ents.items()} for k, ents in raw.items()}
    gdp, pop, real = out.get("gdp", {}), out.get("pop", {}), out.get("gdp_real", {})
    out["gdp_pc"] = {e: {y: v / pop[e][y] for y, v in s.items() if pop.get(e, {}).get(y)} for e, s in gdp.items()}
    out["gdp_growth"] = {e: {y: (v / s[y - 1] - 1) * 100 for y, v in s.items() if s.get(y - 1)} for e, s in real.items()}

    mem = members_by_year(registry, years)
    specs = {i["id"]: i for i in cfg["indicators"]}
    for gid, by_year in mem.items():
        for ind, spec in specs.items():
            if spec.get("group") == "sum" and ind in out:
                out[ind][gid] = {y: v for y in years if (v := group_sum(out[ind], by_year[y], pop, y)) is not None}
        g_gdp, g_pop = out.get("gdp", {}).get(gid, {}), out.get("pop", {}).get(gid, {})
        out["gdp_pc"][gid] = {y: g_gdp[y] / g_pop[y] for y in g_gdp if g_pop.get(y)}
        out["gdp_growth"][gid] = {y: v for y in years if (v := growth(real, by_year[y], y, pop)) is not None}
    return out


def publish_indicators(con, registry: Registry):
    from .store import create_indicator_view

    if not create_indicator_view(con):
        log("  no indicator data (run fetch + normalize for worldbank_wdi); skipped")
        return None
    cfg = json.loads((CONFIG / "indicators.json").read_text())
    raw = {}
    for ind, ent, period, value in con.execute(
            "SELECT indicator, entity, period, value FROM ind WHERE freq = 'A'").fetchall():
        raw.setdefault(ind, {}).setdefault(ent, {})[int(period)] = value
    if not raw:
        log("  indicator files contain no annual rows; skipped")
        return None
    last = max(y for ents in raw.values() for s in ents.values() for y in s)
    years = list(range(cfg["start"], last + 1))
    values = compute(raw, registry, years, cfg)

    shown = [i for i in cfg["indicators"] if not i.get("hidden")]
    published = {}
    for spec in shown:
        scale = SCALE.get(spec["unit"], 1)
        published[spec["id"]] = {
            e: [sig(s[y] * scale) if s.get(y) is not None else None for y in years]
            for e, s in sorted(values.get(spec["id"], {}).items()) if s
        }
    doc = {
        "periods": [str(y) for y in years],
        "coverage_rule": f"Group sums require members with data to hold at least {COVERAGE:.0%} of the group's population.",
        "indicators": [{k: spec[k] for k in ("id", "name", "unit", "description", "group", "scale") if k in spec}
                       | {"source": spec.get("source", "derived")} for spec in shown],
        "values": published,
    }
    path = SITE_DATA / "indicators.json"
    path.write_text(json.dumps(doc, separators=(",", ":"), ensure_ascii=False))
    log(f"  indicators: {len(shown)} for {years[0]}–{years[-1]}, {path.stat().st_size / 1e6:.1f} MB")
    return doc

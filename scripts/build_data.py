#!/usr/bin/env python3
"""Build the static data files for the trade map.

Downloads bilateral goods trade from the IMF "International Trade in Goods
(by partner country)" dataset (IMTS, formerly Direction of Trade Statistics),
country regions from UN M49, and country shapes from Natural Earth (via the
world-atlas package), then writes compact JSON into site/data/.

Usage:
    python3 scripts/build_data.py              # fetch (uses cache) + build
    python3 scripts/build_data.py --refresh    # ignore cached downloads
    python3 scripts/build_data.py --start 1990

Only the Python standard library is required.
"""
import argparse
import concurrent.futures as cf
import csv
import datetime as dt
import html
import io
import json
import math
import re
import sys
import time
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / "data_raw"
OUT = ROOT / "site" / "data"
GROUPS_FILE = ROOT / "config" / "groups.json"

IMF_API = "https://api.imf.org/external/sdmx/2.1"
IMF_DATASET_URL = "https://data.imf.org/en/datasets/IMF.STA:IMTS"
M49_URL = "https://unstats.un.org/unsd/methodology/m49/overview/"
ATLAS_URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json"

EXPORTS = "XG_FOB_USD"
IMPORTS = "MG_CIF_USD"
WORLD = "G001"

# IMF codes that differ from ISO 3166 alpha-3 (as used by UN M49).
IMF_TO_ISO3 = {"KOS": "XKX"}
# Natural Earth shapes without an ISO numeric id that we can still attribute.
UNNUMBERED_SHAPES = {"Kosovo": "KOS"}
# Significant economies missing as IMTS reporters; rebuilt from partner data.
MIRROR_ECONOMIES = {"TWN"}
# Display-name overrides (IMF names are formal, e.g. "China, People's Republic of").
NAME_OVERRIDES = {
    "CHN": "China", "TWN": "Taiwan", "KOR": "South Korea", "PRK": "North Korea",
    "RUS": "Russia", "IRN": "Iran", "SYR": "Syria", "VEN": "Venezuela",
    "BOL": "Bolivia", "TZA": "Tanzania", "VNM": "Vietnam", "LAO": "Laos",
    "MDA": "Moldova", "COD": "DR Congo", "COG": "Congo (Rep.)", "HKG": "Hong Kong",
    "MAC": "Macao", "NLD": "Netherlands", "KOS": "Kosovo", "WBG": "West Bank and Gaza",
    "FSM": "Micronesia", "TUR": "Türkiye", "CIV": "Côte d'Ivoire",
    "USA": "United States", "GBR": "United Kingdom", "ARE": "United Arab Emirates",
    "CZE": "Czechia", "SVK": "Slovakia", "KGZ": "Kyrgyzstan", "BHS": "Bahamas",
    "GMB": "Gambia", "EGY": "Egypt", "YEM": "Yemen", "AFG": "Afghanistan",
    "MRT": "Mauritania", "PAK": "Pakistan", "SUN": "USSR (former)",
    "YUG": "Yugoslavia (former)", "CSK": "Czechoslovakia (former)",
    "SCG": "Serbia and Montenegro (former)", "ANT": "Netherlands Antilles (former)",
}


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http_get(url, accept=None, retries=4, timeout=120):
    headers = {"User-Agent": "eco-map-data-builder/1.0"}
    if accept:
        headers["Accept"] = accept
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return b""
            err = e
        except Exception as e:  # network hiccup, timeout
            err = e
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {err}")


def cached(name, url, refresh, accept=None):
    path = CACHE / name
    if path.exists() and not refresh:
        return path.read_bytes()
    data = http_get(url, accept)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


# --------------------------------------------------------------------------- sources

def load_imf_countries(refresh):
    xml = cached("imf_cl_country.xml", f"{IMF_API}/codelist/IMF/CL_COUNTRY", refresh).decode()
    names = dict(re.findall(r'<str:Code id="([^"]+)".*?<com:Name xml:lang="en">([^<]*)', xml, re.S))
    return {k: html.unescape(v) for k, v in names.items()}


def load_m49(refresh):
    page = cached("m49.html", M49_URL, refresh).decode("utf-8")
    i = page.find('<table id = "downloadTableEN"')
    table = page[i:page.find("</table>", i)]
    rows = []
    for r in re.findall(r"<tr.*?</tr>", table, re.S):
        cells = [html.unescape(re.sub("<[^>]+>", "", c)).strip()
                 for c in re.findall(r"<t[dh][^>]*>.*?</t[dh]>", r, re.S)]
        rows.append(cells)
    head, body = rows[0], rows[1:]
    out = {}
    for row in body:
        d = dict(zip(head, row))
        iso3 = d["ISO-alpha3 Code"]
        if iso3:
            out[iso3] = {
                "m49": d["M49 Code"],
                "name": d["Country or Area"],
                "region": d["Region Code"], "region_name": d["Region Name"],
                "subregion": d["Sub-region Code"], "subregion_name": d["Sub-region Name"],
                "intermediate": d["Intermediate Region Code"],
            }
    if len(out) < 240:
        raise RuntimeError(f"UN M49 table parse looks wrong ({len(out)} rows)")
    return out


def fetch_reporter(code, start, refresh):
    path = CACHE / "imts" / f"{code}.csv"
    if path.exists() and not refresh:
        return path.read_text()
    url = (f"{IMF_API}/data/IMF.STA,IMTS/{code}.{EXPORTS}+{IMPORTS}..A"
           f"?startPeriod={start}&detail=dataonly")
    text = http_get(url, accept="application/vnd.sdmx.data+csv;version=1.0.0").decode()
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text)
    return text


def parse_reporter_csv(text):
    """-> {partner: {year: [exports, imports]}} in USD."""
    flows = {}
    for row in csv.DictReader(io.StringIO(text)):
        v = row.get("OBS_VALUE")
        if not v:
            continue
        p, y = row["COUNTERPART_COUNTRY"], int(row["TIME_PERIOD"])
        slot = 0 if row["INDICATOR"] == EXPORTS else 1
        flows.setdefault(p, {}).setdefault(y, [None, None])[slot] = float(v)
    return flows


# --------------------------------------------------------------------------- helpers

def sig(v, digits=4):
    """Round USD -> USD millions with `digits` significant figures."""
    if v is None:
        return None
    m = v / 1e6
    if m == 0:
        return 0
    r = round(m, -int(math.floor(math.log10(abs(m)))) + (digits - 1))
    return int(r) if r == int(r) else r


def series(by_year, years):
    """{year: [x, m]} -> [[x...], [m...]] (USD millions), trailing nulls trimmed."""
    xs = [sig(by_year.get(y, [None, None])[0]) for y in years]
    ms = [sig(by_year.get(y, [None, None])[1]) for y in years]
    return [xs, ms]


def add_into(acc, by_year):
    for y, (x, m) in by_year.items():
        a = acc.setdefault(y, [None, None])
        if x is not None:
            a[0] = (a[0] or 0) + x
        if m is not None:
            a[1] = (a[1] or 0) + m


def sub_into(acc, by_year):
    for y, (x, m) in by_year.items():
        if y in acc:
            if x is not None and acc[y][0] is not None:
                acc[y][0] -= x
            if m is not None and acc[y][1] is not None:
                acc[y][1] -= m


def dump(path, obj):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(obj, separators=(",", ":"), ensure_ascii=False))


# --------------------------------------------------------------------------- build

def resolve_groups(cfg, m49_by_imf, known):
    groups, owner = [], {}
    for g in cfg["groups"]:
        members = set(g.get("members", []))
        for code, info in m49_by_imf.items():
            if (info["region"] in g.get("m49_region", [])
                    or info["subregion"] in g.get("m49_subregion", [])
                    or info["intermediate"] in g.get("m49_intermediate", [])):
                members.add(code)
        members -= set(g.get("exclude", []))
        members &= known
        for c in members:
            if c in owner:
                raise RuntimeError(f"{c} is in both {owner[c]} and {g['id']}; groups must not overlap")
            owner[c] = g["id"]
        groups.append({**{k: v for k, v in g.items() if k not in
                          ("m49_region", "m49_subregion", "m49_intermediate", "exclude")},
                       "members": sorted(members)})
    return groups


def build_world_topology(atlas, numeric_to_imf):
    geoms = []
    for g in atlas["objects"]["countries"]["geometries"]:
        name = g["properties"]["name"]
        if g.get("id") == "010":  # Antarctica
            continue
        code = numeric_to_imf.get(g.get("id")) or UNNUMBERED_SHAPES.get(name)
        g = {k: v for k, v in g.items() if k != "id"}
        g["properties"] = {"name": name}
        if code:
            g["id"] = code
        geoms.append(g)
    atlas = dict(atlas)
    atlas["objects"] = {"countries": {"type": "GeometryCollection", "geometries": geoms}}
    return atlas


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=1990)
    ap.add_argument("--refresh", action="store_true")
    ap.add_argument("--workers", type=int, default=6)
    args = ap.parse_args()

    log("Loading IMF country list and UN M49 regions…")
    imf_names = load_imf_countries(args.refresh)
    m49 = load_m49(args.refresh)
    iso3_to_imf = {IMF_TO_ISO3.get(c, c): c for c in imf_names}
    m49_by_imf = {iso3_to_imf[i]: v for i, v in m49.items() if i in iso3_to_imf}
    candidates = sorted(c for c in imf_names if re.fullmatch(r"[A-Z]{3}", c))

    log(f"Fetching IMTS bilateral trade for {len(candidates)} reporters from {args.start}…")
    raw = {}
    with cf.ThreadPoolExecutor(args.workers) as pool:
        futs = {pool.submit(fetch_reporter, c, args.start, args.refresh): c for c in candidates}
        for i, f in enumerate(cf.as_completed(futs), 1):
            c = futs[f]
            flows = parse_reporter_csv(f.result())
            if flows:
                raw[c] = flows
            if i % 25 == 0:
                log(f"  {i}/{len(candidates)}")
    log(f"  {len(raw)} reporters with data")

    years = sorted({y for fl in raw.values() for p in fl.values() for y in p})
    years = [y for y in years if y >= args.start]
    countries = set(raw)
    partners = {p for fl in raw.values() for p in fl if re.fullmatch(r"[A-Z]{3}", p)}
    entities_codes = countries | partners

    # Economies the IMF does not publish as reporters (notably Taiwan) are
    # reconstructed from partner ("mirror") data: their exports to P are P's
    # reported imports from them, and vice versa.
    mirrored = set()
    for c in sorted(MIRROR_ECONOMIES & (partners - countries)):
        fl = {}
        for r, rfl in raw.items():
            for y, (x, m) in rfl.get(c, {}).items():
                fl.setdefault(r, {})[y] = [m, x]
        world = {}
        for v in fl.values():
            add_into(world, v)
        fl[WORLD] = world
        raw[c] = fl
        mirrored.add(c)

    cfg = json.loads(GROUPS_FILE.read_text())
    groups = resolve_groups(cfg, m49_by_imf, entities_codes)
    group_of = {c: g["id"] for g in groups for c in g["members"]}

    # ---- per-entity flow files
    totals = {}
    for c, fl in raw.items():
        p_out = {p: series(v, years) for p, v in fl.items()
                 if p in entities_codes and p != c}
        dump(OUT / "flows" / f"{c}.json", {"p": p_out})
        if WORLD in fl:
            totals[c] = series(fl[WORLD], years)

    for g in groups:
        members = [m for m in g["members"] if m in raw]
        agg, intra, world = {}, {}, {}
        for m in members:
            for p, v in raw[m].items():
                if p == WORLD:
                    add_into(world, v)
                elif p in g["members"]:
                    add_into(intra, v)
                elif p in entities_codes:
                    add_into(agg.setdefault(p, {}), v)
        sub_into(world, intra)  # extra-group trade only
        dump(OUT / "flows" / f"{g['id']}.json", {
            "p": {p: series(v, years) for p, v in agg.items()},
            "intra": series(intra, years),
        })
        totals[g["id"]] = series(world, years)

    dump(OUT / "totals.json", totals)

    # ---- map shapes
    atlas = json.loads(cached("countries-50m.json", ATLAS_URL, args.refresh))
    numeric_to_imf = {v["m49"]: k for k, v in m49_by_imf.items()}
    numeric_to_imf["158"] = "TWN"  # Taiwan is not listed in M49
    dump(OUT / "world.json", build_world_topology(atlas, numeric_to_imf))

    # ---- metadata
    ents = {}
    for c in sorted(entities_codes):
        info = m49_by_imf.get(c, {})
        ents[c] = {
            "name": NAME_OVERRIDES.get(c) or info.get("name") or imf_names.get(c, c),
            "region": info.get("region_name"),
            "subregion": info.get("subregion_name"),
            "reporter": c in raw,
        }
        if c in mirrored:
            ents[c]["mirror"] = True
        if c in group_of:
            ents[c]["group"] = group_of[c]
    today = dt.date.today().isoformat()
    meta = {
        "years": years,
        "units": "USD millions (current prices)",
        "generated": today,
        "entities": ents,
        "groups": groups,
        "sources": [
            {
                "id": "imf-imts",
                "name": "IMF, International Trade in Goods (by partner country) — IMTS",
                "formerly": "Direction of Trade Statistics (DOTS)",
                "url": IMF_DATASET_URL,
                "api": f"{IMF_API}/data/IMF.STA,IMTS",
                "series": {"exports": f"{EXPORTS} — Exports of goods, FOB, US dollars",
                           "imports": f"{IMPORTS} — Imports of goods, CIF, US dollars"},
                "citation": f"International Monetary Fund. International Trade in Goods (by partner country), {IMF_DATASET_URL}. Accessed on {today}.",
                "terms": "https://www.imf.org/external/terms.htm",
                "accessed": today,
            },
            {
                "id": "un-m49",
                "name": "United Nations Statistics Division, Standard country or area codes for statistical use (M49)",
                "url": M49_URL,
                "accessed": today,
            },
            {
                "id": "natural-earth",
                "name": "Natural Earth 1:50m admin-0 countries, via the world-atlas package",
                "url": "https://www.naturalearthdata.com/",
                "terms": "Public domain",
                "accessed": today,
            },
        ],
    }
    dump(OUT / "meta.json", meta)
    shaped = {g.get("id") for g in json.loads((OUT / "world.json").read_text())["objects"]["countries"]["geometries"]}
    log(f"Done: {len(years)} years ({years[0]}–{years[-1]}), {len(ents)} countries, "
        f"{len(groups)} groups. Reporters without a map shape: "
        f"{sorted(c for c in raw if c not in shaped)}")


if __name__ == "__main__":
    main()

"""UNDP Human Development Report: composite indices (Human Development Index), annual, by country.

One CSV with a column per indicator and year (`hdi_1990`, ...), for the indicators listed in
config/indicators.json with source "undp_hdr" (`source_code` is the column prefix). Country codes are
ISO3, the same as entity ids; the World aggregate (ZZK.WORLD) is kept as WLD, other aggregates
(regions, development groups) are dropped. Each report has a new file name: bump URL for a new one.
"""
import csv
import io
import json

from ..net import download, read_manifest, write_manifest
from ..paths import CONFIG, RAW
from ..registry import WORLD
from ..store import write_indicators

ID = "undp_hdr"
KIND = "indicators"
URL = "https://hdr.undp.org/sites/default/files/2025_HDR/HDR25_Composite_indices_complete_time_series.csv"
META = {
    "name": "UNDP, Human Development Report 2025: composite indices time series",
    "url": "https://hdr.undp.org/data-center/documentation-and-downloads",
    "citation": "UNDP (United Nations Development Programme), Human Development Report 2025, composite indices "
                "time series, https://hdr.undp.org. Accessed on {accessed}.",
    "terms": "CC BY 3.0 IGO",
    "terms_url": "https://hdr.undp.org/terms-use",
}
FOLDER = RAW / ID
FILE = FOLDER / "composite_indices_time_series.csv"
AGGREGATES = {"ZZK.WORLD": WORLD}


def wanted():
    cfg = json.loads((CONFIG / "indicators.json").read_text())
    return cfg["start"], [i for i in cfg["indicators"] if i.get("source") == ID]


def _check(data: bytes):
    if not data.startswith(b"iso3,"):
        raise ValueError("not the HDR composite indices CSV")


def fetch(refresh=False):
    download(FILE, URL, refresh, validate=_check)
    if refresh or not read_manifest(FOLDER):
        write_manifest(FOLDER, url=URL)


def read_rows(raw: bytes):
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:  # some releases are Windows-1252 (accented country names)
        text = raw.decode("cp1252")
    return list(csv.DictReader(io.StringIO(text)))


def normalize(con, registry):
    start, inds = wanted()
    rows, unmapped = [], set()
    for r in read_rows(FILE.read_bytes()):
        code = AGGREGATES.get(r["iso3"], r["iso3"])
        if code != WORLD and code not in registry.entities:
            unmapped.add(r["iso3"])
            continue
        for ind in inds:
            prefix = f"{ind['source_code']}_"
            for col, v in r.items():
                year = col[len(prefix):] if col.startswith(prefix) else ""
                if year.isdigit() and int(year) >= start and v not in ("", None):
                    rows.append((ID, ind["id"], code, "A", year, float(v), ind["unit"]))
    n = write_indicators(con, ID, rows)
    return {"rows": n, "indicators": [i["id"] for i in inds], "dropped_codes": sorted(unmapped)}

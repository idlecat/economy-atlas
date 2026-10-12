"""World Bank International Debt Statistics: public external debt of low- and middle-income countries,
by creditor country.

One API request per measure and creditor in config/bilateral.json (source "worldbank_ids"), covering
all debtor countries and years. Debtor codes are ISO3 = entity ids; World Bank aggregates are dropped.
"""
import json

from ..net import download, read_manifest, write_manifest
from ..paths import CONFIG, RAW
from ..store import write_bilateral

ID = "worldbank_ids"
KIND = "bilateral"
API = "https://api.worldbank.org/v2"
META = {
    "name": "World Bank, International Debt Statistics",
    "url": "https://www.worldbank.org/en/programs/debt-statistics/ids",
    "citation": "World Bank, International Debt Statistics, https://data.worldbank.org. Accessed on {accessed}.",
    "terms": "CC BY 4.0",
    "terms_url": "https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets",
}
FOLDER = RAW / ID


def wanted():
    cfg = json.loads((CONFIG / "bilateral.json").read_text())
    return cfg["start"], [m for m in cfg["measures"] if m["source"] == ID]


def _path(measure, code):
    return FOLDER / f"{measure['source_code']}_{code}.json"


def fetch(refresh=False):
    _, measures = wanted()
    for m in measures:
        for code in m["counterparts"].values():
            url = (f"{API}/sources/6/country/all/series/{m['source_code']}/counterpart-area/{code}"
                   f"/time/all?format=json&per_page=30000")
            download(_path(m, code), url, refresh)
    if refresh or not read_manifest(FOLDER):
        write_manifest(FOLDER, url=API)


def normalize(con, registry):
    start, measures = wanted()
    rows, dropped = [], set()
    for m in measures:
        for cp, code in m["counterparts"].items():
            doc = json.loads(_path(m, code).read_text())
            if doc.get("pages", 1) > 1:
                raise RuntimeError(f"{_path(m, code).name}: more than one page of results; raise per_page")
            for r in doc["source"]["data"]:
                var = {v["concept"]: v["id"] for v in r["variable"]}
                year = var["Time"].removeprefix("YR")
                if r["value"] is None or int(year) < start:
                    continue
                if var["Country"] not in registry.entities:
                    dropped.add(var["Country"])
                    continue
                rows.append((ID, m["id"], var["Country"], cp, "A", year, float(r["value"]), m["unit"], ""))
    return {"rows": write_bilateral(con, ID, rows), "dropped_codes": sorted(dropped)}  # regional aggregates

"""World Bank World Development Indicators: country-level annual indicators (GDP, population, ...).

One API request per indicator listed in config/indicators.json with source "worldbank_wdi".
World Bank country codes are ISO3, the same as entity ids. The World aggregate (WLD) is kept, for
world figures; other aggregates (EUU, AFE, ...) are not entities and are dropped. Taiwan is not covered by the World Bank.
"""
import json

from ..net import download, json_check, read_manifest, write_manifest
from ..paths import CONFIG, RAW
from ..registry import WORLD
from ..store import write_indicators

ID = "worldbank_wdi"
KIND = "indicators"
API = "https://api.worldbank.org/v2"
META = {
    "name": "World Bank, World Development Indicators",
    "url": "https://databank.worldbank.org/source/world-development-indicators",
    "citation": "World Bank, World Development Indicators, https://data.worldbank.org. Accessed on {accessed}.",
    "terms": "CC BY 4.0",
    "terms_url": "https://www.worldbank.org/en/about/legal/terms-of-use-for-datasets",
}
FOLDER = RAW / ID


def wanted():
    cfg = json.loads((CONFIG / "indicators.json").read_text())
    return cfg["start"], [i for i in cfg["indicators"] if i.get("source") == ID]


def fetch(refresh=False):
    start, inds = wanted()
    for ind in inds:
        url = (f"{API}/country/all/indicator/{ind['source_code']}"
               f"?format=json&per_page=20000&date={start}:2100")
        # the API answers errors with HTTP 200 and a one-element message list
        download(FOLDER / f"{ind['source_code']}.json", url, refresh,
                 validate=json_check(lambda d: isinstance(d, list) and len(d) == 2 and isinstance(d[1], list)))
    if refresh or not read_manifest(FOLDER):
        write_manifest(FOLDER, url=API)


def normalize(con, registry):
    _, inds = wanted()
    rows, unmapped = [], set()
    for ind in inds:
        meta, data = json.loads((FOLDER / f"{ind['source_code']}.json").read_text())
        if meta.get("pages", 1) > 1:
            raise RuntimeError(f"{ind['source_code']}: more than one page of results; raise per_page")
        for r in data or []:
            code = r["countryiso3code"]
            if r["value"] is None or not code:
                continue
            if code not in registry.entities and code != WORLD:
                unmapped.add(code)
                continue
            rows.append((ID, ind["id"], code, "A", r["date"], float(r["value"]), ind["unit"]))
    n = write_indicators(con, ID, rows)
    return {"rows": n, "indicators": [i["id"] for i in inds],
            "dropped_codes": sorted(unmapped)}  # World Bank aggregates such as EUU, AFE

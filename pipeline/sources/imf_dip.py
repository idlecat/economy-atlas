"""IMF Direct Investment Positions by counterpart economy (DIP, formerly the Coordinated Direct
Investment Survey, CDIS).

Two requests per measure: inward positions reported by every host economy vis-a-vis the counterparts
in config/bilateral.json (basis "host"), and outward positions reported by those counterparts for
every destination (basis "investor"). Publish picks one basis per series (see `precedence`).
OBS_VALUE is in US dollars. Country codes follow the IMF scheme (`imf` column of entities.csv).
"""
import csv
import io
import json

from ..net import download, read_manifest, write_manifest
from ..paths import CONFIG, RAW
from ..store import write_bilateral

ID = "imf_dip"
KIND = "bilateral"
API = "https://api.imf.org/external/sdmx/2.1"
DATASET_URL = "https://data.imf.org/en/datasets/IMF.STA:DIP"
META = {
    "name": "IMF, Direct Investment Positions by Counterpart Economy (formerly CDIS)",
    "url": DATASET_URL,
    "citation": f"International Monetary Fund. Direct Investment Positions by Counterpart Economy, {DATASET_URL}. "
                "Accessed on {accessed}.",
    "terms": "https://www.imf.org/external/terms.htm",
}
FOLDER = RAW / ID
CSV = "application/vnd.sdmx.data+csv;version=1.0.0"
INWARD = "INWD_D_NETLA_FALL_ALL"   # inward DI, net (liabilities less assets), all instruments, all entities
OUTWARD = "OTWD_D_NETAL_FALL_ALL"  # outward DI, net (assets less liabilities), all instruments, all entities
WORLD = "G001"


def wanted():
    cfg = json.loads((CONFIG / "bilateral.json").read_text())
    return cfg["start"], [m for m in cfg["measures"] if m["source"] == ID]


def _csv_check(data):
    if not data.startswith(b"DATAFLOW,"):
        raise ValueError(f"not SDMX CSV: {data[:120]!r}")


def fetch(refresh=False):
    _, measures = wanted()
    for m in measures:
        codes = m["counterparts"].values()
        investors = "+".join(c for c in codes if c != WORLD)
        download(FOLDER / f"{m['id']}_inward.csv",
                 f"{API}/data/IMF.STA,DIP/.O.{INWARD}.{'+'.join(codes)}.A?detail=dataonly", refresh, accept=CSV, validate=_csv_check)
        download(FOLDER / f"{m['id']}_outward.csv",
                 f"{API}/data/IMF.STA,DIP/{investors}.O.{OUTWARD}..A?detail=dataonly", refresh, accept=CSV, validate=_csv_check)
    if refresh or not read_manifest(FOLDER):
        write_manifest(FOLDER, url=f"{API}/data/IMF.STA,DIP")


def normalize(con, registry):
    start, measures = wanted()
    imf = registry.code_map("imf")  # IMF code -> entity id
    rows, unmapped = [], set()
    for m in measures:
        to_cp = {code: cp for cp, code in m["counterparts"].items()}
        for direction, basis in (("inward", "host"), ("outward", "investor")):
            text = (FOLDER / f"{m['id']}_{direction}.csv").read_text(encoding="utf-8")
            for r in csv.DictReader(io.StringIO(text)):
                if not r["OBS_VALUE"] or not r["TIME_PERIOD"] or int(r["TIME_PERIOD"]) < start:
                    continue
                host, other = (r["COUNTRY"], r["COUNTERPART_COUNTRY"]) if basis == "host" else (r["COUNTERPART_COUNTRY"], r["COUNTRY"])
                entity, cp = imf.get(host), to_cp.get(other)
                if entity is None or cp is None:
                    unmapped.add(host)  # IMF regional aggregates (G..., GX..., TX...) and unknown codes
                    continue
                rows.append((ID, m["id"], entity, cp, "A", r["TIME_PERIOD"], float(r["OBS_VALUE"]), m["unit"], basis))
    return {"rows": write_bilateral(con, ID, rows), "unmapped_codes": sorted(unmapped)}

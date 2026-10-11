"""IMF International Trade in Goods (by partner country), IMTS — formerly Direction of Trade Statistics.

Fetched from the IMF SDMX 2.1 API, one request per reporter, as CSV. OBS_VALUE is in US dollars.
Raw files: data_raw/imf_imts/<FREQ>/<IMF code>.csv
"""
import concurrent.futures as cf
import json
import re

from ..net import download, http_get, log, read_manifest, write_manifest
from ..paths import CONFIG, RAW
from ..registry import WORLD

ID = "imf_imts"
KIND = "observations"
API = "https://api.imf.org/external/sdmx/2.1"
DATASET_URL = "https://data.imf.org/en/datasets/IMF.STA:IMTS"
META = {
    "name": "IMF, International Trade in Goods (by partner country) — IMTS",
    "formerly": "Direction of Trade Statistics (DOTS)",
    "url": DATASET_URL,
    "api": f"{API}/data/IMF.STA,IMTS",
    "series": {"exports": "XG_FOB_USD — Exports of goods, FOB, US dollars",
               "imports": "MG_CIF_USD — Imports of goods, CIF, US dollars"},
    "citation": "International Monetary Fund. International Trade in Goods (by partner country), "
                f"{DATASET_URL}. Accessed on {{accessed}}.",
    "terms": "https://www.imf.org/external/terms.htm",
}
FOLDER = RAW / ID
INDICATORS = {"XG_FOB_USD": ("X", "FOB"), "MG_CIF_USD": ("M", "CIF")}
IMF_WORLD = "G001"
FREQS = ["A", "M"]
CSV = "application/vnd.sdmx.data+csv;version=1.0.0"


def _start_years():
    return {f: c["start"] for f, c in json.loads((CONFIG / "datasets.json").read_text())["goods_trade"]["freqs"].items()}


def fetch(refresh=False, workers=3):
    from ..registry import Registry  # lazy: registry needs M49 reference data only for groups

    codelist = download(FOLDER / "_codelist_country.xml", f"{API}/codelist/IMF/CL_COUNTRY", refresh).decode()
    known = Registry.load().code_map("imf")
    imf_codes = {c for c in re.findall(r'<str:Code id="([A-Z]{3})"', codelist)}
    missing = sorted(imf_codes - set(known))
    if missing:
        log(f"  note: IMF country codes not in config/entities.csv (skipped): {missing}")
    reporters = sorted(imf_codes & set(known))
    starts = _start_years()
    keys = "+".join(INDICATORS)

    def one(freq, code):
        path = FOLDER / freq / f"{code}.csv"
        if path.exists() and not refresh:
            return
        text = http_get(f"{API}/data/IMF.STA,IMTS/{code}.{keys}..{freq}?startPeriod={starts[freq]}&detail=dataonly", CSV)
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(text)

    jobs = [(f, c) for f in FREQS if f in starts for c in reporters]
    log(f"  {len(jobs)} reporter requests ({'refresh' if refresh else 'cached where possible'})")
    failed = []
    with cf.ThreadPoolExecutor(workers) as pool:
        futs = {pool.submit(one, f, c): (f, c) for f, c in jobs}
        for i, fut in enumerate(cf.as_completed(futs), 1):
            if fut.exception():
                failed.append(futs[fut])
                log(f"  failed {futs[fut]}: {fut.exception()}")
            if i % 50 == 0:
                log(f"  {i}/{len(jobs)}")
    if failed:
        raise RuntimeError(f"{len(failed)} IMF requests failed; rerun fetch to retry only those (cached files are kept)")
    if refresh or read_manifest(FOLDER).get("starts") != starts:
        write_manifest(FOLDER, url=META["api"], starts=starts)


def normalize(con, registry):
    files = [str(p) for f in FREQS for p in sorted((FOLDER / f).glob("*.csv")) if p.stat().st_size > 0]
    con.execute(f"""
        CREATE OR REPLACE TEMP TABLE imf_raw AS
        SELECT COUNTRY, INDICATOR, COUNTERPART_COUNTRY, FREQUENCY, TIME_PERIOD, OBS_VALUE
        FROM read_csv({files!r}, all_varchar = true, union_by_name = true)
        WHERE OBS_VALUE IS NOT NULL AND OBS_VALUE <> ''
    """)
    xwalk = list(registry.code_map("imf").items()) + [(IMF_WORLD, WORLD)]
    con.execute("CREATE OR REPLACE TEMP TABLE imf_xwalk (code VARCHAR, id VARCHAR)")
    con.executemany("INSERT INTO imf_xwalk VALUES (?, ?)", xwalk)
    con.execute("CREATE OR REPLACE TEMP TABLE imf_ind (code VARCHAR, flow VARCHAR, valuation VARCHAR)")
    con.executemany("INSERT INTO imf_ind VALUES (?, ?, ?)", [(k, *v) for k, v in INDICATORS.items()])

    from ..store import write_observations
    n = write_observations(con, ID, """
        -- SDMX monthly periods look like 2008-M11; the store uses 2008-11
        SELECT 'imf_imts' AS source, 'goods_trade' AS dataset, r.id AS reporter, p.id AS partner,
               i.flow, 'TOTAL' AS product, raw.FREQUENCY AS freq,
               CASE WHEN raw.FREQUENCY = 'M' THEN replace(raw.TIME_PERIOD, '-M', '-') ELSE raw.TIME_PERIOD END AS period,
               raw.OBS_VALUE AS value, 'USD' AS unit, i.valuation, '' AS flag
        FROM imf_raw raw
        JOIN imf_ind i ON raw.INDICATOR = i.code
        JOIN imf_xwalk r ON raw.COUNTRY = r.code
        JOIN imf_xwalk p ON raw.COUNTERPART_COUNTRY = p.code
    """)
    # Partner codes we drop: IMF regional aggregates (G..., GX..., TX... = "not specified") are
    # expected; anything else means config/entities.csv is missing a mapping.
    dropped = con.execute("""
        SELECT COUNTERPART_COUNTRY, count(*) FROM imf_raw
        WHERE COUNTERPART_COUNTRY NOT IN (SELECT code FROM imf_xwalk)
        GROUP BY 1 ORDER BY 1
    """).fetchall()
    unmapped = [c for c, _ in dropped if not re.fullmatch(r"(G|GX|TX)\d+", c)]
    return {"rows": n, "files": len(files), "unmapped_partner_codes": unmapped,
            "ignored_aggregate_codes": [c for c, _ in dropped if c not in unmapped]}

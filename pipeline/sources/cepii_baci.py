"""CEPII BACI: bilateral trade by product (HS 1992, 6-digit), annual, reconciled from both sides' reports.

One zip with a CSV per year (columns t=year, i=exporter, j=importer, k=HS6 product, v=value in
thousand USD, q=quantity in tonnes) plus country and product code lists.

normalize aggregates the ~5,000 HS6 codes into the sectors and commodities of
config/products.json, so the store stays small; edit that file and re-run normalize to change them.
Each BACI flow becomes two observations: exports reported by the exporter and imports reported by
the importer (BACI reconciles the two, so they carry the same value).
"""
import csv
import io
import json
import re
import tempfile
import zipfile
from pathlib import Path

from ..net import download_large, log, read_manifest, write_manifest
from ..paths import CONFIG, RAW
from ..registry import WORLD
from ..store import write_observations

ID = "cepii_baci"
KIND = "observations"
VERSION = "202601"
HS = "HS92"
ZIP_NAME = f"BACI_{HS}_V{VERSION}.zip"
URL = f"https://www.cepii.fr/DATA_DOWNLOAD/baci/data/{ZIP_NAME}"
PAGE = "https://www.cepii.fr/CEPII/en/bdd_modele/bdd_modele_item.asp?id=37"
META = {
    "name": f"CEPII BACI — international trade by product ({HS} classification, version {VERSION})",
    "url": PAGE,
    "citation": "Gaulier, G. and Zignago, S. (2010). BACI: International Trade Database at the Product-Level. "
                f"The 1994-2007 Version. CEPII Working Paper N°2010-23. Data version {VERSION}, accessed on {{accessed}}.",
    "terms": "Etalab Open Licence 2.0",
    "terms_url": "https://www.etalab.gouv.fr/licence-ouverte-open-licence/",
}
FOLDER = RAW / ID
ZIP = FOLDER / ZIP_NAME
# BACI country codes deliberately left out of config/entities.csv.
KNOWN_UNMAPPED = {
    "278": "German Democratic Republic (before 1990)",
    "697": "Europe EFTA, not specified",
    "711": "Southern African Customs Union, reported as one unit until 1999",
    "849": "US Miscellaneous Pacific Islands",
}


def fetch(refresh=False):
    # A BACI release never changes once published, so `refresh` doesn't re-download it;
    # bump VERSION to move to a new release (CEPII publishes one or two a year).
    fresh = not ZIP.exists()
    download_large(ZIP, URL)
    if fresh or read_manifest(FOLDER).get("version") != VERSION:
        write_manifest(FOLDER, url=URL, version=VERSION)


def load_taxonomy(path=CONFIG / "products.json"):
    taxonomy = json.loads(Path(path).read_text())
    validate_taxonomy(taxonomy)
    return taxonomy


def validate_taxonomy(taxonomy):
    """Sectors must not overlap each other, nor commodities each other (prefix overlap counts)."""
    ids = [it["id"] for it in taxonomy["sectors"] + taxonomy["commodities"]]
    if len(ids) != len(set(ids)) or "TOTAL" in ids:
        raise ValueError("product ids must be unique and not TOTAL")
    for kind in ("sectors", "commodities"):
        prefixes = [(p, it["id"]) for it in taxonomy[kind] for p in it["hs"]]
        for a, ida in prefixes:
            for b, idb in prefixes:
                if ida != idb and b.startswith(a):
                    raise ValueError(f"{kind}: {ida} ({a}) overlaps {idb} ({b})")
    sectors = {it["id"] for it in taxonomy["sectors"]}
    for it in taxonomy["commodities"]:
        if it["sector"] not in sectors:
            raise ValueError(f"commodity {it['id']}: unknown sector {it['sector']}")


def classify(hs6: str, taxonomy) -> tuple[str, str | None]:
    """HS6 code -> (sector id, commodity id or None). Longest matching prefix wins within each list."""
    def best(items):
        hits = [(len(p), it["id"]) for it in items for p in it["hs"] if hs6.startswith(p)]
        return max(hits)[1] if hits else None
    return best(taxonomy["sectors"]) or "OTHER", best(taxonomy["commodities"])


def _members(zf):
    names = zf.namelist()
    years = {int(m.group(1)): n for n in names if (m := re.search(r"_Y(\d{4})_", n))}
    countries = next(n for n in names if "country_codes" in n)
    products = next(n for n in names if "product_codes" in n)
    return years, countries, products


def country_codes():
    """BACI numeric country code -> (iso3, name), straight from the zip."""
    with zipfile.ZipFile(ZIP) as zf:
        _, countries, _ = _members(zf)
        rows = csv.DictReader(io.TextIOWrapper(zf.open(countries), encoding="utf-8"))
        return {r["country_code"]: (r["country_iso3"], r["country_name"]) for r in rows}


def normalize(con, registry):
    taxonomy = load_taxonomy()
    with zipfile.ZipFile(ZIP) as zf:
        years, _, products_member = _members(zf)
        hs_codes = [r["code"].zfill(6) for r in csv.DictReader(io.TextIOWrapper(zf.open(products_member), encoding="utf-8"))]
        mapping = []
        for code in hs_codes:
            sector, commodity = classify(code, taxonomy)
            mapping.append((code, sector))
            if commodity:
                mapping.append((code, commodity))
        con.execute("CREATE OR REPLACE TEMP TABLE baci_map (k VARCHAR, product VARCHAR)")
        con.executemany("INSERT INTO baci_map VALUES (?, ?)", mapping)
        con.execute("CREATE OR REPLACE TEMP TABLE baci_agg (year INTEGER, i VARCHAR, j VARCHAR, product VARCHAR, v DOUBLE)")

        with tempfile.TemporaryDirectory() as tmp:
            for year in sorted(years):
                path = Path(tmp) / "year.csv"
                with zf.open(years[year]) as src, open(path, "wb") as dst:
                    while chunk := src.read(1 << 24):
                        dst.write(chunk)
                con.execute(f"""
                    INSERT INTO baci_agg
                    SELECT CAST(t AS INTEGER), i, j, m.product, sum(TRY_CAST(trim(v) AS DOUBLE)) * 1000
                    FROM read_csv('{path}', all_varchar = true) c
                    JOIN baci_map m ON lpad(trim(c.k), 6, '0') = m.k
                    GROUP BY ALL
                """)
                path.unlink()
                log(f"  BACI {year}")

    xwalk = list(registry.code_map("baci").items())
    con.execute("CREATE OR REPLACE TEMP TABLE baci_xwalk (code VARCHAR, id VARCHAR)")
    con.executemany("INSERT INTO baci_xwalk VALUES (?, ?)", xwalk)
    con.execute("""
        CREATE OR REPLACE TEMP TABLE baci_flows AS
        SELECT a.year, e.id AS exporter, m.id AS importer, a.product, a.v
        FROM baci_agg a JOIN baci_xwalk e ON a.i = e.code JOIN baci_xwalk m ON a.j = m.code
        WHERE e.id <> m.id AND a.v IS NOT NULL
    """)
    n = write_observations(con, ID, f"""
        WITH rows AS (
            SELECT exporter AS reporter, importer AS partner, 'X' AS flow, product, year, v FROM baci_flows
            UNION ALL
            SELECT importer, exporter, 'M', product, year, v FROM baci_flows
        ), with_world AS (
            SELECT * FROM rows
            UNION ALL
            SELECT reporter, '{WORLD}', flow, product, year, sum(v) FROM rows GROUP BY reporter, flow, product, year
        )
        SELECT '{ID}' AS source, 'goods_by_product' AS dataset, reporter, partner, flow, product,
               'A' AS freq, CAST(year AS VARCHAR) AS period, v AS value, 'USD' AS unit,
               'FOB' AS valuation, '' AS flag
        FROM with_world
    """)
    unmapped = con.execute("""
        SELECT DISTINCT code FROM (SELECT i AS code FROM baci_agg UNION SELECT j FROM baci_agg)
        WHERE code NOT IN (SELECT code FROM baci_xwalk) ORDER BY 1
    """).fetchall()
    return {"rows": n, "years": [min(years), max(years)], "hs_codes": len(hs_codes),
            "unmapped_partner_codes": [c for (c,) in unmapped if c not in KNOWN_UNMAPPED],
            "known_unmapped_codes": {c: KNOWN_UNMAPPED[c] for (c,) in unmapped if c in KNOWN_UNMAPPED}}

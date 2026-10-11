"""UN M49 standard country or area codes: regions used for group definitions and labels."""
import html
import re

from ..net import download, read_manifest, write_manifest
from ..paths import RAW
from ..store import write_reference

ID = "un_m49"
KIND = "reference"
URL = "https://unstats.un.org/unsd/methodology/m49/overview/"
META = {
    "name": "United Nations Statistics Division, Standard country or area codes for statistical use (M49)",
    "url": URL,
}
FOLDER = RAW / ID


def fetch(refresh=False):
    path = FOLDER / "overview.html"
    fresh = refresh or not path.exists()
    download(path, URL, refresh)
    if fresh or not read_manifest(FOLDER):
        write_manifest(FOLDER, url=URL)


def parse(page: str) -> list[dict]:
    i = page.find('<table id = "downloadTableEN"')
    table = page[i:page.find("</table>", i)]
    rows = [[html.unescape(re.sub("<[^>]+>", "", c)).strip()
             for c in re.findall(r"<t[dh][^>]*>.*?</t[dh]>", r, re.S)]
            for r in re.findall(r"<tr.*?</tr>", table, re.S)]
    head, body = rows[0], rows[1:]
    out = []
    for row in body:
        d = dict(zip(head, row))
        out.append({
            "m49": d["M49 Code"], "iso3": d["ISO-alpha3 Code"], "name": d["Country or Area"],
            "region": d["Region Code"], "region_name": d["Region Name"],
            "subregion": d["Sub-region Code"], "subregion_name": d["Sub-region Name"],
            "intermediate": d["Intermediate Region Code"], "intermediate_name": d["Intermediate Region Name"],
        })
    if len(out) < 240:
        raise RuntimeError(f"UN M49 table parse looks wrong ({len(out)} rows)")
    return out


def normalize(con, registry=None):
    rows = parse((FOLDER / "overview.html").read_text(encoding="utf-8"))
    write_reference(con, ID, rows)
    return {"rows": len(rows)}

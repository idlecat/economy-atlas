"""Build the Ancient Crossroads page from page.html, data.js, app.js and Natural Earth geography.

Downloads coastlines, rivers and lakes from Natural Earth (public domain) into .cache/,
simplifies them, and inlines them with data.js and app.js into page.html.

    uv run python prototypes/ancient-crossroads/build.py          # ancient-crossroads.html (Claude artifact)
    uv run python prototypes/ancient-crossroads/build.py --site   # site/ancient/index.html (GitHub Pages)

The artifact loads D3 and fonts from CDNs. The site page uses site/vendor/ instead (scripts/vendor.sh),
like the rest of the site, so it also works where CDNs are blocked.
"""
import json
import sys
import ssl
import urllib.request
from pathlib import Path

import certifi

# Bundled CA certificates: uv-managed Pythons don't see the macOS system store.
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())

HERE = Path(__file__).parent
CACHE = HERE / ".cache"
SOURCES = {
    "land-50m.json": "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/land-50m.json",
    "rivers50.geojson": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_rivers_lake_centerlines.geojson",
    "lakes50.geojson": "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_50m_lakes.geojson",
}
# Rivers kept below Natural Earth's top scale ranks, because ancient civilisations grew on them.
KEEP = {'Tarim','Jordan','Yamuna','Po','Huang','Indus','Tigris','Euphrates','Al Furat','Firat','Dicle','Amu  Darya','Syr Darya','Ganges','Nile','Yangtze','Chang Jiang','Danube','Donau','Volga','Dnipro','Dnepre','Niger','Rhine','Rhein','Mekong','Ayeyarwady','Shatt al Arab','Narmada','Krishna','Godävari','Sutlej','Chenab','Han','Wei','Xi','Helmand','Zambezi','Congo','Mississippi','Amazonas','Senegal','Sénégal','Orinoco','Rio Grande','Grande','Usumacinta','Ucayali','Marañón','El Bahr el Abyad','El Bahr el Azraq','Abay','Atbara','Dniester','Don','Elbe','Seine','Loire','Rhône','Tajo','Ebro','Vistula','Oder','Amur','Liao','Ural','Kama','Ob','Irtysh','Yenisey','Brahmaputra','Salween','Hong','Ohio','Missouri'}
LAKES = ("Aral Sea", "Lake Balkhash", "Issyk-Kul", "Lake Urmia", "Lake Van", "Lago Titicaca", "Lake Chad", "Lake Tana", "Dead Sea", "Lake Victoria")


def fetch(name):
    path = CACHE / name
    if not path.exists():
        CACHE.mkdir(exist_ok=True)
        with urllib.request.urlopen(SOURCES[name], context=SSL_CONTEXT, timeout=120) as r:
            path.write_bytes(r.read())
    return json.loads(path.read_text())


def simp(coords, tol=0.08):
    out = [coords[0]]
    for p in coords[1:]:
        if abs(p[0] - out[-1][0]) + abs(p[1] - out[-1][1]) >= tol:
            out.append(p)
    if out[-1] != coords[-1]:
        out.append(coords[-1])
    return [[round(x, 2), round(y, 2)] for x, y in out]


def geography():
    rivers = []
    for f in fetch("rivers50.geojson")["features"]:
        p = f["properties"]
        if (p.get("scalerank") or 9) <= 4 or p.get("name") in KEEP:
            g = f["geometry"]
            for line in g["coordinates"] if g["type"] == "MultiLineString" else [g["coordinates"]]:
                if len(line) > 1:
                    rivers.append(simp(line))
    lakes = []
    for f in fetch("lakes50.geojson")["features"]:
        p = f["properties"]
        if (p.get("scalerank") or 9) <= 2 or p.get("name") in LAKES:
            g = f["geometry"]
            for poly in g["coordinates"] if g["type"] == "MultiPolygon" else [g["coordinates"]]:
                ring = simp(poly[0], 0.05)
                if ring[0] != ring[-1]:
                    ring.append(ring[0])
                if len(ring) >= 4:
                    lakes.append([ring])
    return {"land": fetch("land-50m.json"), "rivers": rivers, "lakes": lakes}


CDN_FONTS = """<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Marcellus&family=Alegreya+Sans:ital,wght@0,400;0,500;0,700;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">"""
CDN_SCRIPTS = """<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js"></script>
<script>const GEO = /*GEO*/;</script>
<script>/*DATA*/</script>
<script>/*APP*/</script>"""
# The artifact host wraps the page in a document with a small reset; the site page brings its own.
SITE_HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="An interactive map of civilisations from 3000 BC to AD 1500 and how they met: empires, Silk Road trade routes, journeys, battles and the spread of ideas.">
<link rel="stylesheet" href="../vendor/fonts/ancient-crossroads.css">
<style>body { margin: 0; } [hidden] { display: none !important; }</style>
"""
SITE_SCRIPTS = """<script type="module">
import * as d3 from "../vendor/d3.js";
import * as topojson from "../vendor/topojson-client.js";
const GEO = /*GEO*/;
/*DATA*/
/*APP*/
</script>"""


def main():
    site = "--site" in sys.argv[1:]
    page = (HERE / "page.html").read_text()
    assert CDN_FONTS in page and CDN_SCRIPTS in page, "page.html head or scripts changed; update build.py"
    if site:
        page = page.replace(CDN_FONTS + "\n", "").replace(CDN_SCRIPTS, SITE_SCRIPTS)
        page = page.replace("<header>", "</head>\n<body>\n<header>", 1)
        page = SITE_HEAD + page + "</body>\n</html>\n"
    page = (page.replace("/*GEO*/", json.dumps(geography(), separators=(",", ":")))
            .replace("/*DATA*/", (HERE / "data.js").read_text())
            .replace("/*APP*/", (HERE / "app.js").read_text()))
    out = HERE.parent.parent / "site" / "ancient" / "index.html" if site else HERE / "ancient-crossroads.html"
    out.parent.mkdir(exist_ok=True)
    out.write_text(page)
    print(f"wrote {out} ({len(page) // 1024} KB)")


if __name__ == "__main__":
    main()

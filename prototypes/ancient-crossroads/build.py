"""Build ancient-crossroads.html: a single self-contained page.

Downloads coastlines, rivers and lakes from Natural Earth (public domain) into .cache/,
simplifies them, and inlines them with data.js and app.js into page.html.

    uv run python prototypes/ancient-crossroads/build.py
"""
import json
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


def main():
    page = (HERE / "page.html").read_text()
    page = (page.replace("/*GEO*/", json.dumps(geography(), separators=(",", ":")))
            .replace("/*DATA*/", (HERE / "data.js").read_text())
            .replace("/*APP*/", (HERE / "app.js").read_text()))
    out = HERE / "ancient-crossroads.html"
    out.write_text(page)
    print(f"wrote {out} ({len(page) // 1024} KB)")


if __name__ == "__main__":
    main()

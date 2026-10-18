"""Build the Ancient Crossroads page from page.html, data.js, app.js and Natural Earth geography.

Downloads coastlines, today's countries, rivers and lakes from Natural Earth (public domain) into .cache/,
simplifies them, and inlines them with data.js, cities.js, details.js and app.js into page.html. For each
civilisation it also fetches the lead text, image and image credit of its Wikipedia article
(WIKI in details.js), and the lead text of the same article in each translation's language (i18n/<lang>.js),
into .cache/wiki/; the page itself never contacts Wikipedia.

    uv run --with pillow python prototypes/ancient-crossroads/build.py          # ancient-crossroads.html (Claude artifact)
    uv run --with pillow python prototypes/ancient-crossroads/build.py --site   # site/ancient/index.html (GitHub Pages)

Pillow (only needed here, hence --with) shrinks the Wikipedia images to small JPEGs.

The artifact loads D3 and fonts from CDNs. The site page uses site/vendor/ instead (scripts/vendor.sh),
like the rest of the site, so it also works where CDNs are blocked.
"""
import base64
import csv
import html
import json
import re
import shutil
import sys
import time
import urllib.parse
import ssl
import urllib.error
import urllib.request
from pathlib import Path

import certifi

# Bundled CA certificates: uv-managed Pythons don't see the macOS system store.
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())

HERE = Path(__file__).parent
CACHE = HERE / ".cache"
SOURCES = {
    "countries-50m.json": "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json",
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
    return {"countries": countries(), "rivers": rivers, "lakes": lakes}


def countries():
    """Today's countries (the page also merges them into the land). Ids become the Economy Atlas entity ids
    (config/entities.csv: the M49 code, or the `ne` column), and names come from the site (config/entities.csv,
    site/i18n/<lang>.json), so they follow its naming. Shapes without an entity (e.g. Somaliland) keep no id."""
    topo = fetch("countries-50m.json")
    with open(HERE.parent.parent / "config" / "entities.csv", newline="") as f:
        rows = [r for r in csv.DictReader(f) if not r["valid_to"]]
    code = {r["m49"]: r["id"] for r in rows if r["m49"]} | {r["ne"]: r["id"] for r in rows if r["ne"]}
    used = set()
    for g in topo["objects"]["countries"]["geometries"]:
        eid = code.get(g.get("id")) or code.get(g.get("properties", {}).get("name"))
        g.pop("properties", None)
        g.pop("id", None)
        if eid:
            g["id"] = eid
            used.add(eid)
    names = {"en": {r["id"]: r["name"] for r in rows if r["id"] in used}}
    for lang in langs():
        site = json.loads((HERE.parent.parent / "site" / "i18n" / f"{lang}.json").read_text())
        names[lang] = {k: v for k, v in site["names"]["entities"].items() if k in used}
    topo["names"] = names
    return topo


CDN_FONTS = """<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Marcellus&family=Alegreya+Sans:ital,wght@0,400;0,500;0,700;1,400&family=IBM+Plex+Mono:wght@400;500&display=swap">"""
CDN_SCRIPTS = """<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/topojson/3.0.2/topojson.min.js"></script>
<script>const GEO = /*GEO*/;</script>
<script>/*DATA*/
/*DETAILS*/
const I18N = {};
/*I18N*/
const WIKI_INFO = /*WIKI_INFO*/;</script>
<script>/*APP*/</script>"""
# The artifact host wraps the page in a document with a small reset; the site page brings its own.
SITE_HEAD = """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="An interactive map of civilisations from 3000 BC to AD 1900 and how they met: empires, trade routes from the Silk Roads to the Suez Canal, journeys, battles and the spread of ideas.">
<link rel="stylesheet" href="../vendor/fonts/ancient-crossroads.css">
<style>body { margin: 0; } [hidden] { display: none !important; }</style>
"""
SITE_SCRIPTS = """<script type="module">
import * as d3 from "../vendor/d3.js";
import * as topojson from "../vendor/topojson-client.js";
const GEO = /*GEO*/;
/*DATA*/
/*DETAILS*/
const I18N = {};
/*I18N*/
const WIKI_INFO = /*WIKI_INFO*/;
/*APP*/
</script>"""


WIKI_API = "https://en.wikipedia.org/w/api.php"
USER_AGENT = "AncientCrossroads/1.0 (https://github.com/idlecat/economy-atlas)"


def get(url, tries=6):
    """GET with backoff when Wikimedia asks to slow down (HTTP 429)."""
    for n in range(tries):
        req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT})
        try:
            with urllib.request.urlopen(req, context=SSL_CONTEXT, timeout=60) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code != 429 or n == tries - 1:
                raise
            time.sleep(5 * (n + 1))


def api(base=WIKI_API, **params):
    params.update(action="query", format="json", formatversion="2")
    return json.loads(get(base + "?" + urllib.parse.urlencode(params)))["query"]


def langs():
    """Translations: i18n/<lang>.js files."""
    return sorted(p.stem for p in (HERE / "i18n").glob("*.js"))


# Script variant to ask Wikipedia for, where the language has several (zh: Simplified Chinese).
WIKI_VARIANT = {"zh": "zh-cn"}


def fetch_wiki_lang(meta, lang):
    """The same article in another language (via interlanguage links) and its lead text, stored in meta[cid][lang]."""
    todo = [m for m in meta.values() if m.get(f"ll_{lang}_for") != m["title"]]
    for i in range(0, len(todo), 50):
        batch = {m["title"]: m for m in todo[i:i + 50]}
        try:
            q = api(titles="|".join(batch), prop="langlinks", lllang=lang, lllimit=500)
        except Exception as e:  # noqa: BLE001
            print(f"warning: Wikipedia language links ({lang}) failed ({e})")
            continue
        for p in q["pages"]:
            if p["title"] in batch:
                m = batch[p["title"]]
                m[f"ll_{lang}"] = (p.get("langlinks") or [{}])[0].get("title", "")
                m[f"ll_{lang}_for"] = m["title"]
    base = f"https://{lang}.wikipedia.org/w/api.php"
    todo = [m for m in meta.values() if m.get(f"ll_{lang}") and m.get(lang, {}).get("asked") != m[f"ll_{lang}"]]
    for i in range(0, len(todo), 20):
        batch = {m[f"ll_{lang}"]: m for m in todo[i:i + 20]}
        extra = {"variant": WIKI_VARIANT[lang]} if lang in WIKI_VARIANT else {}
        try:
            q = api(base, titles="|".join(batch), redirects=1, prop="extracts|info", inprop="url",
                    exintro=1, explaintext=1, exsentences=3, exlimit=20, **extra)
        except Exception as e:  # noqa: BLE001
            print(f"warning: {lang} Wikipedia request failed ({e})")
            continue
        alias = {n["from"]: n["to"] for kind in ("normalized", "redirects") for n in q.get(kind, [])}
        pages = {p["title"]: p for p in q["pages"]}
        for t, m in batch.items():
            name = t
            while name in alias:
                name = alias[name]
            p = pages.get(name)
            if p and not p.get("missing"):
                url = p["fullurl"].replace("/wiki/", f"/{WIKI_VARIANT[lang]}/") if lang in WIKI_VARIANT else p["fullurl"]
                m[lang] = {"asked": t, "title": p["title"], "url": url, "text": p.get("extract", "").strip()}


def wiki_titles():
    """English Wikipedia article titles: WIKI in details.js by civilisation id, ROUTE_WIKI and EVENT_WIKI as
    route-<id> and event-<id>, MOMENT_WIKI as moment-<civ>-<year>, and each city's wiki in cities.js as city-<id>."""
    src = (HERE / "details.js").read_text()
    def block(name):
        start = src.index(f"const {name} = {{")
        return src[start:src.index("};", start)]
    def pairs(name):  # key: 'Title' or key: "Title's"
        return [(k, t) for k, _, t in re.findall(r"""['"]?([\w-]+)['"]?: (['"])((?:(?!\2)[^\\]|\\.)+)\2""", block(name))]
    titles = dict(pairs("WIKI"))
    for kind in ("route", "event"):
        titles.update((f"{kind}-{k}", t) for k, t in pairs(f"{kind.upper()}_WIKI"))
    for civ, year, _, title in re.findall(r"""'([\w-]+) (-?\d+)': (['"])(.*?)\3""", block("MOMENT_WIKI")):
        titles[f"moment-{civ}-{year}"] = title
    for cid, _, title in re.findall(r"""\{ id: '([\w-]+)'.*?wiki: (['"])(.*?)\2""", (HERE / "cities.js").read_text()):
        titles[f"city-{cid}"] = title
    return titles


def plain(s):
    return html.unescape(re.sub(r"<[^>]+>", "", s or "")).strip()


def fetch_wiki():
    """Lead text, image and image credit for each article, cached in .cache/wiki/ (delete it to refresh).
    A title may name another image from the article instead of its lead image: 'Article#File:Name.jpg'."""
    cache = CACHE / "wiki"
    (cache / "img").mkdir(parents=True, exist_ok=True)
    meta_path = cache / "meta.json"
    meta = json.loads(meta_path.read_text()) if meta_path.exists() else {}
    titles = wiki_titles()
    todo = {cid: t for cid, t in titles.items() if meta.get(cid, {}).get("title_asked") != t}
    items = list(todo.items())
    for i in range(0, len(items), 20):  # extracts allow at most 20 pages per request
        batch = dict(items[i:i + 20])
        try:
            q = api(titles="|".join({t.split("#File:")[0] for t in batch.values()}), redirects=1, prop="extracts|pageimages|info", inprop="url",
                    exintro=1, explaintext=1, exsentences=3, exlimit=20, piprop="thumbnail|name", pithumbsize=400)
        except Exception as e:  # noqa: BLE001 - the page works without Wikipedia details
            print(f"warning: Wikipedia request failed ({e}); details for {len(batch)} entries skipped")
            continue
        alias = {}
        for kind in ("normalized", "redirects"):
            for n in q.get(kind, []):
                alias[n["from"]] = n["to"]
        pages = {p["title"]: p for p in q["pages"]}
        for cid, t in batch.items():
            name, _, file = t.partition("#File:")
            while name in alias:
                name = alias[name]
            p = pages.get(name)
            if not p or p.get("missing"):
                print(f"warning: no Wikipedia article '{t}' for {cid}")
                continue
            meta[cid] = {"title_asked": t, "title": p["title"], "url": p["fullurl"], "text": p.get("extract", "").strip(),
                         "thumb": p.get("thumbnail", {}).get("source"), "file": p.get("pageimage")}
            if file:  # the thumbnail URL comes with the credit below
                meta[cid].update(file=file.replace(" ", "_"), thumb=None)
    files = sorted({m["file"] for m in meta.values() if m.get("file") and "credit" not in m})
    for i in range(0, len(files), 50):
        try:
            q = api(titles="|".join("File:" + f for f in files[i:i + 50]), prop="imageinfo", iiprop="extmetadata|url",
                    iiextmetadatafilter="Artist|LicenseShortName|ObjectName", iiurlwidth=400)
        except Exception as e:  # noqa: BLE001
            print(f"warning: image credit request failed ({e})")
            continue
        alias = {n["from"]: n["to"] for n in q.get("normalized", [])}
        info = {}
        for p in q["pages"]:
            ii = (p.get("imageinfo") or [{}])[0]
            md = ii.get("extmetadata", {})
            info[p["title"]] = {"artist": plain(md.get("Artist", {}).get("value"))[:120],
                                "license": plain(md.get("LicenseShortName", {}).get("value")),
                                "page": ii.get("descriptionurl", ""), "alt": plain(md.get("ObjectName", {}).get("value")),
                                "thumb": ii.get("thumburl")}
        for m in meta.values():
            key = "File:" + (m.get("file") or "")
            key = alias.get(key, key)
            if key in info:
                m["credit"] = {k: v for k, v in info[key].items() if k != "thumb"}
                m["thumb"] = m.get("thumb") or info[key]["thumb"]
    for cid, m in meta.items():
        if not m.get("thumb") and m.get("file"):
            print(f"warning: image {m['file']} for {cid} not found")
        if m.get("thumb") and not m.get("img_file"):
            ext = m["thumb"].rsplit(".", 1)[-1].lower()
            path = cache / "img" / f"{cid}.{ext if ext in ('jpg', 'jpeg', 'png', 'gif', 'webp') else 'jpg'}"
            try:
                path.write_bytes(get(m["thumb"]))
                m["img_file"] = path.name
            except Exception as e:  # noqa: BLE001
                print(f"warning: image for {cid} not downloaded ({e})")
    for lang in langs():
        fetch_wiki_lang(meta, lang)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False, indent=1, sort_keys=True))
    return {cid: m for cid, m in meta.items() if cid in titles and m.get("title_asked") == titles[cid]}


# Article images that would mislead or say little: flags and coats of arms, maps and diagrams (the page is a map),
# modern reconstructions and photos, and photos of today's city (skylines, modern buildings) for cities.
SKIP_IMAGES = {"ottoman", "ethiopia", "inca", "britain", "spain", "portugal", "dutch", "habsburg", "sweden", "russia",
               "prussia", "germany", "italy", "safavid", "afsharid", "qajar", "oman", "morocco", "kongo", "oyo", "sokoto",
               "zulu", "merina", "congofree", "boer", "mahdist", "sikh", "durrani", "khiva", "kazakh", "dzungar", "qing",
               "toungoo", "konbaung", "siam", "mataram", "aceh", "usa", "mexico", "brazil", "iroquois", "comanche"} | {
    f"city-{c}" for c in (
        "alexandria", "anyang", "cairo", "calicut", "damascus", "guangzhou", "hangzhou", "kiev", "malacca", "palembang",
        "paris", "quanzhou", "tyre", "london", "lisbon", "naples", "moscow", "zanzibar", "edo", "osaka", "seoul",
        "hongkong", "manila", "potosi", "salvador", "buenosaires")} | {
    f"event-{e}" for e in (
        "ainjalut", "anlushan", "armada", "bantu", "barsauma", "blackdeath", "buddhism", "carrhae", "carthdestroy",
        "collapse", "greekcol", "hannibal", "japan", "kalinga", "norse", "numerals", "polynesia", "rebellion1857",
        "romeenvoy", "silkworm", "smallpox", "talas", "telegraph")} | {
    f"route-{r}" for r in (
        "amber", "carrera", "hansa", "inca", "incense", "levant", "meluhha", "monsoon", "phoenician", "royal", "sahara",
        "silk", "suez", "swahili", "teahorse")}


def tidy(text):
    """Drop pronunciations and native-script names, e.g. "( KAR-thij; Punic: ...)" or "()", and join paragraphs."""
    def keep(m):
        inner = m.group(1)
        noise = (not re.search(r"\w", inner) or ";" in inner or "lit." in inner or re.match(r"\s*[A-Z]{2,}", inner)
                 or re.search(r"[^\x00-\u024f\u2010-\u2027]", inner))
        return "" if noise else m.group(0)
    for _ in range(3):  # nested parentheses
        text = re.sub(r"\s*\(([^()]*)\)", keep, text)
    return re.sub(r"\s+([,.;])", r"\1", re.sub(r"\s+", " ", text)).strip()


def tidy_cjk(text):
    """Drop names in other scripts, e.g. "（英语：Sumer；阿卡德语：...）", and join paragraphs."""
    text = re.sub(r"[（(][^（）()]*?(?:语|語|文|音)[：:][^（）()]*[）)]", "", text)
    return re.sub(r" {2,}", " ", re.sub(r"\s*\n\s*", "", text)).strip()


def small_jpeg(src):
    """Thumbnail as a JPEG at most 400 px wide, flattened on white (first frame of an animation)."""
    import io

    from PIL import Image, PngImagePlugin

    PngImagePlugin.MAX_TEXT_CHUNK = 64 * 1024 * 1024  # some Wikimedia PNGs carry large metadata
    im = Image.open(src)
    im = im.convert("RGBA")
    im.thumbnail((400, 400))
    flat = Image.new("RGB", im.size, "white")
    flat.paste(im, mask=im.getchannel("A"))
    buf = io.BytesIO()
    flat.save(buf, "JPEG", quality=78, optimize=True, progressive=True)
    return buf.getvalue()


def wiki_info(site, out_dir):
    """The WIKI_INFO object for the page. Images go next to the site page, or inline as data URIs."""
    meta = fetch_wiki()
    if site:
        shutil.rmtree(out_dir / "img", ignore_errors=True)
        (out_dir / "img").mkdir(parents=True)
    result = {}
    for cid, m in sorted(meta.items()):
        moment = cid.startswith("moment-")  # only the picture and a link to the article
        entry = {"title": m["title"], "url": m["url"], **({} if moment else {"text": tidy(m["text"])})}
        for lang in langs():
            if m.get(lang):
                tr = m[lang]
                entry[lang] = {"title": tr["title"], "url": tr["url"]}
                if not moment:
                    entry[lang]["text"] = tidy_cjk(tr["text"]) if lang in ("zh", "ja") else tidy(tr["text"])
        credit = m.get("credit")
        # only images whose licence is known
        if m.get("img_file") and credit and credit.get("license") and cid not in SKIP_IMAGES:
            try:
                jpeg = small_jpeg(CACHE / "wiki" / "img" / m["img_file"])
            except Exception as e:  # noqa: BLE001
                print(f"warning: image for {cid} unreadable ({e})")
                result[cid] = entry
                continue
            if site:
                (out_dir / "img" / f"{cid}.jpg").write_bytes(jpeg)
                entry["img"] = f"img/{cid}.jpg"
            else:
                entry["img"] = "data:image/jpeg;base64," + base64.b64encode(jpeg).decode()
            entry["credit"] = {k: credit[k] for k in ("artist", "license", "page")}
            entry["alt"] = credit.get("alt") or ""
        result[cid] = entry
    print(f"Wikipedia details for {len(result)} civilisations, cities, routes, events and moments, {sum('img' in e for e in result.values())} with images")
    return result


def main():
    site = "--site" in sys.argv[1:]
    page = (HERE / "page.html").read_text()
    assert CDN_FONTS in page and CDN_SCRIPTS in page, "page.html head or scripts changed; update build.py"
    if site:
        page = page.replace(CDN_FONTS + "\n", "").replace(CDN_SCRIPTS, SITE_SCRIPTS)
        page = page.replace("<header>", "</head>\n<body>\n<header>", 1)
        page = SITE_HEAD + page + "</body>\n</html>\n"
    out = HERE.parent.parent / "site" / "ancient" / "index.html" if site else HERE / "ancient-crossroads.html"
    out.parent.mkdir(exist_ok=True)
    info = json.dumps(wiki_info(site, out.parent), ensure_ascii=False, separators=(",", ":")).replace("</", "<\\/")
    page = (page.replace("/*GEO*/", json.dumps(geography(), separators=(",", ":")))
            .replace("/*DATA*/", (HERE / "data.js").read_text() + (HERE / "cities.js").read_text())
            .replace("/*DETAILS*/", (HERE / "details.js").read_text())
            .replace("/*I18N*/", "\n".join((HERE / "i18n" / f"{lang}.js").read_text() for lang in langs()))
            .replace("/*WIKI_INFO*/", info)
            .replace("/*APP*/", (HERE / "app.js").read_text()))
    out.write_text(page)
    print(f"wrote {out} ({len(page) // 1024} KB)")


if __name__ == "__main__":
    main()

"""Natural Earth 1:50m admin-0 country shapes (TopoJSON from the world-atlas package)."""
from ..net import download, read_manifest, write_manifest
from ..paths import RAW

ID = "natural_earth"
KIND = "geometry"
URL = "https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-50m.json"
META = {
    "name": "Natural Earth 1:50m admin-0 countries, via the world-atlas package",
    "url": "https://www.naturalearthdata.com/",
    "terms": "Public domain",
}
FOLDER = RAW / ID
TOPOJSON = FOLDER / "countries-50m.json"


def fetch(refresh=False):
    fresh = refresh or not TOPOJSON.exists()
    download(TOPOJSON, URL, refresh)
    if fresh or not read_manifest(FOLDER):
        write_manifest(FOLDER, url=URL)

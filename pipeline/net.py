"""HTTP download helpers and per-source fetch manifests."""
import datetime as dt
import json
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

USER_AGENT = "eco-map-pipeline/1.0 (+https://github.com/)"


def log(*a):
    print(*a, file=sys.stderr, flush=True)


def http_get(url, accept=None, retries=4, timeout=120):
    """GET a URL. Returns b"" on 404 (e.g. an IMF reporter with no data)."""
    headers = {"User-Agent": USER_AGENT}
    if accept:
        headers["Accept"] = accept
    err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return b""
            err = e
        except Exception as e:  # timeouts, resets
            err = e
        time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {err}")


def download(path: Path, url, refresh=False, accept=None) -> bytes:
    """Download to `path` unless it is already cached."""
    if path.exists() and not refresh:
        return path.read_bytes()
    data = http_get(url, accept)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(data)
    return data


def write_manifest(folder: Path, **info):
    """Record when and from where a source was fetched; publish reads `accessed` for citations."""
    info.setdefault("accessed", dt.date.today().isoformat())
    (folder / "_manifest.json").write_text(json.dumps(info, indent=2))


def read_manifest(folder: Path) -> dict:
    p = folder / "_manifest.json"
    return json.loads(p.read_text()) if p.exists() else {}

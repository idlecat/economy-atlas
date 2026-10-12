"""HTTP download helpers and per-source fetch manifests."""
import datetime as dt
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

import certifi

USER_AGENT = "eco-map-pipeline/1.0 (+https://github.com/)"
# Bundled CA certificates: uv-managed Pythons don't see the macOS system store.
SSL_CONTEXT = ssl.create_default_context(cafile=certifi.where())


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
            req = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(req, timeout=timeout, context=SSL_CONTEXT) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return b""
            if 400 <= e.code < 500 and e.code not in (408, 429):
                raise RuntimeError(f"GET {url} failed: {e}") from e  # retrying won't help
            err = e
        except Exception as e:  # timeouts, resets
            err = e
        if attempt < retries - 1:
            time.sleep(2 * (attempt + 1))
    raise RuntimeError(f"GET {url} failed: {err}")


def download(path: Path, url, refresh=False, accept=None, validate=None) -> bytes:
    """Download to `path` unless it is already cached.

    `validate(data)` may raise to reject a response (e.g. an API error message returned with status
    200, or an empty body from a 404): nothing is cached then, so the next run retries. The file is
    written atomically, so an interrupted run never leaves a truncated file behind."""
    if path.exists() and not refresh:
        return path.read_bytes()
    data = http_get(url, accept)
    if validate:
        try:
            validate(data)
        except Exception as e:
            raise RuntimeError(f"GET {url}: unexpected response ({e}); not cached") from e
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_bytes(data)
    tmp.replace(path)
    return data


def json_check(shape):
    """A `validate` for JSON APIs: the body must parse and `shape(doc)` must be true."""
    def check(data):
        doc = json.loads(data)
        if not shape(doc):
            raise ValueError(f"unexpected JSON: {data[:200]!r}")
    return check


def download_large(path: Path, url, refresh=False, chunk_mb=16, workers=4, retries=8, chunk_deadline=300):
    """Download a big file as parallel HTTP range requests.

    Each chunk is written to <path>.parts/<n> and kept across runs, so an interrupted download
    resumes. A connection that stalls or trickles (chunk not done within `chunk_deadline`
    seconds) is dropped and the chunk retried on a fresh connection. The parts are joined and
    the size checked before the final file appears."""
    import concurrent.futures as cf
    import shutil

    if path.exists() and not refresh:
        return path
    head = urllib.request.Request(url, method="HEAD", headers={"User-Agent": USER_AGENT})
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(head, timeout=60, context=SSL_CONTEXT) as r:
                size = int(r.headers["Content-Length"])
                ranges_ok = r.headers.get("Accept-Ranges") == "bytes"
            break
        except (urllib.error.URLError, TimeoutError, ConnectionError) as e:
            if attempt == retries - 1 or (isinstance(e, urllib.error.HTTPError) and e.code < 500):
                raise RuntimeError(f"HEAD {url} failed: {e}") from e
            time.sleep(2 * (attempt + 1))
    if not ranges_ok:
        raise RuntimeError(f"{url} does not support range requests")
    parts_dir = path.with_name(path.name + ".parts")
    if refresh and parts_dir.exists():
        shutil.rmtree(parts_dir)
    parts_dir.mkdir(parents=True, exist_ok=True)
    step = chunk_mb * 1024 * 1024
    ranges = [(n, start, min(start + step, size) - 1) for n, start in enumerate(range(0, size, step))]

    def fetch(n, lo, hi):
        part = parts_dir / f"{n:05d}"
        if part.exists() and part.stat().st_size == hi - lo + 1:
            return
        err = None
        for attempt in range(retries):
            try:
                req = urllib.request.Request(url, headers={"User-Agent": USER_AGENT, "Range": f"bytes={lo}-{hi}"})
                t0, buf = time.monotonic(), bytearray()
                with urllib.request.urlopen(req, timeout=30, context=SSL_CONTEXT) as r:
                    while piece := r.read(1 << 20):
                        buf += piece
                        if time.monotonic() - t0 > chunk_deadline:
                            raise TimeoutError(f"slower than {chunk_mb} MB in {chunk_deadline}s")
                data = bytes(buf)
                if len(data) != hi - lo + 1:
                    raise RuntimeError(f"short read {len(data)}")
                tmp = part.with_suffix(".tmp")
                tmp.write_bytes(data)
                tmp.rename(part)
                return
            except Exception as e:
                err = e
                time.sleep(2 * (attempt + 1))
        raise RuntimeError(f"chunk {n} of {url} failed: {err}")

    log(f"  downloading {size / 1e9:.2f} GB in {len(ranges)} chunks…")
    with cf.ThreadPoolExecutor(workers) as pool:
        futs = [pool.submit(fetch, *r) for r in ranges]
        for i, f in enumerate(cf.as_completed(futs), 1):
            f.result()
            if i % 10 == 0 or i == len(ranges):
                log(f"  {i}/{len(ranges)} chunks")
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as out:
        for n, _, _ in ranges:
            with open(parts_dir / f"{n:05d}", "rb") as f:
                shutil.copyfileobj(f, out)
    if tmp.stat().st_size != size:
        raise RuntimeError(f"{path.name}: expected {size} bytes, got {tmp.stat().st_size}")
    tmp.rename(path)
    shutil.rmtree(parts_dir)
    return path


def write_manifest(folder: Path, **info):
    """Record when and from where a source was fetched; publish reads `accessed` for citations."""
    info.setdefault("accessed", dt.date.today().isoformat())
    (folder / "_manifest.json").write_text(json.dumps(info, indent=2))


def read_manifest(folder: Path) -> dict:
    p = folder / "_manifest.json"
    return json.loads(p.read_text()) if p.exists() else {}

"""Command line: python -m pipeline {fetch,normalize,publish,build} [--only SOURCE ...] [--refresh]

publish always writes every dataset in config/datasets.json, since they share meta.json."""
import argparse
import json

from .net import log
from .publish import publish
from .registry import Registry
from .sources import SOURCES
from .store import REPORT_DIR, connect, read_reference


def _selected(only):
    unknown = set(only or []) - set(SOURCES)
    if unknown:
        raise SystemExit(f"unknown source(s): {sorted(unknown)}; known: {sorted(SOURCES)}")
    return [m for sid, m in SOURCES.items() if not only or sid in only]


def fetch(only=None, refresh=False):
    for mod in _selected(only):
        log(f"fetch {mod.ID}")
        mod.fetch(refresh=refresh)


def normalize(only=None):
    con = connect()
    mods = _selected(only)
    # Reference sources first: the registry needs M49 regions to resolve groups.
    for mod in [m for m in mods if m.KIND == "reference"]:
        log(f"normalize {mod.ID}: {mod.normalize(con)}")
    registry = Registry.load(read_reference(con, "un_m49"))
    REPORT_DIR.mkdir(parents=True, exist_ok=True)
    for mod in [m for m in mods if m.KIND in ("observations", "indicators")]:
        report = mod.normalize(con, registry)
        (REPORT_DIR / f"{mod.ID}.json").write_text(json.dumps(report, indent=2))
        log(f"normalize {mod.ID}: {report['rows']} rows")
        if report.get("unmapped_partner_codes"):
            log(f"  WARNING unmapped codes (add them to config/entities.csv): {report['unmapped_partner_codes']}")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="python -m pipeline")
    ap.add_argument("command", choices=["fetch", "normalize", "publish", "build"])
    ap.add_argument("--only", nargs="+", metavar="SOURCE", help=f"limit fetch/normalize to these sources: {', '.join(SOURCES)}")
    ap.add_argument("--refresh", action="store_true", help="re-download even if cached")
    args = ap.parse_args(argv)

    if args.command in ("fetch", "build"):
        fetch(args.only, args.refresh)
    if args.command in ("normalize", "build"):
        normalize(args.only)
    if args.command in ("publish", "build"):
        publish()

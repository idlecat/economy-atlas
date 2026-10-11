from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CONFIG = ROOT / "config"
RAW = ROOT / "data_raw"            # untouched downloads, one folder per source
STORE = ROOT / "data_store"        # canonical observations (Parquet), one file per source
SITE_DATA = ROOT / "site" / "data"  # published files read by the website

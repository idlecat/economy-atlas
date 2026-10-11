"""Data sources.

Each source module defines:
    ID        short id, also the folder name under data_raw/
    KIND      "observations" (writes data_store/observations/<ID>.parquet),
              "reference" (writes data_store/reference/<ID>.parquet) or "geometry"
    META      citation info shown on the website
    fetch(refresh)                 download into data_raw/<ID>/ and write a manifest
    normalize(con, registry) -> {} (not for geometry) convert raw files; returns a report dict

To add a source: add a module here, register it in SOURCES, add a code column for
its scheme to config/entities.csv if it uses its own country codes, and list it in
config/datasets.json `precedence`.
"""
from . import cepii_baci, imf_imts, natural_earth, un_m49

SOURCES = {m.ID: m for m in (un_m49, natural_earth, imf_imts, cepii_baci)}

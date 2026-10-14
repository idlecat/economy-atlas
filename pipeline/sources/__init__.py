"""Data sources.

Each source module defines:
    ID        short id, also the folder name under data_raw/
    KIND      "observations" (writes data_store/observations/<ID>.parquet),
              "indicators" (country-level series, data_store/indicators/<ID>.parquet),
              "bilateral" (country x counterpart series, data_store/bilateral/<ID>.parquet;
              measures in config/bilateral.json),
              "reference" (writes data_store/reference/<ID>.parquet) or "geometry"
    META      citation info shown on the website
    fetch(refresh)                 download into data_raw/<ID>/ and write a manifest
    normalize(con, registry) -> {} (not for geometry) convert raw files; returns a report dict

To add a source: add a module here, register it in SOURCES, add a code column for
its scheme to config/entities.csv if it uses its own country codes, and list it in
config/datasets.json `precedence`.
"""
from . import cepii_baci, imf_dip, imf_imts, natural_earth, un_m49, undp_hdr, worldbank_ids, worldbank_wdi

SOURCES = {m.ID: m for m in (un_m49, natural_earth, imf_imts, cepii_baci, worldbank_wdi, undp_hdr, worldbank_ids, imf_dip)}

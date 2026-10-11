# Trade Atlas

An interactive world map of bilateral goods trade, built as a static website.

- **Choropleth + flow arcs.** Shows total trade, exports, imports or trade balance for each country, or for each partner of a selected focus.
- **Time.** A year slider and a play button cover 1990 to the latest year. The Δ 1/5/10-year modes color partners by growth instead of size.
- **Focus.** Click a country or bloc to see its partners, its trend over time, and its top-partner ranking. Click a partner to compare the pair over time.
- **Groupings.** Each bloc can be treated as one entity or split into its countries: EU-27, ASEAN, GCC, Africa, South America, Central America & Caribbean, and Central Asia. When a bloc is merged, trade between its members is excluded.
- **Shareable state.** The URL hash keeps the current view, e.g. `#focus=CHN&year=2025&metric=exports&groups=EU,ASEAN`.
- **Attribution.** Sources are shown in the footer and in the "About the data" dialog.

## Data sources

| What | Source |
|---|---|
| Bilateral exports (FOB) and imports (CIF) of goods, annual, USD | IMF, [International Trade in Goods (by partner country), IMTS](https://data.imf.org/en/datasets/IMF.STA:IMTS), formerly DOTS, via the IMF SDMX API |
| Regions used to define groups | UN Statistics Division, [M49 standard](https://unstats.un.org/unsd/methodology/m49/overview/) |
| Country shapes | [Natural Earth](https://www.naturalearthdata.com/) 1:50m via `world-atlas@2.0.2` |

Figures are as reported by the focus country. Taiwan isn't published as a reporter in IMTS, so its figures are rebuilt from what its partners report ("mirror" data). Exports from mirror data run high because of re-exports. See the About dialog in the app for the full methodology.

## Project layout

```
config/groups.json      group definitions (explicit ISO3 lists or UN M49 region codes)
scripts/build_data.py   downloads sources and writes site/data/ (stdlib-only Python)
site/                   the static website: deploy this folder
  index.html, css/, js/ (ES modules; D3 and topojson-client from jsDelivr, pinned)
  data/meta.json        years, entities, groups, source citations
  data/totals.json      each entity's trade with the world
  data/flows/XXX.json   one file per country/group: partner series, loaded on demand
  data/world.json       TopoJSON shapes keyed by IMF country code
data_raw/               download cache (not deployed, git-ignored)
```

## Run locally

```sh
python3 scripts/build_data.py         # ~5 min the first time; cached afterwards
python3 -m http.server -d site 8000   # then open http://localhost:8000
```

The page must be served over HTTP; opening `index.html` as a file won't work.

To refresh the data, run `python3 scripts/build_data.py --refresh`. To change the year range, use `--start 1980`. To edit groupings, change `config/groups.json` and rebuild. Groups must not overlap.

## Deploy

`site/` is plain static files, so any static host works (GitHub Pages, Netlify, Cloudflare Pages, S3). `.github/workflows/deploy.yml` rebuilds the data monthly and publishes `site/` to GitHub Pages. To enable it, set Settings → Pages → Source to "GitHub Actions".

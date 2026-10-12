# Economy Atlas

An interactive world map of trade, growth and how economies connect, built as a static website.

- **Choropleth + flow arcs.** Shows total trade, exports, imports or trade balance for each country, or for each partner of a selected focus.
- **Time.** Annual data from 1990 and monthly data from 2000, with a time slider and a play button. The Δ 1/5/10-year modes color partners by growth instead of size; on monthly data, Δ 1 yr compares each month with the same month a year earlier.
- **Products.** Pick a sector (energy, ores, machinery, …) or a commodity (crude oil, gas, coal, iron ore, soybeans, chips, …) to see who trades it with whom, 1995–2024. A country's panel shows what it trades, by product.
- **Economy & correlations.** GDP, GDP per capita, real growth, population, inflation, unemployment, FDI and the current account (World Bank). "Compare" plots any two metrics (economic or trade, e.g. exports vs. GDP) across countries for a year, with Pearson and Spearman correlations and a fit line, animated over time. Country panels show the economy and whether exports move with GDP. The world map can also be colored by an indicator.
- **Stories.** Guided replays of past events: the Asian financial crisis (1997–98), the 2008–09 trade collapse, the euro area debt crisis, the 2014–16 oil price collapse, the US–China trade war, COVID-19, Russian oil turning east, Europe's 2022 energy crisis, the 2025 US tariffs, the Belt and Road Initiative, and China's rise as an exporter step through saved views with captions and replay the timeline. Stories are JSON files in `site/stories/` (format in its README).
- **Highlighted lists.** Outline a list of countries that may overlap with groups, e.g. the 156 Belt and Road partners on China's official list, and compare trade, debt and investment with members and non-members (`config/lists.json`).
- **Lending & investment.** Public external debt owed to China, Japan, the US, Germany and France, and direct investment from China, Hong Kong, the US and Japan: on the map, in Compare, and in each country's panel (who it owes, who invests in it; for lenders, who owes them and where they invest).
- **Trends.** Line charts over time: a country's exports, imports and balance, its top partners' trade with it, and any set of economies side by side, in US$, on a log scale, or as shares.
- **Focus.** Click a country or bloc to see its partners, its trend over time, and its top-partner ranking. Click a partner to compare the pair over time.
- **Groupings.** Each bloc can be treated as one entity or split into its countries: EU, China (the mainland with Hong Kong and Macao; Taiwan, China is shown separately), ASEAN, GCC, Africa, South America, Central America & Caribbean, and Central Asia. When a bloc is merged, trade between its members is excluded, and membership follows each year (the UK is in the EU through 2020).
- **Shareable state.** The URL hash keeps the current view, e.g. `#focus=CHN&year=2025&metric=exports&groups=EU,ASEAN`.
- **Languages.** English and Simplified Chinese (button in the header, or `?lang=zh`), including the stories and the methodology. Strings are in `site/i18n/`; Chinese country names follow Unicode CLDR and region names UN M49.
- **Attribution.** Sources are shown in the footer and in the "About the data" dialog.

## Data sources

| What | Source |
|---|---|
| Bilateral exports (FOB) and imports (CIF) of goods, annual and monthly, USD | IMF, [International Trade in Goods (by partner country), IMTS](https://data.imf.org/en/datasets/IMF.STA:IMTS), formerly DOTS, via the IMF SDMX API |
| Bilateral trade by product (HS 1992), annual 1995–2024 | CEPII, [BACI](https://www.cepii.fr/CEPII/en/bdd_modele/bdd_modele_item.asp?id=37) version 202601, Etalab Open Licence 2.0 |
| GDP, population, inflation, unemployment, FDI, current account (annual, 1990–) | World Bank, [World Development Indicators](https://databank.worldbank.org/source/world-development-indicators), CC BY 4.0 |
| Public external debt by creditor country (low- and middle-income countries, annual) | World Bank, [International Debt Statistics](https://www.worldbank.org/en/programs/debt-statistics/ids), CC BY 4.0 |
| Direct investment positions by investing economy (annual, 2009–) | IMF, [Direct Investment Positions by Counterpart Economy](https://data.imf.org/en/datasets/IMF.STA:DIP) (formerly CDIS) |
| Regions used to define groups | UN Statistics Division, [M49 standard](https://unstats.un.org/unsd/methodology/m49/overview/) |
| Country shapes | [Natural Earth](https://www.naturalearthdata.com/) 1:50m via `world-atlas@2.0.2` |

Figures are as reported by the focus country. Taiwan isn't published as a reporter in IMTS, so its figures are rebuilt from what its partners report ("mirror" data). Exports from mirror data run high because of re-exports. Bloc membership is applied as of each year: for example, the UK is part of the EU through 2020. See the About dialog in the app for the full methodology.

## How the data pipeline works

```
fetch       data_raw/<source>/           untouched downloads + _manifest.json (access date)
normalize   data_store/observations/     one Parquet file per source, in a shared schema
            data_store/reference/        reference tables (UN M49 regions)
publish     site/data/                   JSON for the website; data_store/reports/ has build reports
```

- **Entities** (`config/entities.csv`) are the list of countries, keyed by ISO3, including retired codes such as `SUN` for the USSR. The file has one column per source's code scheme (`imf`, `ne`, …) and start/end years for historical states.
- **Groups** (`config/groups.json`) list members with optional `from`/`to` years, or use UN M49 region codes. In any year, a country can belong to at most one group.
- **Datasets** (`config/datasets.json`) set the source precedence: when two sources report the same value, the first source in the list wins. `goods_trade` (all goods, IMF) and `goods_by_product` (CEPII BACI) are published side by side.
- **Bilateral measures** (`config/bilateral.json`) are country × counterpart series (debt by creditor, direct investment by investor) in `data_store/bilateral/`, published to `site/data/bilateral.json`.
- **Indicators** (`config/indicators.json`) are country-level series (World Bank WDI codes), stored separately from bilateral flows in `data_store/indicators/`. Derived indicators (GDP per capita, real growth) and group totals are computed at publish time into `site/data/indicators.json`.
- **Products** (`config/products.json`) are sectors (which together cover all goods) and commodities, each a list of HS 1992 code prefixes. BACI's ~5,000 HS6 codes are summed into these during `normalize`, so after editing the file run `python -m pipeline normalize --only cepii_baci` and `publish`.

To add a source:
1. Add a module in `pipeline/sources/` (see its `__init__.py`).
2. Add a code column to `entities.csv` if the source uses its own country codes.
3. List the source in `datasets.json`.

## Project layout

```
config/                 entities, groups, dataset precedence
pipeline/               Python package: sources/, registry, store, publish, cli
tests/                  pytest tests for registry rules and publish transformations
site/                   the static website: deploy this folder
  index.html, css/, js/ (ES modules; D3 and topojson-client from jsDelivr, pinned)
  data/                 generated by the pipeline (meta, totals, flows/<id>.json, world.json)
data_raw/, data_store/  local caches (git-ignored)
```

## Run locally

Requires [uv](https://docs.astral.sh/uv/).

```sh
uv run python -m pipeline build            # fetch (cached) + normalize + publish; ~5 min on first run
uv run pytest                              # pipeline tests
python3 -m http.server -d site 8000        # then open http://localhost:8000
```

Other commands:
- `python -m pipeline fetch|normalize|publish` runs one stage.
- `--only imf_imts` limits fetch or normalize to one source.
- `--refresh` re-downloads instead of using the cache.

The page must be served over HTTP; opening `index.html` as a file won't work.

`site/data/` is generated and not committed (a few hundred MB with monthly and product data). The first `build` downloads about 1.5 GB from the IMF and the 2.4 GB BACI release into `data_raw/`, which can take 30+ minutes depending on CEPII's server; later builds reuse that cache. Large files are downloaded in resumable chunks, so an interrupted run picks up where it stopped.

## Deploy

`site/` is plain static files, so any static host works (GitHub Pages, Netlify, Cloudflare Pages, S3). `.github/workflows/deploy.yml` runs the tests, builds the data (raw downloads are cached between runs and fully refreshed by the monthly schedule), and publishes `site/` to GitHub Pages. To enable it, set Settings → Pages → Source to "GitHub Actions".

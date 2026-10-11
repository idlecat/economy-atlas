# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Trade Atlas: a public, static website showing bilateral goods trade between countries on an interactive world map over time. It has two halves:

- `pipeline/`: a Python data pipeline (uv + DuckDB) that turns source data into JSON in `site/data/`.
- `site/`: a no-build frontend made of plain ES modules. D3 and topojson-client are imported from jsDelivr at pinned versions.

Planned direction: more sources and product breakdowns (e.g. HS chapters). The pipeline schema already has a `product` column. Annual and monthly data are published, and stories (guided replays) live in `site/stories/`.

## Commands

```sh
uv run python -m pipeline build                    # fetch (cached) + normalize + publish
uv run python -m pipeline publish                  # rebuild site/data from data_store only (seconds)
uv run python -m pipeline fetch --only imf_imts --refresh
uv run pytest                                      # all tests
uv run pytest tests/test_pipeline.py::test_group_uses_membership_as_of_each_year
python3 -m http.server -d site 8000                # serve the site; must be HTTP, not file://
```

Run `publish` after any change to `config/` or `pipeline/publish.py`. Run `normalize` too if entity code mappings changed.

The first monthly fetch is about 250 IMF requests of 1–10 MB each. HTTPS uses `certifi`, because uv-managed Pythons don't see the macOS system certificate store. Failed requests are reported and make `fetch` exit non-zero; rerunning retries only the missing files.

There is no frontend test suite. Verify UI changes in a browser. There is also no JS linter.

Deploy: `.github/workflows/deploy.yml` runs the tests and `build` (on push to `main`, monthly, or manually), then publishes `site/` to GitHub Pages. `data_raw/` is kept in the Actions cache; the monthly schedule and manual runs with `refresh` re-download everything. `site/data/` is generated and git-ignored.

## Pipeline architecture

There are three stages, and each reads only the previous stage's output:

1. **fetch** → `data_raw/<source>/`: raw downloads, plus a `_manifest.json` whose `accessed` date feeds the citations on the site.
2. **normalize** → `data_store/observations/<source>.parquet`, in the canonical long schema defined in `pipeline/store.py` `OBS_COLUMNS`:
   - Columns: source, dataset, reporter, partner, flow X/M, product, freq, period, value, unit, valuation, flag.
   - Reference tables go to `data_store/reference/`.
3. **publish** (`pipeline/publish.py`): runs SQL steps over the `obs` view.
   - `select_observations`: applies source precedence from `config/datasets.json`.
   - `derive_mirrors`: rebuilds flows from partner reports, swapping exports and imports, for entities with `derive=mirror` that report nothing (currently Taiwan).
   - `build_pairs`, then `build_groups`.
   - `covered_periods`: drops trailing periods that fewer than `min_coverage` of reporters have published, so incomplete recent months don't look like a collapse.
   - This runs once per frequency in `datasets.json` `freqs` (A, M), writing `site/data/<freq>/`. Then it writes `meta.json`, `world.json` and `data_store/reports/publish.json`.

Each step only needs a connection with an `obs` table, so the tests build synthetic `obs` tables directly.

Identity and grouping:
- **Entity ids** are ISO3, plus retired codes for historical states (SUN, YUG, CSK, SCG, ANT) and XKX for Kosovo. World is `WLD`.
- **Code mapping:** `config/entities.csv` is the authority. Every column that isn't a fixed column is a source code scheme: `imf` (e.g. KOS→XKX, WBG→PSE) and `ne` (Natural Earth shapes that can't be matched by M49 numeric code). `Registry.code_map(scheme)` builds the crosswalk.
- **Unmapped codes:** an unmapped IMF partner code is dropped and listed in `data_store/reports/imf_imts.json` as `unmapped_partner_codes`. IMF aggregates (`G…`, `GX…`, `TX…`) are dropped as expected.
- **Groups** (`config/groups.json`): members can be given as `{"id", "from", "to"}` with inclusive years. M49-rule members apply to all years.
  - `resolve_groups` raises an error if any entity is in two groups in overlapping years.
  - Group aggregates use membership **per year**, for both the member reporting and the partner. A group's totals are extra-group trade only; trade between members is published separately as `intra`.

Adding a source:
1. Add a module in `pipeline/sources/` with `ID`, `KIND`, `META`, `fetch` and `normalize`. The contract is described in `sources/__init__.py`.
2. Register it in `SOURCES`.
3. Add a code column to `entities.csv` if needed.
4. Add it to `datasets.json` `precedence`.

The site's About text reads sources by id (`imf_imts`, `un_m49`, `natural_earth`) in `main.js` `renderSources`, so update that function when sources change.

## Site data contract (`site/data/`)

- **Values:** USD millions, rounded to 4 significant figures (`sig()`).
- **Periods:** strings `2008` (A), `2008-Q4` (Q), `2008-09` (M). `meta.periods[freq]` lists each frequency's periods.
- **Series:** every series is `[exports[], imports[]]` aligned to `meta.periods[freq]`. `null` means not reported, which is different from `0`. Group membership is by the period's year.
- **`meta.json`:**
  - `entities[id]` = `{name, region, subregion, reporter, mirror?, groups?: [{g, from?, to?}]}`
  - `groups[]` = `{id, name, short, note, members: [{id, from?, to?}]}`
  - `sources[]`, which carry `accessed` and `citation`.
- **Other files:**
  - `<freq>/totals.json`: trade with the World per entity; for groups, extra-group trade.
  - `<freq>/flows/<id>.json`: `{p: {partner: series}, intra?}`, loaded on demand.
  - `world.json`: TopoJSON with geometry ids set to entity ids.
- Output keys are sorted, so a data refresh produces a minimal diff.

## Frontend architecture (`site/js/`)

- **`data.js`:** the `store`, plus membership-aware aggregation.
  - `setFreq(freq)` switches `store.periods` and `store.totals`, loading `data/<freq>/totals.json` lazily. Flows are cached per frequency.
  - `groupOf(code, pi)` and `displayOf(code, groupsOn, pi)` give the key a country is drawn as at a given period index: itself, or its merged group. Everything in the UI is keyed by this display key.
  - `partnerSeries` and `displayTotals` fold or mask series **per period**, because membership changes over time.
- **`time.js`:** period parsing and labels. `nearestIndex` maps a period across frequencies (e.g. `2008` → `2008-12`). `yearTicks` gives axis ticks.
  - `metricAt` and `changeAt` derive total, exports, imports and balance. Change is a ratio for flows and a USD difference for balance.
- **`main.js`:** owns `state` (`freq`, `pi` = period index, `focus`, `metric`, `back` = change-mode **years**, `groupsOn`, `pair`).
  - `backN()` converts change-mode years to periods (×12 for monthly), so "Δ 1 yr" is year-on-year for the same month.
  - `update()` loads flows (with an `updateToken` race guard), builds a color scale whose domain covers **all periods** (cached by `scaleKey`), renders everything, and writes the URL hash with `replaceState`.
  - Views: `applyView(view)` sets the whole state from an object with the URL-hash keys (`freq`, `t`, `focus`, `metric`, `change`, `groups`, `with`). It is used by `readHash` and by stories. `playTo(index, ms)` animates the timeline and resolves when done or stopped.
  - A `hashchange` listener re-reads the hash for pasted links and back/forward. Old `year=` links still work.
- **`stories.js`:** the story player.
  - Loads `stories/index.json` and `stories/<id>.json`. Each step calls `applyView`, then optionally `playTo`. Step changes bump a `token`, so a replay that is still running can't overwrite a later step.
  - While a story is active, the URL is `#story=<id>&step=<n>`. The format is in `site/stories/README.md`. Numbers quoted in stories must come from site data, and other facts must be cited in the story's `sources`.
  - It also owns the tooltip, the controls and the About dialog.
- **`map.js`:** `render({focus, pi, groupsOn, colorOf, arcs})`.
  - Group outlines come from `topojson.mesh` and are recomputed when merged groups or that year's membership change.
  - Arc endpoints use the centroids of the largest polygons. Group centroids use all-time members, so arcs don't jump between years.
- **`panel.js`:** the side panel and `lineChart`, which is reused in tooltips.

Theming uses CSS variables with a `prefers-color-scheme` dark mode, and the JS palettes in `palettes()` follow it. On screens ≤980px, `.layout` uses `display: contents` so blocks can be reordered with `order`.

## Constraints

- This is a public site, so attribution matters. Keep `META` in source modules, the footer and the About dialog accurate.
- When aggregation logic changes, update the methodology text in `renderSources` (`main.js`). Current caveats:
  - Figures are as reported by the focus country.
  - Exports are valued FOB and imports CIF.
  - Mirror data for Taiwan.
  - Group membership is applied as of each year.
  - Monthly data is not seasonally adjusted.

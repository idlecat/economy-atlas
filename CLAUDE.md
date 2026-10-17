# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

Economy Atlas: a public, static website showing bilateral goods trade and economic indicators for countries and blocs on an interactive world map over time. It has two halves:

- `pipeline/`: a Python data pipeline (uv + DuckDB) that turns source data into JSON in `site/data/`.
- `site/`: a no-build frontend made of plain ES modules. D3, topojson-client and the Inter font are served from `site/vendor/` (no CDN, so the site also works where jsDelivr/Google Fonts are blocked, e.g. mainland China); `scripts/vendor.sh` regenerates them at pinned versions.

Data: all-goods trade from the IMF (annual + monthly), debt by creditor (World Bank IDS) and direct investment by investor (IMF DIP), trade by product from CEPII BACI (annual, sectors and commodities from `config/products.json`), country-level economic and development indicators from the World Bank WDI and the UNDP Human Development Index (`config/indicators.json`), and stories (guided replays) in `site/stories/`.

## Commands

```sh
uv run python -m pipeline build                    # fetch (cached) + normalize + publish
uv run python -m pipeline publish                  # rebuild site/data from data_store only (seconds)
uv run python -m pipeline fetch --only imf_imts --refresh
uv run pytest                                      # all tests
uv run python -m pipeline check-stories            # story figures still match site/data
cd tests/e2e && npm ci && npm test                 # browser smoke test (needs the server below; CHANNEL=chrome to use local Chrome)
uv run pytest tests/test_pipeline.py::test_group_uses_membership_as_of_each_year
python3 -m http.server -d site 8000                # serve the site; must be HTTP, not file://
```

Run `publish` after any change to `config/` or `pipeline/publish.py`. Run `normalize` too if entity code mappings changed.

`net.download_large` fetches big files (BACI, 2.4 GB) as resumable parallel range requests with a per-chunk deadline; CEPII's server is often slow, so expect 30+ minutes. BACI releases are immutable: `--refresh` does not re-download them; bump `VERSION` in `sources/cepii_baci.py` for a new release.

The first monthly fetch is about 250 IMF requests of 1–10 MB each. HTTPS uses `certifi`, because uv-managed Pythons don't see the macOS system certificate store. Failed requests are reported and make `fetch` exit non-zero; rerunning retries only the missing files.

Frontend: `tests/e2e/smoke.mjs` (Playwright) loads every view and every story step in every language and fails on page errors, failed or external requests and missing content; it runs in CI after the build. Still check UI changes visually in a browser. There is no JS linter.

Deploy: `.github/workflows/deploy.yml` runs the tests, `build`, `check-stories` and the browser smoke test (on push to `main`, monthly, or manually), then publishes `site/` to GitHub Pages. `data_raw/` is kept in the Actions cache; the monthly schedule and manual runs with `refresh` re-download everything. `site/data/` is generated and git-ignored.

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
   - `goods_trade` runs once per frequency in `datasets.json` `freqs` (A, M), writing `site/data/<freq>/`. `goods_by_product` runs per product and frequency, writing `site/data/products/<product>/<freq>/`, plus `site/data/products/breakdown/<id>.json` (each entity's world trade by product). A dataset with no observations is skipped with a warning.
   - Then it writes `meta.json` (including `products`: periods, sectors, commodities with their HS codes), `world.json` and `data_store/reports/publish.json`. `publish` always writes every dataset because they share `meta.json`.

Indicators (`pipeline/indicators.py`): sources of `KIND = "indicators"` write `data_store/indicators/<source>.parquet` (schema `IND_COLUMNS`: entity-level, no partner). `publish_indicators` derives `gdp_pc` and `gdp_growth`, and builds group values with dated membership: `sum` indicators only when members with data hold ≥95% of the group population (`group_sum`); group growth uses a constant member set across the two years (`growth`). USD indicators are published in USD millions like trade. Output: `site/data/indicators.json` `{periods, indicators, values: {id: {entity: [...]}}}`. World Bank and UNDP codes are ISO3 = entity ids; their World aggregates are kept as `WLD` (shown in the panel's world view and quoted by stories), other aggregates are dropped. No Taiwan. Sources: `worldbank_wdi` (one API request per indicator) and `undp_hdr` (one CSV of composite indices; `source_code` is the column prefix, e.g. `hdi`; bump `URL` for a new report). Units: usd, usd_pc, people, pct, years, per1000, mt (million tonnes), t_pc, index (`format.js` `fmtUnit`); `scale: "sequential"` colors the map on one ramp over the 2nd–98th percentiles instead of diverging around zero.

Bilateral measures (`pipeline/bilateral.py`, `config/bilateral.json`): sources of `KIND = "bilateral"` (`worldbank_ids`: public external debt `DT.DOD.DPPG.CD` by creditor country, one API request per creditor; `imf_dip`: direct investment positions, inward as reported by hosts and outward as reported by investors) write `data_store/bilateral/<source>.parquet` (schema `BIL_COLUMNS`: entity, counterpart, `basis` host/investor). Counterpart `WLD` is the total, used for shares. With `precedence`, each (entity, counterpart) series takes the first basis that has any data (never mixed within a series); later-basis series are listed in `bilateral.json` `basis`. Group sums: members that report anything that year must hold ≥85% of population (`COVERAGE`, lower than indicators because IDS excludes high-income countries); missing counterparts count as 0; no value when the counterpart is a member; investment group sums use host reports only. Output `site/data/bilateral.json` `{periods, measures, basis, values: {measure: {counterpart: {entity: [...]}}}}`. On the site, `metrics.js` `addBilateral` turns each measure × counterpart into metrics `<m>_<cp>` and `<m>_share_<cp>` (group `lending`; no share when the basis is the investor's), and `panel.js` `lendingSection` lists, for a counterpart, who owes it / where it invested, and for any country a lenders-and-investors table.

BACI specifics (`sources/cepii_baci.py`): values are reconciled exporter→importer flows (FOB, thousand USD in the source). Each flow becomes two observations (X for the exporter, M for the importer), plus WLD rows summed per reporter. HS6 codes are mapped to products at normalize time (`classify`, longest prefix wins; `validate_taxonomy` rejects overlapping sectors or commodities). Country codes map through the `baci` column of `entities.csv` (BACI numeric codes; Taiwan is 490 "Other Asia, nes"). BACI code 711 (Southern African Customs Union, reported as one unit until 1999) is deliberately unmapped, so South Africa and its SACU neighbours have no product data for 1995–99.

Each step only needs a connection with an `obs` table, so the tests build synthetic `obs` tables directly.

Identity and grouping:
- **Entity ids** are ISO3, plus retired codes for historical states (SUN, YUG, CSK, SCG, ANT) and XKX for Kosovo. World is `WLD`.
- **Territories:** `entities.csv` `part_of` names the country a territory belongs to (HKG, MAC, TWN → CHN). It is published in `meta.entities[id].part_of`; the panel says so (`panel.partOf.<id>` / `panel.partOfMerge.<id>` strings), and territories outside UN M49 (Taiwan) take that country's region. Names follow the IMF/World Bank style: "China (mainland)", "Hong Kong SAR, China", "Taiwan, China". The `CHINA` group combines the mainland with Hong Kong (from 1997) and Macao (from 1999); Taiwan stays separate because its data is mirror-derived.
- **Code mapping:** `config/entities.csv` is the authority. Every column that isn't a fixed column is a source code scheme: `imf` (e.g. KOS→XKX, WBG→PSE) and `ne` (Natural Earth shapes that can't be matched by M49 numeric code). `Registry.code_map(scheme)` builds the crosswalk.
- **Unmapped codes:** an unmapped IMF partner code is dropped and listed in `data_store/reports/imf_imts.json` as `unmapped_partner_codes`. IMF aggregates (`G…`, `GX…`, `TX…`) are dropped as expected.
- **Groups** (`config/groups.json`): members can be given as `{"id", "from", "to"}` with inclusive years. M49-rule members apply to all years.
  - `resolve_groups` raises an error if any entity is in two groups in overlapping years.
  - Group aggregates use membership **per year**, for both the member reporting and the partner. A group's totals are extra-group trade only; trade between members is published separately as `intra`.

Lists (`config/lists.json`, validated by `registry.load_lists`, published as `meta.lists`): overlapping country sets that are never merged, e.g. `BRI` (156 Belt and Road partners from the official portal, accessed date in `source`). Members are a fixed set applied to every year (so before/after comparisons use the same countries); `withdrawn` records members that left, with sources, without removing them; `since` is the start year used for "before" comparisons; `counterpart` is the country the list is about. Site: the **Highlight** select (`state.list`, URL `list=`) outlines members on the map (`map.js` `drawList`) and in Compare (`.dot.listed`), adds a members-vs-others chart in Trends (`data.js` `splitByList` over the focus's unmerged flows) and a panel section (`listSection`: counterpart's share of the focus's trade now vs `since - 1`, or for the counterpart itself the members' share of its trade, debt and investment).

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
  - `setSlice(product, freq)` switches `store.product`, `store.periods` and `store.totals`, loading the slice's `totals.json` lazily (`product` "TOTAL" = all goods from `data/<freq>/`). Flows are cached per product and frequency. Product slices are annual only, so the Monthly button is disabled while a product is selected.
  - `loadBreakdown(code)` loads an entity's trade by product for the panel's "What X trades" list.
  - `groupOf(code, pi)` and `displayOf(code, groupsOn, pi)` give the key a country is drawn as at a given period index: itself, or its merged group. Everything in the UI is keyed by this display key.
  - `partnerSeries` and `displayTotals` fold or mask series **per period**, because membership changes over time.
- **`time.js`:** period parsing and labels. `nearestIndex` maps a period across frequencies (e.g. `2008` → `2008-12`). `yearTicks` gives axis ticks.
  - `metricAt` and `changeAt` derive total, exports, imports and balance. Change is a ratio for flows and a USD difference for balance.
- **`main.js`:** owns `state` (`product`, `freq`, `pi` = period index, `focus`, `metric`, `back` = change-mode **years**, `groupsOn`, `pair`).
  - `backN()` converts change-mode years to periods (×12 for monthly), so "Δ 1 yr" is year-on-year for the same month.
  - `update()` loads flows (with an `updateToken` race guard), builds a color scale whose domain covers **all periods** (cached by `scaleKey`), renders everything, and writes the URL hash with `replaceState`.
  - Views: `applyView(view)` sets the whole state from an object with the URL-hash keys (`product`, `freq`, `t`, `focus`, `metric`, `change`, `groups`, `with`, `view`, `x`, `y`, `mapby`, `scale`, `set`). It is used by `readHash` and by stories. `playTo(index, ms)` animates the timeline and resolves when done or stopped.
  - A `hashchange` listener re-reads the hash for pasted links and back/forward. Old `year=` links still work.
  - Map coloring by an indicator uses a domain over all years; diverging indicators (growth, balances) use the 98th percentile of |value| so outliers don't wash out the map.
  - It also owns the tooltip, the controls and the About dialog.
- **`stories.js`:** the story player.
  - Loads `stories/index.json` and `stories/<id>.json`. The Stories dialog lists them sorted by `start`, with topic chips from the index's `tags` (names `storyTag.<id>` in i18n; the chosen chip is kept in localStorage `storyTag`). Each step calls `applyView`, then optionally `playTo`. Step changes bump a `token`, so a replay that is still running can't overwrite a later step.
  - "Treat as one" changes the reader makes during a story are kept for its later steps (`applyStoryView` in `main.js` applies them on top of each step's `groups`; they reset when the story ends).
  - Every figure a story quotes from site data is listed in `pipeline/storycheck.py` `CLAIMS` (English snippet + how to compute it); `check-stories` recomputes them after each build and requires the English snippet and a matching number in each translation, within the written rounding. Add a claim whenever a story quotes a new figure.
  - A step's optional `panel` names a panel section (`data-sec` wrappers from `sec()` in `panel.js`: summary, list, pair, trade, partners, economy, development, lending, products; the world view has summary, trade, partners and development, with World figures). `stories.js` sets `.layout[data-spot]` (CSS: from 1280px a three-column grid, map | full-height panel | story card, so the card keeps its place and size; narrower screens only highlight), highlights the section after every panel render (a MutationObserver) and keeps it scrolled into view through replays until the reader scrolls the panel.
  - Steps can also `ask` a guess-first question (caption and replay wait for the answer; answers are checked against the data by `QUIZZES` in `storycheck.py`; the last step shows the score and the next story), show a headline `stat` (counts up; its value must be a claim snippet) and put labelled `pins` on the map (`map.js` `pins`). A step with `watch` holds its caption back during its replay (showing the cue, revealed when the replay ends; `reveal` in `stories.js`), and map steps briefly outline the countries they are about (`look`, or the caption's first two non-focus links; `map.js` `flash`). Writing guideline: one point per step, about three figures; `check-stories` notes steps quoting more than `MAX_FIGURES`. See `site/stories/README.md`.
  - Captions support `**bold**` and `[name](CODE)` links (`inline` in `stories.js`); a link calls `setFocus(CODE)` and hovering it calls `map.outline(CODE)`.
  - While a story is active, the URL is `#story=<id>&step=<n>`. The format is in `site/stories/README.md`. Numbers quoted in stories must come from site data, and other facts must be cited in the story's `sources`.
  - **Head to head** (`versus.js`): the Stories dialog's two-economy form starts a generated story with id `vs-<A>-<B>`, built at run time from site data (no JSON, no `CLAIMS`; strings `vs.*`). Its steps may have a `figure` (chart/table in the card, year marker kept in step by `syncStoryYear`) and the story outlines both economies via `marks` (`hooks.mark` → `storyMarks` in `main.js`, used like a list highlight). See `site/stories/README.md`.
  - To get or check a story's numbers, open the step's view as a URL hash (e.g. `#view=compare&x=gdp&y=exports&t=2024`) and read `#map-title` and the dots' `__data__` in a headless browser; Compare-view r values depend on the dot set (merged groups) and on the axis scales, so they must be re-checked when either changes.
- **`map.js`:** `render({focus, pi, groupsOn, colorOf, arcs})`.
  - Group outlines come from `topojson.mesh` and are recomputed when merged groups or that year's membership change.
  - Arc endpoints use the centroids of the largest polygons. Group centroids use all-time members, so arcs don't jump between years.
- **`panel.js`:** the side panel and `lineChart`, which is reused in tooltips. The Economy section shows indicators for the focus and correlates year-on-year % changes of exports and nominal GDP (`growthPairs`); levels are deliberately not correlated.
- **Compare view:** `metrics.js` `buildMetrics` defines every plottable metric (`value(key, year)`): trade from the active product's **annual** totals, World Bank indicators, and trade/GDP ratios. `compare.js` picks the dots (same display keys as the map, respecting merged groups **for the year shown**: `displayTotals` also lists countries merged only in some years, e.g. the UK after 2020, so `candidates` filters by `displayOf` at that period) and computes Pearson r on the plotted scale (log10 on log axes), Spearman ρ and a least-squares fit (`stats.js`). `scatter.js` draws it. Metrics with units usd, usd_pc or people get log axes (except signed ones: balance, FDI, current account), and so do the trade/GDP ratios, which span 0.1% to over 300%; points ≤0 are dropped on log axes. Entering Compare forces annual data. State keys: `view`, `sx`, `sy`; the map's world view can be colored by a metric via `mapBy`.

Languages (`i18n.js`): English and Simplified Chinese. `site/i18n/<lang>.json` has `ui` strings by key (may contain HTML; `t(key, vars)` fills `{placeholders}` unescaped, so callers escape data) and, for non-English, `names` of entities, regions, groups, products and indicators. `nameOf`, `productName`, `regionName` and `groupNote` in `data.js` and metric names in `metrics.js` return the translated name, falling back to the English in the data files. Number and period formats are locale-aware (`format.js`: Chinese uses 亿/万亿; `time.js`: "2008年9月"). The language comes from `?lang=`, then localStorage, then the browser, and switching reloads the page. Static HTML text uses `data-i18n` / `data-i18n-attr`. Translated stories live in `site/stories/<lang>/` with the same ids. Don't name a local variable `t` in a module that imports it. Chinese country names are CLDR short names with a few overrides to match the English names (e.g. 中国香港, 台湾, 约旦河西岸和加沙); region names are UN M49's official Chinese. Source names, citations and licences are not translated. `tests/test_i18n.py` requires the same keys and placeholders in every language, a name for every entity/group/product/indicator in config, and a translation of every story with identical views, replays, marker times and source URLs.

**Trends view** (`trends.js`, `view=trends`): line charts over `store.periods` of the active slice (any frequency or product). With a focus: its exports/imports/balance, and its top 8 partners at the selected period (from the same `partnerSeries` as the map, so merged groups apply). Always: a set of economies (`state.set`, URL `set=`; `null` = the 6 largest displayed at the selected period, `none` = empty) drawn from their own `store.totals`, regardless of merging. `scale` is `usd`, `log` or `share` (of the focus's total or of the world; balance forces `usd`). `multiLine` places end labels without overlap and shows a hover readout; clicking near a line calls `onPair` (partners) or `onFocus` (set). `findEntity` in `main.js` resolves typed names for both the header search and the set editor.

Theming uses CSS variables with a `prefers-color-scheme` dark mode, and the JS palettes in `palettes()` follow it. On screens ≤980px, `.layout` uses `display: contents` so blocks can be reordered with `order`.

## Constraints

- This is a public site, so attribution matters. Keep `META` in source modules, the footer and the About dialog accurate.
- When aggregation logic changes, update the methodology text (`about.*` keys in `site/i18n/en.json` **and** `zh.json`; `renderSources` in `main.js` assembles it). Current caveats:
  - Figures are as reported by the focus country.
  - Exports are valued FOB and imports CIF.
  - Mirror data for Taiwan.
  - Group membership is applied as of each year.
  - Monthly data is not seasonally adjusted.
  - Product figures (BACI, reconciled, FOB) don't add up exactly to the IMF all-goods figures.
  - Correlations are across economies (Compare) or of growth rates (panel), never of trending levels; group indicator sums include flows between members.
  - Development indicators (life expectancy, child mortality, poverty, electricity, CO2 per person, HDI) are not computed for groups; World figures are the sources' own aggregates.

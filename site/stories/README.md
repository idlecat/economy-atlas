# Stories

Guided replays shown by the "Stories" button. Each story is one JSON file listed in `index.json`.

```jsonc
// index.json
{ "stories": [ { "id": "crisis-2008", "title": "…", "summary": "…" } ] }

// <id>.json
{
  "title": "Short title shown on the story card",
  "markers": [ { "t": "2008-09", "label": "Lehman Brothers files for bankruptcy" } ],  // ticks on the timeline
  "sources": [ { "name": "…", "url": "https://…" } ],   // citations for any fact not computed from site data
  "steps": [
    {
      "title": "Step heading",
      "text": ["Paragraph one, **bold** allowed.", "Paragraph two."],
      "view": { "freq": "M", "t": "2008-07", "focus": "USA", "metric": "exports",
                "change": "1", "groups": "EU", "with": "CHN" },
      "play": { "to": "2009-02", "ms": 450 }            // optional: replay the timeline after showing the view
    }
  ]
}
```

`view` uses the same keys as the URL hash:

| Key | Values |
|---|---|
| `product` | a sector or commodity id from `config/products.json` (annual only); omit for all goods |
| `freq` | `A` or `M` |
| `t` | a period, e.g. `2008` or `2008-09` |
| `focus` | an entity or group id |
| `metric` | `total`, `exports`, `imports` or `balance` |
| `change` | `1`, `5` or `10` (years); omit for levels |
| `groups` | merged groups, comma-separated, or `none` |
| `with` | a partner to compare with the focus |
| `view` | `compare` for the scatter view, `trends` for line charts over time; omit for the map |
| `scale` | Trends view: `log` or `share`; omit for US$ |
| `set` | Trends view: economies to compare, comma-separated, or `none`; omit for the 6 largest |
| `x`, `y` | Compare-view metrics, e.g. `gdp`, `gdp_pc`, `exports`, `exports_gdp` (see `site/js/metrics.js`) |
| `list` | highlight a country list from `config/lists.json`, e.g. `BRI` |
| `mapby` | color the world map by a metric instead of trade, e.g. `gdp_pc` |

If the reader changes "Treat as one" during a story, that choice is kept for the following steps (on top of each step's `groups`), so write captions that still make sense with groups split or merged.

Omitted keys take their defaults: annual data, the latest period, world view, total trade, levels, and the EU merged.

Rules for content on a public site:
- Every number quoted in `text` must come from this site's data, so readers can check it on the map. Recompute these numbers whenever the data is refreshed.
- Every other fact needs an entry in `sources`.

Translations: every story also needs `<lang>/<id>.json` (and an entry in `<lang>/index.json`), e.g. `zh/`. Only `title`, `text`, `summary` and marker `label`s are translated; views, replays, marker times and sources must be identical to the English file (`tests/test_i18n.py` checks this). Write amounts in the language's own units (Chinese: 1150亿美元, 1.6万亿美元), from the same site data.

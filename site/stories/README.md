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
| `freq` | `A` or `M` |
| `t` | a period, e.g. `2008` or `2008-09` |
| `focus` | an entity or group id |
| `metric` | `total`, `exports`, `imports` or `balance` |
| `change` | `1`, `5` or `10` (years); omit for levels |
| `groups` | merged groups, comma-separated, or `none` |
| `with` | a partner to compare with the focus |

Omitted keys take their defaults: annual data, the latest period, world view, total trade, levels, and the EU merged.

Rules for content on a public site:
- Every number quoted in `text` must come from this site's data, so readers can check it on the map. Recompute these numbers whenever the data is refreshed.
- Every other fact needs an entry in `sources`.

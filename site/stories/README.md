# Stories

Guided replays shown by the "Stories" button. Each story is one JSON file listed in `index.json`.

```jsonc
// index.json
{ "tags": ["crises", "china", "energy", "policy"],      // topic filters in the Stories dialog, in chip order
  "stories": [ { "id": "crisis-2008", "title": "…", "summary": "…",
                 "start": 2008,                          // first year the story covers; the dialog sorts by it
                 "tags": ["crises"] } ] }                // one or more of the tags above

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
      "play": { "to": "2009-02", "ms": 450 },           // optional: replay the timeline after showing the view
      "panel": "products",                              // optional: the step is about this panel section
      "ask": { "q": "Who bought the most?",             // optional: the reader guesses before the caption shows
               "choices": ["IND", "EU", "CHN"], "answer": 2 },
      "stat": { "value": "−50%", "label": "Exports in April 2022, vs a year earlier" },  // optional headline figure
      "pins": [ { "at": [30.73, 46.48], "label": "Odesa", "side": "left" } ]          // optional labelled places
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

`panel` is for steps where a block in the side panel says more than the map. On wide screens (≥1280px) the panel moves into a full-height column between the map and the story card, which keeps its place, so the map gets narrower; the named section is highlighted and scrolled into view, and the rest of the panel is dimmed. Sections (`data-sec` in `site/js/panel.js`): `summary` (name, product share and totals), `list` (the highlighted list), `pair` (comparison with `with`), `trade` (trade with the world chart), `partners` (top partners), `economy`, `development` (health, poverty, electricity, CO2 and the Human Development Index; with no focus, the World figures), `lending` (debt and investment) and `products` (trade by product). Mention the section in the caption, as it is not always on screen (e.g. on phones).

Making a story more than a slideshow:
- `ask` turns a step into a guess: the question and its choices come first, and the caption, the headline figure and the replay follow once the reader picks one (or "Just show me"). Choices are entity or group ids (shown by name, in every language) or short text (translated). Put questions on steps whose view doesn't give the answer away, best a step with a `play` that then reveals it. Each question is listed in `pipeline/storycheck.py` `QUIZZES` with how to find the right choice from the data, so a data revision that changes the answer fails `check-stories`. The last step shows the reader's score and links to the next story (same topic first).
- `stat` shows one figure large, counting up. Its `value` must be the snippet of one of the step's claims (`check-stories` checks it, and checks the label's numbers like the caption's); keep the label short and free of other figures.
- `pins` mark places the caption talks about, or small countries the map can't show well (Kuwait), with a pulsing dot. `at` is `[longitude, latitude]` and is the same in every language; `side: "left"` puts the label on the left. Pins show on the map view only.

If the reader changes "Treat as one" during a story, that choice is kept for the following steps (on top of each step's `groups`), so write captions that still make sense with groups split or merged.

Omitted keys take their defaults: annual data, the latest period, world view, total trade, levels, and the EU merged.

Caption markup: `**bold**`, and `[name](CODE)` for a country or group link (an entity id from `config/entities.csv` or a group id). Clicking a link focuses that entity, like a click on the map (the named country itself, even if its group is merged); hovering outlines it on the map. Link the first mention of each country in a step, in every language; `tests/test_i18n.py` checks that link targets exist.

Rules for content on a public site:
- Every number quoted in `text` must come from this site's data, so readers can check it on the map. List each one in `pipeline/storycheck.py` `CLAIMS` (the English snippet and how to compute it); `python -m pipeline check-stories` verifies them in every language after each data refresh, and CI won't deploy while any is out of date.
- Every other fact needs an entry in `sources`.

Tags: give each story the topics a reader would look for it under (a story can have several); add a new tag only when at least two stories share it, with a `storyTag.<id>` name in every `site/i18n/<lang>.json`.

Translations: every story also needs `<lang>/<id>.json` (and an entry in `<lang>/index.json`), e.g. `zh/`. Only `title`, `text`, `summary`, marker and pin `label`s, `ask` questions and text choices, and `stat` values and labels are translated (a `stat` value in the language's own units); views, replays, panels, marker times, pin positions, question answers and sources must be identical to the English file (`tests/test_i18n.py` checks this). Write amounts in the language's own units (Chinese: 1150亿美元, 1.6万亿美元), from the same site data.

# Ancient Crossroads (prototype)

An interactive map of civilisations from 3000 BC to AD 1500 and how they interacted, focused on the Silk Roads: states and cultures, trade routes, journeys, battles and the spread of ideas, with a guided tour. It is separate from the Economy Atlas site and its pipeline.

- `data.js`: all content (civilisations with dated shapes, routes, events, tour stops, map views). Shapes are rough hand-drawn rings, clipped to land when drawn; years are negative for BC.
- `app.js`: the D3 map, timeline and panel.
- `page.html`: markup and styles, with placeholders for the inlined geography, data and app.
- `build.py`: downloads Natural Earth coastlines, rivers and lakes into `.cache/` and writes the page (git-ignored), in one of two forms:
  - default: `ancient-crossroads.html`, a self-contained page that loads D3, topojson and fonts from CDNs (used for the Claude artifact);
  - `--site`: `site/ancient/index.html`, published with the site at `/ancient/`. Like the rest of the site it loads D3, topojson-client and its fonts from `site/vendor/` (fonts and `ancient-crossroads.css` come from `scripts/vendor.sh`), so it works where CDNs are blocked.

```sh
uv run python prototypes/ancient-crossroads/build.py --site
python3 -m http.server -d site 8000   # then open http://localhost:8000/ancient/
```

The deploy workflow builds the site page, and the browser smoke test checks it when it has been built. The site footer links to it (`footer.ancient`). Borders, dates and figures were written from general knowledge and simplified; they have not been checked line by line against sources.

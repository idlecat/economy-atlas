# Ancient Crossroads (prototype)

An interactive map of civilisations from 3000 BC to AD 1500 and how they interacted, focused on the Silk Roads: states and cultures, trade routes, journeys, battles and the spread of ideas, with a guided tour. It is separate from the Economy Atlas site and its pipeline.

- `data.js`: all content (civilisations with dated shapes, routes, events, tour stops, map views). Shapes are rough hand-drawn rings, clipped to land when drawn; years are negative for BC.
- `details.js`: what the panel shows for a selected civilisation besides `data.js`: its Wikipedia article (`WIKI`), dated key moments (`MOMENTS`) and population figures with their sources (`POP`), and successions of states over the same heartland (`SUCCESSIONS`, e.g. the Chinese dynasties), which the earlier/later buttons step across.
- `i18n/<lang>.js`: a translation (`I18N.<lang>`; so far `zh`, Simplified Chinese): interface strings (the keys of `UI_EN` in `app.js`), year formats, and the text of `data.js` and `details.js` by id (key moments and population figures in the same order as the English). The language is chosen like on the main site (`?lang=`, then localStorage `lang`, which the site shares, then the browser) and from the menu in the header. Anything left untranslated stays in English and is listed in `window.__i18nMissing`, which the smoke test requires to be empty, so add every new civilisation, route, event, place label or key moment to each translation. To add a language, copy `zh.js` and translate it.
- `app.js`: the D3 map, timeline and panel.
- `page.html`: markup and styles, with placeholders for the inlined geography, data and app.
- `build.py`: downloads Natural Earth coastlines, rivers and lakes, plus each civilisation's Wikipedia lead text, image and image credit (and the lead text of the same article on each translation's Wikipedia, found through its interlanguage links; `zh` asks for Simplified Chinese), into `.cache/` (delete `.cache/wiki/` to refresh), and writes the page (git-ignored). Images are shrunk to small JPEGs with Pillow; the page itself never contacts Wikipedia. Two forms:
  - default: `ancient-crossroads.html`, a self-contained page (images inlined) that loads D3, topojson and fonts from CDNs (used for the Claude artifact);
  - `--site`: `site/ancient/index.html` and `site/ancient/img/`, published with the site at `/ancient/`. Like the rest of the site it loads D3, topojson-client and its fonts from `site/vendor/` (fonts and `ancient-crossroads.css` come from `scripts/vendor.sh`), so it works where CDNs are blocked.

```sh
uv run --with pillow python prototypes/ancient-crossroads/build.py --site
python3 -m http.server -d site 8000   # then open http://localhost:8000/ancient/
```

The deploy workflow builds the site page, and the browser smoke test checks it when it has been built. The site footer links to it (`footer.ancient`). Borders, dates and figures were written from general knowledge and simplified; they have not been checked line by line against sources. The Chinese text was translated from the English the same way.

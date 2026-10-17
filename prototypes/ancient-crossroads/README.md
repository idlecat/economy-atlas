# Ancient Crossroads (prototype)

An interactive map of civilisations from 3000 BC to AD 1500 and how they interacted, focused on the Silk Roads: states and cultures, trade routes, journeys, battles and the spread of ideas, with a guided tour. It is separate from the Economy Atlas site and its pipeline.

- `data.js`: all content (civilisations with dated shapes, routes, events, tour stops, map views). Shapes are rough hand-drawn rings, clipped to land when drawn; years are negative for BC.
- `app.js`: the D3 map, timeline and panel.
- `page.html`: markup and styles, with placeholders for the inlined geography, data and app.
- `build.py`: downloads Natural Earth coastlines, rivers and lakes into `.cache/` and writes the self-contained `ancient-crossroads.html` (git-ignored).

```sh
uv run python prototypes/ancient-crossroads/build.py
open prototypes/ancient-crossroads/ancient-crossroads.html
```

The page loads D3 and topojson from cdnjs. Borders, dates and figures were written from general knowledge and simplified; they have not been checked line by line against sources.

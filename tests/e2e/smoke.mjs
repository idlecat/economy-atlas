// Browser smoke test: every view, the main interactions and every story step, in every language.
// Fails on any page error, failed request or missing content. Needs the site served over HTTP:
//   python3 -m http.server -d site 8000 &   (and published data in site/data)
//   cd tests/e2e && npm ci && npx playwright install chromium && npm test
// Env: BASE_URL (default http://localhost:8000), CHANNEL (e.g. "chrome" to use an installed Chrome).
import { chromium } from "playwright";
import fs from "node:fs";

const BASE = process.env.BASE_URL ?? "http://localhost:8000";
const SITE = new URL("../../site/", import.meta.url);
const LANGS = ["en", "zh"];
const failures = [];
const fail = (msg) => { failures.push(msg); console.log(`  FAIL ${msg}`); };

const browser = await chromium.launch(process.env.CHANNEL ? { channel: process.env.CHANNEL } : {});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
let where = "";
page.on("pageerror", (e) => fail(`${where}: page error: ${e.message}`));
// net::ERR_ABORTED: cancelled by the next navigation (open() reloads while data is still loading), not broken.
// A missing file still fails below through its HTTP status.
page.on("requestfailed", (r) => {
  if (!r.url().includes("favicon") && r.failure()?.errorText !== "net::ERR_ABORTED") fail(`${where}: request failed: ${r.url()} (${r.failure()?.errorText})`);
});
page.on("response", (r) => {
  // translated story files may legitimately be missing (the English one is used); everything else must load
  if (r.status() >= 400 && !/\/stories\/[a-z]{2}\//.test(r.url())) fail(`${where}: HTTP ${r.status()} ${r.url()}`);
});
page.on("request", (r) => { if (!r.url().startsWith(BASE)) fail(`${where}: external request ${r.url()}`); });

async function open(lang, hash) {
  where = `${lang} #${hash}`;
  await page.goto(`${BASE}/?lang=${lang}#${hash}`, { waitUntil: "load" });
  await page.reload({ waitUntil: "load" }); // a hash-only change doesn't reload
  await page.waitForSelector(".panel h2", { timeout: 20000 });
  await page.waitForTimeout(700);
}
const text = (sel) => page.textContent(sel).then((s) => (s ?? "").trim());
async function expect(cond, msg) { if (!(await cond)) fail(`${where}: ${msg}`); }

for (const lang of LANGS) {
  console.log(`== ${lang}: views`);
  await open(lang, "t=2024");
  await expect(page.$$eval("#map path.country", (e) => e.length).then((n) => n > 200), "map has country shapes");
  await expect(text("#map-title").then((s) => s.length > 10), "map title");
  await open(lang, "t=2024&focus=CHN&metric=exports");
  await expect(page.$$eval(".arc", (e) => e.length).then((n) => n > 0), "arcs for a focus");
  await expect(page.$$eval(".partners li[data-key]", (e) => e.length).then((n) => n >= 10), "partner list");
  await open(lang, "freq=M&t=2009-02&focus=JPN&change=1");
  await open(lang, "t=2024&product=CRUDE&focus=SAU&metric=exports");
  await open(lang, "t=2024&focus=PAK&list=BRI");
  await expect(page.$$eval(".econ.lend tr", (e) => e.length).then((n) => n > 2), "lenders and investors table");
  await open(lang, "t=2024&mapby=debt_share_CHN&list=BRI");
  await expect(page.$eval(".list-outline", (e) => (e.getAttribute("d") ?? "").length > 1000), "list outline");
  await open(lang, "view=compare&x=gdp&y=exports&t=2024");
  await expect(page.$$eval("#compare circle.dot", (e) => e.length).then((n) => n > 100), "scatter dots");
  await open(lang, "view=compare&x=removed_metric&y=exports&t=2024");
  await expect(page.$eval("#sx", (e) => e.value === "gdp"), "unknown axis metric falls back to GDP");
  await open(lang, "view=trends&t=2024&focus=DEU&scale=log");
  await expect(page.$$eval("#trends .tl", (e) => e.length).then((n) => n > 8), "trend lines");
  // interactions
  await page.click('#view button[data-v="map"]');
  await page.waitForTimeout(500);
  await page.click('#group-chips .chip[data-g="ASEAN"]');
  await page.click('#metric button[data-v="balance"]');
  await page.click('#mode button[data-v="5"]');
  await page.waitForTimeout(500);
  // Space on a focused button activates it instead of starting playback
  await page.focus('#metric button[data-v="imports"]');
  await page.keyboard.press(" ");
  await page.waitForTimeout(300);
  await expect(page.getAttribute('#metric button[data-v="imports"]', "aria-checked").then((v) => v === "true"), "Space activates a focused button");
  await expect(page.evaluate(() => location.hash.includes("t=2024")), "Space doesn't start playback");
  // the Stories dialog filters by topic
  await page.click("#stories-btn");
  await page.waitForSelector("#story-tags [data-tag]");
  const allStories = await page.$$eval("#stories-list li", (e) => e.length);
  await page.click('#story-tags [data-tag="energy"]');
  await page.waitForTimeout(300);
  await expect(page.$$eval("#stories-list li", (e) => e.length).then((n) => n > 0 && n < allStories), "story tag filter");
  await page.click('#story-tags [data-tag="all"]');
  await page.keyboard.press("Escape");
  await page.click("#about-btn");
  await expect(text("#about-body").then((s) => s.length > 2000), "About text");
  await page.keyboard.press("Escape");

  console.log(`== ${lang}: stories`);
  const dir = lang === "en" ? "stories/" : `stories/${lang}/`;
  const index = JSON.parse(fs.readFileSync(new URL(`${dir}index.json`, SITE)));
  await open(lang, "t=2024");
  for (const { id } of index.stories) {
    const story = JSON.parse(fs.readFileSync(new URL(`${dir}${id}.json`, SITE)));
    for (let i = 0; i < story.steps.length; i++) {
      where = `${lang} story ${id} step ${i + 1}`;
      await page.evaluate(([s, n]) => { location.hash = `story=${s}&step=${n}`; }, [id, i + 1]);
      await page.waitForTimeout(900);
      await expect(text("#story h3").then((s) => s === story.steps[i].title), "step title");
      const st = story.steps[i];
      const links = await page.$$eval("#story a.ent", (e) => e.length);
      const marked = [...st.text, st.ask?.q ?? "", st.stat?.label ?? ""].join(" ");
      const expected = marked.match(/\]\([A-Z0-9_]+\)/g)?.length ?? 0;
      if (links !== expected) fail(`${where}: ${links} country links, expected ${expected}`);
      if (st.ask) {
        // the caption stays hidden until the reader guesses; the right choice is marked
        await expect(page.isHidden("#story .story-body"), "caption hidden before the guess");
        await page.click(`#story [data-choice="${st.ask.answer}"]`);
        await expect(page.isVisible("#story .ask-verdict.right"), "right guess acknowledged");
        if (!st.watch) await expect(page.isVisible("#story .story-body"), "caption shown after the guess");
      }
      if (st.watch) {
        // the caption waits for the replay; the reader can ask for it at once
        await expect(page.isVisible("#story .story-watch"), "watch cue shown during the replay");
        await expect(page.isHidden("#story .story-body"), "caption held back during the replay");
        await page.click("#story .story-reveal");
        await expect(page.isVisible("#story .story-body"), "caption shown on request");
      }
      const others = [...new Set([...st.text.join(" ").matchAll(/\]\(([A-Z0-9_]+)\)/g)].map((m) => m[1]))].filter((c) => c !== st.view.focus);
      if (!st.view.view && !st.ask && (st.look ?? others).length) await expect(page.$("#map .flash-outline.on").then(Boolean), "countries in the caption outlined");
      if (st.stat) await expect(page.isVisible("#story .story-stat"), "headline figure shown");
      if (st.pins && !st.view.view) await expect(page.$$eval("#map .pin", (e) => e.length).then((n) => n === st.pins.length), "map pins");
      if (i === story.steps.length - 1) await expect(page.isVisible("#story .story-next"), "next story offered");
      if (story.steps[i].panel) {
        await expect(page.$(`#panel .psec.spot[data-sec="${story.steps[i].panel}"]`).then(Boolean), `panel section "${story.steps[i].panel}" highlighted`);
        await expect(page.isVisible("#panel .panel-head"), "panel header pinned on a spotlight step");
      }
    }
  }
  // a story link focuses the country
  where = `${lang} story link`;
  await page.evaluate(() => { location.hash = "story=belt-road&step=5"; });
  await page.waitForTimeout(1200);
  await page.click('#story a.ent[data-key="LAO"]');
  await page.waitForTimeout(1000);
  await expect(text(".panel h2").then((s) => s === (lang === "en" ? "Laos" : "老挝")), "link focuses Laos");

  // Head to head: a story generated for two economies picked in the Stories dialog
  where = `${lang} head to head`;
  await page.click("#stories-btn");
  await page.fill("#vs-a", "CHN");
  await page.fill("#vs-b", "USA");
  await page.click('#vs-form button[type="submit"]');
  await page.waitForTimeout(1500);
  await expect(page.evaluate(() => location.hash.startsWith("#story=vs-CHN-USA")), "story started from the dialog");
  for (let i = 0; i < 12; i++) {
    where = `${lang} head to head step ${i + 1}`;
    await expect(text("#story h3").then((s) => s.length > 0), "step title");
    if (await page.$("#story [data-choice]:not([disabled])")) await page.click('#story [data-choice="0"]');
    await expect(text("#story .story-body").then((s) => s.length > 40 && !s.includes("{")), "caption filled in");
    if (await page.$("#story .story-fig")) await expect(page.$("#story .story-fig svg, #story .story-fig table").then(Boolean), "figure drawn");
    if (!(await page.$('#story [data-go="1"]'))) break;
    await page.click('#story [data-go="1"]');
    await page.waitForTimeout(900);
  }
  await expect(page.isVisible("#story [data-vs-again]"), "another pair offered at the end");
}

// Ancient Crossroads (/ancient/, built by prototypes/ancient-crossroads/build.py --site; skipped if not built)
if (fs.existsSync(new URL("ancient/index.html", SITE))) for (const lang of LANGS) {
  console.log(`== ancient crossroads: ${lang}`);
  where = `ancient ${lang}`;
  await page.goto(`${BASE}/ancient/?lang=${lang}`, { waitUntil: "load" });
  await page.waitForTimeout(800);
  await expect(page.evaluate(() => window.__i18nMissing.length === 0), "every name and text translated");
  await expect(page.evaluate((l) => document.documentElement.lang.startsWith(l), lang), "page language");
  await expect(page.$$eval("#map path.civ", (e) => e.length).then((n) => n > 10), "civilisations drawn");
  await expect(page.$$eval("#map g.route", (e) => e.length).then((n) => n > 2), "routes drawn");
  await expect(page.$$eval("#map circle.city", (e) => e.length).then((n) => n > 10), "cities drawn");
  await page.dispatchEvent("#map circle.city:last-of-type", "click");
  await expect(page.$("#panel .popchart").then(Boolean), "city details open");
  await page.click("#panel [data-close]");
  for (let i = 0; i < 12; i++) {
    where = `ancient ${lang} tour stop ${i + 1}`;
    await page.click(`#panel button[data-chapter="${i}"]`);
    await page.waitForTimeout(400);
    await expect(text("#panel .tour h2").then((s) => s.length > 1), "tour stop title");
  }
  await page.dispatchEvent("#map path.civ", "click"); // routes drawn on top would intercept a real click
  await expect(page.$("#panel [data-close]").then(Boolean), "civilisation details open");
  const before = await text("#stampyear");
  await page.click("#panel .stepper button:not(:disabled)");
  await page.waitForTimeout(300);
  await expect(text("#stampyear").then((s) => s !== before), "previous/next moment moves the year");
}
if (!fs.existsSync(new URL("ancient/index.html", SITE))) console.log("== ancient crossroads: not built, skipped");

await browser.close();
console.log(failures.length ? `\n${failures.length} failure(s)` : "\nall checks passed");
process.exit(failures.length ? 1 : 0);

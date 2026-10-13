// Guided replays ("stories"). A story is a JSON file in stories/ with a list of steps; each step
// is a view (the same keys as the URL hash) plus a caption, and may replay the timeline up to a
// period. See stories/README.md for the format.
import { escapeHTML as esc } from "./format.js";
import { periodLabel } from "./time.js";
import { getLang, t } from "./i18n.js";

const $ = (s) => document.querySelector(s);
let hooks = null;
let index = null;
let story = null;
let step = 0;
let token = 0;
let spot = null;          // panel section the current step points at (step.panel)
let spotPin = false;      // keep it scrolled into view (through replays) until the reader scrolls the panel
let answers = new Map();  // step index -> chosen option, for steps that ask the reader to guess first (step.ask)
let indexData = null;     // the loaded index, for "up next"

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

/** A story file in the interface language (stories/<lang>/<file>), or the English original. */
function getLocalized(file) {
  const en = getJSON(`stories/${file}`);
  return getLang() === "en" ? en : getJSON(`stories/${getLang()}/${file}`).catch(() => en);
}

function loadIndex() {
  index ??= getLocalized("index.json").catch(() => ({ stories: [] })).then((d) => (indexData = d));
  return index;
}

/** hooks: {applyView(view), playTo(period, ms), stopPlay(), setMarkers(list), onChange(),
 *          knows(code), name(code), focus(code), outline(code|null), pins(list)} */
/** The Stories dialog: tag chips over the list, sorted by the period each story covers. The chosen tag
 *  is remembered per browser (a convenience only). */
let tag = (() => { try { return localStorage.getItem("storyTag") ?? "all"; } catch { return "all"; } })();

function renderList({ tags = [], stories }) {
  if (tag !== "all" && !tags.includes(tag)) tag = "all";
  $("#story-tags").innerHTML = stories.length && tags.length ? ["all", ...tags].map((id) =>
    `<button type="button" class="chip" data-tag="${esc(id)}" aria-pressed="${id === tag}">${t(`storyTag.${id}`)}</button>`).join("") : "";
  const shown = stories.filter((s) => tag === "all" || s.tags?.includes(tag))
    .sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  $("#stories-list").innerHTML = shown.length
    ? shown.map((s) => `
      <li><button type="button" data-id="${esc(s.id)}">
        <b>${esc(s.title)}</b><span>${esc(s.summary)}</span>
        ${s.tags?.length ? `<span class="tags">${tags.filter((x) => s.tags.includes(x)).map((x) => `<i>${t(`storyTag.${x}`)}</i>`).join("")}</span>` : ""}
      </button></li>`).join("")
    : `<li>${t("stories.none")}</li>`;
}

export function initStories(h) {
  hooks = h;
  // the panel is re-rendered on every update, so the highlight is re-applied after each render
  const panel = $("#panel");
  new MutationObserver(applySpot).observe(panel, { childList: true });
  for (const ev of ["wheel", "touchstart", "pointerdown", "keydown"]) panel.addEventListener(ev, () => { spotPin = false; }, { passive: true });
  const dialog = $("#stories-dialog");
  $("#stories-btn").addEventListener("click", async () => {
    renderList(await loadIndex());
    dialog.showModal();
  });
  $("#story-tags").addEventListener("click", async (e) => {
    const id = e.target.closest("[data-tag]")?.dataset.tag;
    if (!id) return;
    tag = id;
    try { localStorage.setItem("storyTag", tag); } catch { /* storage blocked */ }
    renderList(await loadIndex());
  });
  $("#stories-list").addEventListener("click", (e) => {
    const id = e.target.closest("button")?.dataset.id;
    if (id) { dialog.close(); startStory(id, 0); }
  });
}

export function activeStory() {
  return story ? { id: story.id, step } : null;
}

/** Start a story at step `at`. Resolves false if the story can't be loaded. */
export async function startStory(id, at = 0) {
  const { stories } = await loadIndex();
  if (!stories.some((s) => s.id === id)) return false;
  try {
    story = { id, ...(await getLocalized(`${encodeURIComponent(id)}.json`)) };
    answers = new Map();
  } catch {
    return false;
  }
  hooks.setMarkers(story.markers ?? []);
  $("#story").hidden = false;
  await goTo(at);
  return true;
}

export function stopStory() {
  token++;
  hooks.stopPlay();
  story = null;
  setSpot(null);
  hooks.pins([]);
  $("#story").hidden = true;
  $("#story").innerHTML = "";
  hooks.setMarkers([]);
  hooks.onChange();
}

async function goTo(i, { replay = true } = {}) {
  const my = ++token;
  hooks.stopPlay();
  step = Math.max(0, Math.min(story.steps.length - 1, i));
  const s = story.steps[step];
  render(s);
  setSpot(s.panel);
  hooks.pins(s.pins);
  await hooks.applyView(s.view);
  // a question is asked before the replay that answers it: the replay starts once the reader has guessed
  if (my !== token || !s.play || !replay || (s.ask && !answers.has(step))) return;
  await replayStep(my);
}

async function replayStep(my = ++token) {
  const s = story.steps[step];
  setPlaying(true);
  await hooks.playTo(s.play.to, s.play.ms);
  if (my === token) setPlaying(false);
}

/** A step about a panel section: on wide screens the panel gets its own column (CSS: .layout[data-spot]),
 *  and the section is highlighted and scrolled into view. */
function setSpot(id) {
  const layout = $(".layout");
  if (spot && !id) $("#panel").scrollTop = 0; // don't leave the next step's panel scrolled to the old section
  spot = id ?? null;
  spotPin = !!spot;
  if (spot) layout.dataset.spot = spot;
  else delete layout.dataset.spot;
  applySpot();
}

function applySpot() {
  const panel = $("#panel");
  for (const el of panel.querySelectorAll(".psec.spot")) el.classList.remove("spot");
  const el = spot && panel.querySelector(`.psec[data-sec="${spot}"]`);
  if (!el) return;
  el.classList.add("spot");
  // scroll the panel only (not the page), after the layout change has been laid out; sections above
  // it change height while the timeline replays, so this repeats on every render
  if (spotPin) {
    requestAnimationFrame(() => {
      // el is detached if the panel re-rendered meanwhile; that render scheduled its own scroll
      // land the section just below the pinned panel header (.panel-head), if it is shown
      const below = panel.querySelector(".panel-head")?.offsetHeight ?? 0;
      if (spotPin && el.isConnected) panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - below - 12;
    });
  }
}

function setPlaying(on) {
  const el = $("#story .story-replay");
  if (el) el.textContent = on ? t("stories.replaying") : `↻ ${t("stories.replay", { from: periodLabel(story.steps[step].view.t), to: periodLabel(story.steps[step].play.to) })}`;
}

/** A guess-first question: choices are entity codes (shown by name) or short text. */
function choiceLabel(c) {
  return /^[A-Z][A-Z0-9_]{1,9}$/.test(c) && hooks.knows(c) ? esc(hooks.name(c)) : esc(c);
}

function askHTML(ask) {
  const chosen = answers.get(step);
  const done = chosen !== undefined;
  const cls = (i) => (!done ? "" : i === ask.answer ? "right" : i === chosen ? "wrong" : "");
  const verdict = !done ? ""
    : chosen === ask.answer ? `<p class="ask-verdict right" role="status">✓ ${t("stories.right")}</p>`
    : chosen < 0 ? `<p class="ask-verdict" role="status">${t("stories.itWas", { answer: choiceLabel(ask.choices[ask.answer]) })}</p>`
    : `<p class="ask-verdict wrong" role="status">✗ ${t("stories.wrong", { answer: choiceLabel(ask.choices[ask.answer]) })}</p>`;
  return `<div class="story-ask">
      <span class="ask-kicker">${t("stories.guess")}</span>
      <p class="ask-q">${inline(ask.q)}</p>
      <div class="ask-choices">${ask.choices.map((c, i) =>
        `<button type="button" class="btn ${cls(i)}" data-choice="${i}" ${done ? "disabled" : ""}>${choiceLabel(c)}</button>`).join("")}</div>
      ${done ? verdict : `<button type="button" class="linklike ask-skip" data-choice="-1">${t("stories.skip")}</button>`}
    </div>`;
}

/** A headline figure for the step; its number counts up when it is shown. */
function statHTML(stat) {
  return `<div class="story-stat"><b>${esc(stat.value)}</b><span>${inline(stat.label)}</span></div>`;
}

function countUp(el) {
  const m = el?.textContent.match(/\d[\d,]*(?:\.\d+)?/);
  if (!m || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const [before, after] = [el.textContent.slice(0, m.index), el.textContent.slice(m.index + m[0].length)];
  const target = +m[0].replace(/,/g, ""), decimals = m[0].split(".")[1]?.length ?? 0;
  const fmt = (v) => v.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals, useGrouping: m[0].includes(",") });
  const start = performance.now(), ms = 900;
  const tick = (now) => {
    if (!el.isConnected) return;
    const f = Math.min(1, (now - start) / ms);
    el.textContent = before + fmt(target * (1 - (1 - f) ** 3)) + after;
    if (f < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

/** The reader's score so far and the next story (same topic first), shown on the last step. */
function endHTML() {
  const asked = story.steps.map((s, i) => [s, i]).filter(([s]) => s.ask);
  const right = asked.filter(([s, i]) => answers.get(i) === s.ask.answer).length;
  const score = asked.length && asked.every(([, i]) => answers.has(i))
    ? `<p class="story-score">${t("stories.score", { n: right, total: asked.length })}</p>` : "";
  const next = nextStory();
  return score + (next ? `<button type="button" class="linklike story-next" data-next="${esc(next.id)}">${t("stories.upNext", { title: esc(next.title) })} →</button>` : "");
}

function nextStory() {
  const list = [...(indexData?.stories ?? [])].sort((a, b) => (a.start ?? 0) - (b.start ?? 0));
  const me = list.find((s) => s.id === story.id);
  if (!me || list.length < 2) return null;
  const after = [...list.slice(list.indexOf(me) + 1), ...list.slice(0, list.indexOf(me))];
  return after.find((s) => s.tags?.some((x) => me.tags?.includes(x))) ?? after[0];
}

/** Captions are plain text with two kinds of markup: **bold**, and [name](CODE) for a country or group
 *  link that focuses it like a click on the map. Unknown codes are shown as plain text. */
function inline(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\(([A-Z][A-Z0-9_]{1,9})\)/g, (m, label, code) =>
      (hooks.knows(code) ? `<a href="#" class="ent" data-key="${code}">${label}</a>` : label));
}

/** The reader picked choice i (-1: skipped): reveal the answer and the caption, then run the replay. */
function answer(i) {
  const s = story.steps[step];
  if (answers.has(step)) return;
  answers.set(step, i);
  render(s);
  if (s.play) replayStep();
}

function render(s) {
  const n = story.steps.length;
  const el = $("#story");
  el.innerHTML = `
    <div class="story-head">
      <span class="kicker">${esc(story.title)} · ${step + 1} / ${n}</span>
      <button type="button" class="story-close" aria-label="${t("stories.exit")}">✕</button>
    </div>
    <h3>${esc(s.title)}</h3>
    ${s.ask ? askHTML(s.ask) : ""}
    <div class="story-body" ${s.ask && !answers.has(step) ? "hidden" : ""}>
      ${s.stat ? statHTML(s.stat) : ""}
      ${(Array.isArray(s.text) ? s.text : [s.text]).map((p) => `<p>${inline(p)}</p>`).join("")}
      ${s.play ? `<button type="button" class="story-replay linklike"></button>` : ""}
      ${step === n - 1 ? endHTML() : ""}
    </div>
    <div class="story-nav">
      <button type="button" class="btn" data-go="-1" ${step === 0 ? "disabled" : ""}>← ${t("stories.back")}</button>
      <div class="dots">${story.steps.map((_, i) => `<button type="button" data-step="${i}" aria-label="${t("stories.step", { n: i + 1 })}" class="${i === step ? "on" : ""}"></button>`).join("")}</div>
      ${step < n - 1
        ? `<button type="button" class="btn primary" data-go="1">${t("stories.next")} →</button>`
        : `<button type="button" class="btn primary" data-end>${t("stories.explore")}</button>`}
    </div>
    ${story.sources?.length ? `<details class="story-sources"><summary>${t("stories.sources")}</summary><ul>${story.sources.map((src) =>
      `<li><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.name)}</a></li>`).join("")}</ul></details>` : ""}`;
  if (s.play) setPlaying(false);
  el.querySelector(".story-close").onclick = stopStory;
  el.querySelectorAll("[data-go]").forEach((b) => { b.onclick = () => goTo(step + +b.dataset.go); });
  el.querySelectorAll("[data-step]").forEach((b) => { b.onclick = () => goTo(+b.dataset.step); });
  el.querySelector("[data-end]")?.addEventListener("click", stopStory);
  el.querySelector(".story-replay")?.addEventListener("click", () => goTo(step));
  el.querySelector("[data-next]")?.addEventListener("click", (e) => startStory(e.currentTarget.dataset.next, 0));
  el.querySelectorAll("[data-choice]").forEach((b) => { b.onclick = () => answer(+b.dataset.choice); });
  if (!s.ask || answers.has(step)) countUp(el.querySelector(".story-stat b"));
  for (const a of el.querySelectorAll("a.ent")) {
    a.addEventListener("click", (e) => { e.preventDefault(); hooks.outline(null); hooks.focus(a.dataset.key); });
    a.addEventListener("mouseenter", () => hooks.outline(a.dataset.key));
    a.addEventListener("mouseleave", () => hooks.outline(null));
  }
}

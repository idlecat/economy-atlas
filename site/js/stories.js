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
  index ??= getLocalized("index.json").catch(() => ({ stories: [] }));
  return index;
}

/** hooks: {applyView(view), playTo(period, ms), stopPlay(), setMarkers(list), onChange(),
 *          knows(code), focus(code), outline(code|null)} */
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
  await hooks.applyView(s.view);
  if (my !== token || !s.play || !replay) return;
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
      if (spotPin && el.isConnected) panel.scrollTop += el.getBoundingClientRect().top - panel.getBoundingClientRect().top - 12;
    });
  }
}

function setPlaying(on) {
  const el = $("#story .story-replay");
  if (el) el.textContent = on ? t("stories.replaying") : `↻ ${t("stories.replay", { from: periodLabel(story.steps[step].view.t), to: periodLabel(story.steps[step].play.to) })}`;
}

/** Captions are plain text with two kinds of markup: **bold**, and [name](CODE) for a country or group
 *  link that focuses it like a click on the map. Unknown codes are shown as plain text. */
function inline(text) {
  return esc(text)
    .replace(/\*\*(.+?)\*\*/g, "<b>$1</b>")
    .replace(/\[([^\]]+)\]\(([A-Z][A-Z0-9_]{1,9})\)/g, (m, label, code) =>
      (hooks.knows(code) ? `<a href="#" class="ent" data-key="${code}">${label}</a>` : label));
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
    ${(Array.isArray(s.text) ? s.text : [s.text]).map((p) => `<p>${inline(p)}</p>`).join("")}
    ${s.play ? `<button type="button" class="story-replay linklike"></button>` : ""}
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
  for (const a of el.querySelectorAll("a.ent")) {
    a.addEventListener("click", (e) => { e.preventDefault(); hooks.outline(null); hooks.focus(a.dataset.key); });
    a.addEventListener("mouseenter", () => hooks.outline(a.dataset.key));
    a.addEventListener("mouseleave", () => hooks.outline(null));
  }
}

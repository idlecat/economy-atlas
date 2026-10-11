// Guided replays ("stories"). A story is a JSON file in stories/ with a list of steps; each step
// is a view (the same keys as the URL hash) plus a caption, and may replay the timeline up to a
// period. See stories/README.md for the format.
import { escapeHTML as esc } from "./format.js";
import { periodLabel } from "./time.js";

const $ = (s) => document.querySelector(s);
let hooks = null;
let index = null;
let story = null;
let step = 0;
let token = 0;

async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return r.json();
}

function loadIndex() {
  index ??= getJSON("stories/index.json").catch(() => ({ stories: [] }));
  return index;
}

/** hooks: {applyView(view), playTo(period, ms), stopPlay(), setMarkers(list), onChange()} */
export function initStories(h) {
  hooks = h;
  const dialog = $("#stories-dialog");
  $("#stories-btn").addEventListener("click", async () => {
    const { stories } = await loadIndex();
    $("#stories-list").innerHTML = stories.length
      ? stories.map((s) => `
        <li><button type="button" data-id="${esc(s.id)}">
          <b>${esc(s.title)}</b><span>${esc(s.summary)}</span>
        </button></li>`).join("")
      : "<li>No stories yet.</li>";
    dialog.showModal();
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
    story = { id, ...(await getJSON(`stories/${encodeURIComponent(id)}.json`)) };
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
  await hooks.applyView(s.view);
  if (my !== token || !s.play || !replay) return;
  setPlaying(true);
  await hooks.playTo(s.play.to, s.play.ms);
  if (my === token) setPlaying(false);
}

function setPlaying(on) {
  const el = $("#story .story-replay");
  if (el) el.textContent = on ? "Replaying…" : `↻ Replay ${periodLabel(story.steps[step].view.t)} → ${periodLabel(story.steps[step].play.to)}`;
}

/** Captions are plain text; **bold** is the only markup. */
function inline(text) {
  return esc(text).replace(/\*\*(.+?)\*\*/g, "<b>$1</b>");
}

function render(s) {
  const n = story.steps.length;
  const el = $("#story");
  el.innerHTML = `
    <div class="story-head">
      <span class="kicker">${esc(story.title)} · ${step + 1} / ${n}</span>
      <button type="button" class="story-close" aria-label="Exit story">✕</button>
    </div>
    <h3>${esc(s.title)}</h3>
    ${(Array.isArray(s.text) ? s.text : [s.text]).map((p) => `<p>${inline(p)}</p>`).join("")}
    ${s.play ? `<button type="button" class="story-replay linklike"></button>` : ""}
    <div class="story-nav">
      <button type="button" class="btn" data-go="-1" ${step === 0 ? "disabled" : ""}>← Back</button>
      <div class="dots">${story.steps.map((_, i) => `<button type="button" data-step="${i}" aria-label="Step ${i + 1}" class="${i === step ? "on" : ""}"></button>`).join("")}</div>
      ${step < n - 1
        ? `<button type="button" class="btn primary" data-go="1">Next →</button>`
        : `<button type="button" class="btn primary" data-end>Explore</button>`}
    </div>
    ${story.sources?.length ? `<details class="story-sources"><summary>Sources</summary><ul>${story.sources.map((src) =>
      `<li><a href="${esc(src.url)}" target="_blank" rel="noopener">${esc(src.name)}</a></li>`).join("")}</ul></details>` : ""}`;
  if (s.play) setPlaying(false);
  el.querySelector(".story-close").onclick = stopStory;
  el.querySelectorAll("[data-go]").forEach((b) => { b.onclick = () => goTo(step + +b.dataset.go); });
  el.querySelectorAll("[data-step]").forEach((b) => { b.onclick = () => goTo(+b.dataset.step); });
  el.querySelector("[data-end]")?.addEventListener("click", stopStory);
  el.querySelector(".story-replay")?.addEventListener("click", () => goTo(step));
}

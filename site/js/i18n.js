// Interface language. Each language has a file i18n/<lang>.json with:
//   "ui":    interface strings by key. Strings may contain HTML; t() fills {name} placeholders with the
//            values as given, so callers escape anything that isn't trusted markup.
//   "names": (not English) translated names of data items, by kind: entities, regions, groups
//            ({name, short, note}), products and indicators ({name, description}). Anything missing
//            falls back to the English name in the data files.
// The language comes from ?lang=, then the visitor's saved choice, then the browser's languages.

export const LANGS = { en: "English", zh: "中文" };
const HTML_LANG = { en: "en", zh: "zh-Hans" };

let lang = "en";
let dict = {};
let base = {};

function detect() {
  const q = new URLSearchParams(location.search).get("lang");
  if (LANGS[q]) return q;
  try {
    const saved = localStorage.getItem("lang");
    if (LANGS[saved]) return saved;
  } catch { /* storage blocked */ }
  for (const l of navigator.languages ?? [navigator.language]) {
    const code = l?.toLowerCase().split("-")[0];
    if (LANGS[code]) return code;
  }
  return "en";
}

async function load(l) {
  const r = await fetch(`i18n/${l}.json`);
  if (!r.ok) throw new Error(`i18n/${l}.json: ${r.status}`);
  return r.json();
}

export async function initI18n() {
  lang = detect();
  [base, dict] = await Promise.all([load("en"), lang === "en" ? null : load(lang).catch(() => null)]);
  if (!dict) { dict = base; lang = "en"; }
  document.documentElement.lang = HTML_LANG[lang];
  translateDOM();
}

export function getLang() {
  return lang;
}

/** Interface string `key` with {placeholders} filled from `vars`. */
export function t(key, vars = {}) {
  const s = dict.ui?.[key] ?? base.ui?.[key];
  if (s == null) {
    console.warn(`i18n: missing string "${key}"`);
    return key;
  }
  return s.replace(/\{(\w+)\}/g, (m, k) => (vars[k] ?? m));
}

/** Whether interface string `key` exists (for optional, data-specific notes). */
export function has(key) {
  return (dict.ui?.[key] ?? base.ui?.[key]) != null;
}

/** Translated name of a data item (e.g. names("entities", "CHN")), or undefined to use the data's English. */
export function names(kind, id) {
  return dict.names?.[kind]?.[id];
}

/** Switch language: remembers the choice and reloads with ?lang= so the link can be shared. */
export function setLang(l) {
  try { localStorage.setItem("lang", l); } catch { /* storage blocked */ }
  const u = new URL(location.href);
  if (l === "en") u.searchParams.delete("lang");
  else u.searchParams.set("lang", l);
  location.assign(u);
}

/** Static text in index.html: data-i18n="key" sets the content, data-i18n-attr="title:key;aria-label:key" attributes. */
function translateDOM() {
  document.title = t("site.title");
  document.querySelector('meta[name="description"]')?.setAttribute("content", t("site.description"));
  for (const el of document.querySelectorAll("[data-i18n]")) el.innerHTML = t(el.dataset.i18n);
  for (const el of document.querySelectorAll("[data-i18n-attr]")) {
    for (const pair of el.dataset.i18nAttr.split(";")) {
      const [attr, key] = pair.split(":");
      el.setAttribute(attr, t(key));
    }
  }
}

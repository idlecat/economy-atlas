"""Translations (site/i18n/, site/stories/<lang>/) stay complete and in step with the English originals."""
import csv
import json
import re

import pytest

from pipeline.paths import CONFIG, ROOT

SITE = ROOT / "site"
LANGS = ["zh"]


def load(path):
    return json.loads(path.read_text(encoding="utf-8"))


def placeholders(s):
    return set(re.findall(r"\{(\w+)\}", s))


@pytest.mark.parametrize("lang", LANGS)
def test_ui_strings_match_english(lang):
    en, tr = load(SITE / "i18n/en.json")["ui"], load(SITE / f"i18n/{lang}.json")["ui"]
    assert set(tr) == set(en), f"missing: {set(en) - set(tr)}, extra: {set(tr) - set(en)}"
    for key, s in en.items():
        if s:  # an empty English string means the text only exists in translations
            assert placeholders(tr[key]) == placeholders(s), key


@pytest.mark.parametrize("lang", LANGS)
def test_data_names_are_translated(lang):
    names = load(SITE / f"i18n/{lang}.json")["names"]
    with open(CONFIG / "entities.csv", newline="", encoding="utf-8") as f:
        entities = {row["id"] for row in csv.DictReader(f)}
    groups = {g["id"] for g in load(CONFIG / "groups.json")["groups"]}
    products = load(CONFIG / "products.json")
    product_ids = {p["id"] for p in products["sectors"] + products["commodities"]}
    indicators = {i["id"] for i in load(CONFIG / "indicators.json")["indicators"]}
    assert entities - set(names["entities"]) == set()
    assert groups - set(names["groups"]) == set()
    assert product_ids - set(names["products"]) == set()
    assert indicators - set(names["indicators"]) == set()


def skeleton(story):
    """Everything in a story except its words: translations must show exactly the same views."""
    return {
        "markers": [m["t"] for m in story.get("markers", [])],
        "sources": [s["url"] for s in story.get("sources", [])],
        "steps": [(s["view"], s.get("play"), s.get("panel")) for s in story["steps"]],
    }


@pytest.mark.parametrize("lang", LANGS)
def test_stories_are_translated_with_the_same_views(lang):
    en_index = load(SITE / "stories/index.json")["stories"]
    tr_index = load(SITE / f"stories/{lang}/index.json")["stories"]
    assert [s["id"] for s in tr_index] == [s["id"] for s in en_index]
    for s in en_index:
        en = load(SITE / f"stories/{s['id']}.json")
        tr = load(SITE / f"stories/{lang}/{s['id']}.json")
        assert skeleton(tr) == skeleton(en), s["id"]


def test_story_links_point_to_known_entities():
    with open(CONFIG / "entities.csv", newline="", encoding="utf-8") as f:
        known = {row["id"] for row in csv.DictReader(f)}
    known |= {g["id"] for g in load(CONFIG / "groups.json")["groups"]}
    for path in [p for p in (SITE / "stories").rglob("*.json") if p.name != "index.json"]:
        for step in load(path)["steps"]:
            for text in step["text"] if isinstance(step["text"], list) else [step["text"]]:
                for code in re.findall(r"\[[^\]]+\]\(([A-Z0-9_]+)\)", text):
                    assert code in known, f"{path.name}: unknown link target {code}"

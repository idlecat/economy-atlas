"""Check that figures quoted in stories still match the published data (site/data).

Stories quote numbers computed from this site's data (site/stories/README.md). Data refreshes revise
them, so each quoted figure is listed in CLAIMS below with how to compute it. For every claim the
checker
  - finds the English snippet in that step's text and parses its number and unit,
  - recomputes the value and accepts it within the rounding of the written number
    ("37%" allows 36.5-37.5, "$1.6 trillion" allows ±$0.05 trillion, "$610" allows ±5),
  - requires every translation of the step to contain a number that matches the same way.
Facts from other sources (cited in a story's `sources`) are not listed here.

Run: python -m pipeline check-stories   (after publish; exits non-zero on any mismatch)
"""
import json
import math
import re
from dataclasses import dataclass
from functools import cache
from typing import Callable

from .paths import ROOT, SITE_DATA

STORIES = ROOT / "site" / "stories"
LANGS = ["zh"]


# --------------------------------------------------------------------------- site data

class Site:
    """Reads site/data the way the website does. Values are USD millions."""

    def __init__(self, data=SITE_DATA):
        self.d = data
        self.meta = json.loads((data / "meta.json").read_text())
        self.ind = json.loads((data / "indicators.json").read_text())
        self.bil = json.loads((data / "bilateral.json").read_text())
        self.groups = {g["id"]: g for g in self.meta["groups"]}
        self.lists = {l["id"]: l for l in self.meta.get("lists", [])}

    @cache
    def totals(self, freq="A", product="TOTAL"):
        base = self.d / freq if product == "TOTAL" else self.d / "products" / product / freq
        return json.loads((base / "totals.json").read_text())

    @cache
    def flows(self, code, freq="A", product="TOTAL"):
        base = self.d / freq if product == "TOTAL" else self.d / "products" / product / freq
        return json.loads((base / "flows" / f"{code}.json").read_text())["p"]

    def periods(self, freq="A", product="TOTAL"):
        return self.meta["periods"][freq] if product == "TOTAL" else self.meta["products"]["periods"][freq]

    def members(self, group, year):
        return [m["id"] for m in self.groups[group]["members"]
                if m.get("from", -9999) <= year <= m.get("to", 9999)]

    # -- trade
    def v(self, code, period, flow="x", freq="A", product="TOTAL"):
        """Trade of an entity (or group: extra-group) with the world: x, m, b (balance) or t (total)."""
        s, i = self.totals(freq, product).get(code), self.periods(freq, product).index(period)
        if s is None:
            return None
        x, m = s[0][i], s[1][i]
        return {"x": x, "m": m, "b": None if x is None or m is None else x - m, "t": (x or 0) + (m or 0)}[flow]

    def pv(self, code, partner, period, flow="x", freq="A", product="TOTAL"):
        """Trade of `code` with `partner` as reported by `code`; a group partner sums its members that year."""
        p, i = self.flows(code, freq, product), self.periods(freq, product).index(period)
        k = 0 if flow == "x" else 1
        keys = self.members(partner, int(period[:4])) if partner in self.groups else [partner]
        vals = [p[q][k][i] for q in keys if q in p and p[q][k][i] is not None]
        return sum(vals) if vals else None

    def world(self, period, flow="x", freq="A", product="TOTAL"):
        i, k = self.periods(freq, product).index(period), 0 if flow == "x" else 1
        return sum(s[k][i] or 0 for c, s in self.totals(freq, product).items() if c not in self.groups)

    def change(self, a, b):
        """% change from b to a."""
        return None if a is None or not b else (a / b - 1) * 100

    def yoy(self, code, period, flow="x", freq="M"):
        y = f"{int(period[:4]) - 1}{period[4:]}"
        return self.change(self.v(code, period, flow, freq), self.v(code, y, flow, freq))

    def pyoy(self, code, partner, period, flow="x", freq="M"):
        y = f"{int(period[:4]) - 1}{period[4:]}"
        return self.change(self.pv(code, partner, period, flow, freq), self.pv(code, partner, y, flow, freq))

    def wyoy(self, period, flow="x", freq="M"):
        y = f"{int(period[:4]) - 1}{period[4:]}"
        return self.change(self.world(period, flow, freq), self.world(y, flow, freq))

    def share(self, code, partner, period, flow="x", product="TOTAL"):
        """Partner's share (%) of code's trade with the world."""
        return 100 * self.pv(code, partner, period, flow, "A", product) / self.v(code, period, flow, "A", product)

    # -- indicators and bilateral measures
    def i(self, indicator, code, year):
        j = self.ind["periods"].index(str(year))
        return (self.ind["values"][indicator].get(code) or [None] * len(self.ind["periods"]))[j]

    def b(self, measure, cp, code, year):
        j = self.bil["periods"].index(str(year))
        return (self.bil["values"][measure][cp].get(code) or [None] * len(self.bil["periods"]))[j]

    def bsum(self, measure, cp, year, codes=None):
        """Sum over individual countries (not groups), optionally only `codes`."""
        j = self.bil["periods"].index(str(year))
        return sum(s[j] for e, s in self.bil["values"][measure][cp].items()
                   if e not in self.groups and s[j] and (codes is None or e in codes))

    # -- lists
    def list_split(self, code, period, flow="x", product="TOTAL", lst="BRI"):
        """(members, others) sums of code's partner flows."""
        mem = set(self.lists[lst]["members"])
        p, i, k = self.flows(code, "A", product), self.periods("A", product).index(period), 0 if flow == "x" else 1
        a = sum(s[k][i] or 0 for q, s in p.items() if q in mem)
        b = sum(s[k][i] or 0 for q, s in p.items() if q not in mem)
        return a, b

    # -- trade by product (the panel's "What X trades" list)
    @cache
    def breakdown(self, code):
        return json.loads((self.d / "products" / "breakdown" / f"{code}.json").read_text())

    def mix(self, code, product, period, flow="x"):
        """Product's share (%) of code's trade summed over all sectors."""
        bd, i, k = self.breakdown(code), self.periods("A", "SECTORS").index(period), 0 if flow == "x" else 1
        total = sum(bd[p["id"]][k][i] or 0 for p in self.meta["products"]["sectors"] if p["id"] in bd)
        return 100 * bd[product][k][i] / total

    def list_share(self, code, period, flow="x", product="TOTAL", lst="BRI"):
        a, b = self.list_split(code, period, flow, product, lst)
        return 100 * a / (a + b)

    # -- Compare view (compare.js): one point per economy, merged groups as one point
    def compare(self, xid, yid, year, groups=("EU",)):
        def merged(code):
            return any(g in groups and code in self.members(g, year) for g in self.groups)
        keys = set(groups) | {c for c in set(self.totals()) | set(self.ind["values"]["gdp"])
                              if c in self.meta["entities"] and not merged(c)}
        pts = {}
        for k in keys:
            x, y = self.metric(xid, k, year), self.metric(yid, k, year)
            if x is not None and y is not None and x > 0 and y > 0:  # all metrics used here are on log axes
                pts[k] = (x, y)
        xs = [math.log10(x) for x, _ in pts.values()]
        ys = [math.log10(y) for _, y in pts.values()]
        return pts, pearson(xs, ys)

    def metric(self, mid, key, year):
        if mid == "exports":
            return self.v(key, str(year)) if str(year) in self.periods() else None
        if mid == "exports_gdp":
            x, g = self.metric("exports", key, year), self.i("gdp", key, year)
            return None if x is None or not g else 100 * x / g
        return self.i(mid, key, year)

    def rank(self, xid, key, year, by="x", groups=("EU",)):
        pts, _ = self.compare(xid, xid, year, groups)
        order = sorted(pts, key=lambda k: -pts[k][0])
        return order.index(key) + 1


def pearson(xs, ys):
    n = len(xs)
    mx, my = sum(xs) / n, sum(ys) / n
    sxy = sum((a - mx) * (b - my) for a, b in zip(xs, ys))
    sxx = sum((a - mx) ** 2 for a in xs)
    syy = sum((b - my) ** 2 for b in ys)
    return sxy / math.sqrt(sxx * syy)


# --------------------------------------------------------------------------- claims

@dataclass
class Claim:
    story: str
    step: int        # 1-based
    en: str          # snippet as written in the English text (markup removed)
    kind: str        # usd (USD millions; "$1.6 trillion"), usd_pc (plain dollars; "$13,300"), pct, num
    value: Callable  # Site -> number, in the same sign convention as the text


def C(story, step, en, kind, value):
    return Claim(story, step, en, kind, value)


def neg(x):
    return None if x is None else -x


CLAIMS = [
    # Asian financial crisis
    C("asia-1997", 1, "$74.9 billion", "usd", lambda s: s.v("THA", "1996", "m")),
    C("asia-1997", 1, "$56.5 billion", "usd", lambda s: s.v("THA", "1996", "x")),
    C("asia-1997", 1, "$18.5 billion", "usd", lambda s: neg(s.v("THA", "1996", "b"))),
    C("asia-1997", 1, "$12.5 billion", "usd", lambda s: neg(s.v("KOR", "1996", "b"))),
    C("asia-1997", 3, "−35%", "pct", lambda s: s.change(s.v("KOR", "1998", "m"), s.v("KOR", "1997", "m"))),
    C("asia-1997", 3, "−31%", "pct", lambda s: s.change(s.v("THA", "1998", "m"), s.v("THA", "1997", "m"))),
    C("asia-1997", 3, "−34%", "pct", lambda s: s.change(s.v("IDN", "1998", "m"), s.v("IDN", "1997", "m"))),
    C("asia-1997", 3, "−26%", "pct", lambda s: s.change(s.v("MYS", "1998", "m"), s.v("MYS", "1997", "m"))),
    C("asia-1997", 3, "fell 8%", "pct", lambda s: neg(s.change(s.v("KOR", "1998"), s.v("KOR", "1997")))),
    C("asia-1997", 3, "Thailand's 5%", "pct", lambda s: neg(s.change(s.v("THA", "1998"), s.v("THA", "1997")))),
    C("asia-1997", 4, "$39.4 billion", "usd", lambda s: s.v("KOR", "1998", "b")),
    C("asia-1997", 4, "−$18.5 billion", "usd", lambda s: s.v("THA", "1996", "b")),
    C("asia-1997", 4, "+$11.7 billion", "usd", lambda s: s.v("THA", "1998", "b")),
    C("asia-1997", 5, "13.1%", "pct", lambda s: neg(s.i("gdp_growth", "IDN", 1998))),
    C("asia-1997", 5, "7.6%", "pct", lambda s: neg(s.i("gdp_growth", "THA", 1998))),
    C("asia-1997", 5, "7.4%", "pct", lambda s: neg(s.i("gdp_growth", "MYS", 1998))),
    C("asia-1997", 5, "4.9%", "pct", lambda s: neg(s.i("gdp_growth", "KOR", 1998))),
    C("asia-1997", 5, "$227 billion", "usd", lambda s: s.i("gdp", "IDN", 1996)),
    C("asia-1997", 5, "$95.5 billion", "usd", lambda s: s.i("gdp", "IDN", 1998)),
    C("asia-1997", 5, "11.6%", "pct", lambda s: s.i("gdp_growth", "KOR", 1999)),
    # Great trade collapse
    C("crisis-2008", 1, "$1.6 trillion", "usd", lambda s: s.world("2008-07", "x", "M")),
    C("crisis-2008", 2, "19%", "pct", lambda s: s.wyoy("2008-09")),
    C("crisis-2008", 3, "33%", "pct", lambda s: neg(s.wyoy("2009-02"))),
    C("crisis-2008", 3, "36%", "pct", lambda s: neg(s.wyoy("2009-04"))),
    C("crisis-2008", 4, "41%", "pct", lambda s: neg(s.yoy("JPN", "2009-02"))),
    C("crisis-2008", 4, "44%", "pct", lambda s: neg(s.yoy("JPN", "2009-03"))),
    C("crisis-2008", 4, "−34%", "pct", lambda s: s.yoy("DEU", "2009-02")),
    C("crisis-2008", 5, "56%", "pct", lambda s: neg(s.yoy("GCC", "2009-05"))),
    C("crisis-2008", 5, "−50%", "pct", lambda s: s.yoy("RUS", "2009-05")),
    C("crisis-2008", 6, "−26%", "pct", lambda s: s.yoy("CHN", "2009-05")),
    C("crisis-2008", 6, "36%", "pct", lambda s: neg(s.yoy("USA", "2009-05", "m"))),
    C("crisis-2008", 7, "+6%", "pct", lambda s: s.wyoy("2009-11")),
    C("crisis-2008", 8, "$16.3 trillion", "usd", lambda s: s.world("2008")),
    C("crisis-2008", 8, "$12.4 trillion", "usd", lambda s: s.world("2009")),
    C("crisis-2008", 8, "−24%", "pct", lambda s: s.change(s.world("2009"), s.world("2008"))),
    C("crisis-2008", 8, "$15.3 trillion", "usd", lambda s: s.world("2010")),
    C("crisis-2008", 8, "$18.3 trillion", "usd", lambda s: s.world("2011")),
    # Euro area debt crisis
    C("euro-crisis", 1, "$95.0 billion", "usd", lambda s: s.v("GRC", "2008", "m")),
    C("euro-crisis", 1, "$30.8 billion", "usd", lambda s: s.v("GRC", "2008", "x")),
    C("euro-crisis", 1, "$51.3 billion", "usd", lambda s: neg(s.i("current_account", "GRC", 2008))),
    C("euro-crisis", 1, "$144 billion", "usd", lambda s: neg(s.i("current_account", "ESP", 2008))),
    C("euro-crisis", 2, "$61.4 billion", "usd", lambda s: s.v("GRC", "2012", "m")),
    C("euro-crisis", 2, "−35%", "pct", lambda s: s.change(s.v("GRC", "2012", "m"), s.v("GRC", "2008", "m"))),
    C("euro-crisis", 3, "9.9%", "pct", lambda s: neg(s.i("gdp_growth", "GRC", 2011))),
    C("euro-crisis", 3, "7.7%", "pct", lambda s: s.i("unemployment", "GRC", 2008)),
    C("euro-crisis", 3, "27.7%", "pct", lambda s: s.i("unemployment", "GRC", 2013)),
    C("euro-crisis", 3, "11.2%", "pct", lambda s: s.i("unemployment", "ESP", 2008)),
    C("euro-crisis", 3, "26.1%", "pct", lambda s: s.i("unemployment", "ESP", 2013)),
    C("euro-crisis", 4, "−$144 billion", "usd", lambda s: s.i("current_account", "ESP", 2008)),
    C("euro-crisis", 4, "+$28.3 billion", "usd", lambda s: s.i("current_account", "ESP", 2013)),
    C("euro-crisis", 4, "−$65.0 billion", "usd", lambda s: s.i("current_account", "ITA", 2008)),
    C("euro-crisis", 4, "+$22.4 billion", "usd", lambda s: s.i("current_account", "ITA", 2013)),
    C("euro-crisis", 4, "−$31.2 billion", "usd", lambda s: s.i("current_account", "PRT", 2008)),
    C("euro-crisis", 4, "+$3.5 billion", "usd", lambda s: s.i("current_account", "PRT", 2013)),
    C("euro-crisis", 4, "$5.0 billion", "usd", lambda s: neg(s.i("current_account", "GRC", 2013))),
    C("euro-crisis", 4, "$206 billion", "usd", lambda s: s.i("current_account", "DEU", 2008)),
    C("euro-crisis", 4, "$250 billion", "usd", lambda s: s.i("current_account", "DEU", 2013)),
    C("euro-crisis", 5, "$221 billion", "usd", lambda s: s.v("ESP", "2009")),
    C("euro-crisis", 5, "$306 billion", "usd", lambda s: s.v("ESP", "2013")),
    # Oil price collapse
    C("oil-2014", 1, "$1.49 trillion", "usd", lambda s: s.world("2014", product="CRUDE")),
    C("oil-2014", 2, "$808 billion", "usd", lambda s: s.world("2015", product="CRUDE")),
    C("oil-2014", 2, "−46%", "pct", lambda s: s.change(s.world("2015", product="CRUDE"), s.world("2014", product="CRUDE"))),
    C("oil-2014", 2, "$689 billion", "usd", lambda s: s.world("2016", product="CRUDE")),
    C("oil-2014", 3, "53%", "pct", lambda s: neg(s.change(s.v("SAU", "2016"), s.v("SAU", "2014")))),
    C("oil-2014", 3, "$443 billion", "usd", lambda s: s.v("SAU", "2014")),
    C("oil-2014", 3, "$207 billion", "usd", lambda s: s.v("SAU", "2016")),
    C("oil-2014", 3, "65%", "pct", lambda s: neg(s.change(s.v("NGA", "2016"), s.v("NGA", "2014")))),
    C("oil-2014", 3, "64%", "pct", lambda s: neg(s.change(s.v("VEN", "2016"), s.v("VEN", "2014")))),
    C("oil-2014", 3, "43%", "pct", lambda s: neg(s.change(s.v("RUS", "2016"), s.v("RUS", "2014")))),
    C("oil-2014", 3, "39%", "pct", lambda s: neg(s.change(s.v("NOR", "2016"), s.v("NOR", "2014")))),
    C("oil-2014", 4, "6.2%", "pct", lambda s: neg(s.i("gdp_growth", "VEN", 2015))),
    C("oil-2014", 4, "17.1%", "pct", lambda s: neg(s.i("gdp_growth", "VEN", 2016))),
    C("oil-2014", 4, "$18.9 trillion", "usd", lambda s: s.world("2014")),
    C("oil-2014", 4, "$15.9 trillion", "usd", lambda s: s.world("2016")),
    C("oil-2014", 4, "−16%", "pct", lambda s: s.change(s.world("2016"), s.world("2014"))),
    # US-China trade war
    C("trade-war", 1, "$505 billion", "usd", lambda s: s.pv("USA", "CHN", "2017", "m")),
    C("trade-war", 1, "21.6%", "pct", lambda s: s.share("USA", "CHN", "2017", "m")),
    C("trade-war", 1, "$435 billion", "usd", lambda s: s.pv("USA", "EU", "2017", "m")),
    C("trade-war", 2, "$538 billion", "usd", lambda s: s.pv("USA", "CHN", "2018", "m")),
    C("trade-war", 2, "$449 billion", "usd", lambda s: s.pv("USA", "CHN", "2019", "m")),
    C("trade-war", 2, "−17%", "pct", lambda s: s.change(s.pv("USA", "CHN", "2019", "m"), s.pv("USA", "CHN", "2018", "m"))),
    C("trade-war", 3, "$13.9 billion", "usd", lambda s: s.pv("USA", "CHN", "2016", "x", product="SOYBEANS")),
    C("trade-war", 3, "$7.1 billion", "usd", lambda s: s.pv("USA", "CHN", "2018", "x", product="SOYBEANS")),
    C("trade-war", 3, "$14.5 billion", "usd", lambda s: s.pv("CHN", "BRA", "2016", "m", product="SOYBEANS")),
    C("trade-war", 3, "$27.0 billion", "usd", lambda s: s.pv("CHN", "BRA", "2018", "m", product="SOYBEANS")),
    C("trade-war", 4, "62%", "pct", lambda s: s.change(s.pv("USA", "MEX", "2024", "m"), s.pv("USA", "MEX", "2017", "m"))),
    C("trade-war", 4, "$506 billion", "usd", lambda s: s.pv("USA", "MEX", "2024", "m")),
    C("trade-war", 4, "$137 billion", "usd", lambda s: s.pv("USA", "VNM", "2024", "m")),
    C("trade-war", 4, "21.6%", "pct", lambda s: s.share("USA", "CHN", "2017", "m")),
    C("trade-war", 4, "13.4%", "pct", lambda s: s.share("USA", "CHN", "2024", "m")),
    # COVID-19
    C("covid-2020", 1, "10.5%", "pct", lambda s: neg(s.wyoy("2020-03"))),
    C("covid-2020", 2, "26% lower", "pct", lambda s: neg(s.wyoy("2020-04"))),
    C("covid-2020", 2, "27% lower", "pct", lambda s: neg(s.wyoy("2020-05"))),
    C("covid-2020", 2, "61%", "pct", lambda s: neg(s.yoy("IND", "2020-04"))),
    C("covid-2020", 2, "57%", "pct", lambda s: neg(s.yoy("MEX", "2020-05"))),
    C("covid-2020", 2, "36%", "pct", lambda s: neg(s.yoy("USA", "2020-05"))),
    C("covid-2020", 2, "3% higher", "pct", lambda s: s.yoy("CHN", "2020-04")),
    C("covid-2020", 3, "8%", "pct", lambda s: s.wyoy("2020-12")),
    C("covid-2020", 3, "fell 7%", "pct", lambda s: neg(s.change(s.world("2020"), s.world("2019")))),
    C("covid-2020", 3, "$17.6 trillion", "usd", lambda s: s.world("2020")),
    C("covid-2020", 3, "27%", "pct", lambda s: s.change(s.world("2021"), s.world("2020"))),
    C("covid-2020", 3, "$22.3 trillion", "usd", lambda s: s.world("2021")),
    C("covid-2020", 4, "9.2%", "pct", lambda s: s.change(s.world("2020", product="PHARMA"), s.world("2019", product="PHARMA"))),
    C("covid-2020", 4, "$682 billion", "usd", lambda s: s.world("2020", product="PHARMA")),
    C("covid-2020", 4, "8.8%", "pct", lambda s: s.change(s.world("2020", product="CHIPS"), s.world("2019", product="CHIPS"))),
    C("covid-2020", 4, "$867 billion", "usd", lambda s: s.world("2020", product="CHIPS")),
    C("covid-2020", 5, "6.4%", "pct", lambda s: neg(s.i("gdp_growth", "EU", 2020))),
    C("covid-2020", 5, "5.8%", "pct", lambda s: neg(s.i("gdp_growth", "IND", 2020))),
    C("covid-2020", 5, "2.1%", "pct", lambda s: neg(s.i("gdp_growth", "USA", 2020))),
    C("covid-2020", 5, "10.1%", "pct", lambda s: neg(s.i("gdp_growth", "GBR", 2020))),
    C("covid-2020", 5, "2.3%", "pct", lambda s: s.i("gdp_growth", "CHN", 2020)),
    # Russian oil
    C("russia-oil", 1, "$115 billion", "usd", lambda s: s.v("RUS", "2021", product="CRUDE")),
    C("russia-oil", 1, "46%", "pct", lambda s: s.share("RUS", "EU", "2021", product="CRUDE")),
    C("russia-oil", 1, "China 31%", "pct", lambda s: s.share("RUS", "CHN", "2021", product="CRUDE")),
    C("russia-oil", 1, "barely 1%", "pct", lambda s: s.share("RUS", "IND", "2021", product="CRUDE")),
    C("russia-oil", 2, "$148 billion", "usd", lambda s: s.v("RUS", "2022", product="CRUDE")),
    C("russia-oil", 2, "38%", "pct", lambda s: s.share("RUS", "EU", "2022", product="CRUDE")),
    C("russia-oil", 2, "17%", "pct", lambda s: s.share("RUS", "IND", "2022", product="CRUDE")),
    C("russia-oil", 3, "5%", "pct", lambda s: s.share("RUS", "EU", "2024", product="CRUDE")),
    C("russia-oil", 3, "$7 billion", "usd", lambda s: s.pv("RUS", "EU", "2024", product="CRUDE")),
    C("russia-oil", 3, "50%", "pct", lambda s: s.share("RUS", "CHN", "2024", product="CRUDE")),
    C("russia-oil", 3, "$63 billion", "usd", lambda s: s.pv("RUS", "CHN", "2024", product="CRUDE")),
    C("russia-oil", 3, "42%", "pct", lambda s: s.share("RUS", "IND", "2024", product="CRUDE")),
    C("russia-oil", 3, "$53 billion", "usd", lambda s: s.pv("RUS", "IND", "2024", product="CRUDE")),
    C("russia-oil", 4, "1%", "pct", lambda s: s.share("IND", "RUS", "2021", "m", product="CRUDE")),
    C("russia-oil", 4, "37%", "pct", lambda s: s.share("IND", "RUS", "2024", "m", product="CRUDE")),
    # Europe's energy crisis
    C("energy-2022", 1, "$109 billion", "usd", lambda s: s.v("EU", "2021", "m", product="GAS")),
    C("energy-2022", 1, "35%", "pct", lambda s: s.share("EU", "NOR", "2021", "m", product="GAS")),
    C("energy-2022", 1, "28%", "pct", lambda s: s.share("EU", "RUS", "2021", "m", product="GAS")),
    C("energy-2022", 1, "8%", "pct", lambda s: s.share("EU", "USA", "2021", "m", product="GAS")),
    C("energy-2022", 2, "$314 billion", "usd", lambda s: s.v("EU", "2022", "m", product="GAS")),
    C("energy-2022", 2, "2.9 times", "num", lambda s: s.v("EU", "2022", "m", product="GAS") / s.v("EU", "2021", "m", product="GAS")),
    C("energy-2022", 2, "18%", "pct", lambda s: s.share("EU", "RUS", "2022", "m", product="GAS")),
    C("energy-2022", 2, "$37.6 billion", "usd", lambda s: s.pv("EU", "USA", "2022", "m", product="GAS")),
    C("energy-2022", 3, "$112 billion", "usd", lambda s: s.v("EU", "2024", "m", product="GAS")),
    C("energy-2022", 3, "17%", "pct", lambda s: s.share("EU", "USA", "2024", "m", product="GAS")),
    C("energy-2022", 3, "(16%)", "pct", lambda s: s.share("EU", "RUS", "2024", "m", product="GAS")),
    C("energy-2022", 3, "35%", "pct", lambda s: s.share("EU", "NOR", "2024", "m", product="GAS")),
    C("energy-2022", 4, "$50 billion", "usd", lambda s: s.v("EU", "2021", "b")),
    C("energy-2022", 4, "$492 billion", "usd", lambda s: neg(s.v("EU", "2022", "b"))),
    C("energy-2022", 4, "85%", "pct", lambda s: s.change(s.v("EU", "2022", "m", product="ENERGY"), s.v("EU", "2021", "m", product="ENERGY"))),
    C("energy-2022", 4, "$829 billion", "usd", lambda s: s.v("EU", "2022", "m", product="ENERGY")),
    C("energy-2022", 4, "$102 billion", "usd", lambda s: s.v("EU", "2024", "b")),
    C("energy-2022", 4, "$213 billion", "usd", lambda s: s.v("DEU", "2021", "b")),
    C("energy-2022", 4, "$84 billion", "usd", lambda s: s.v("DEU", "2022", "b")),
    # 2025 US tariffs
    C("tariffs-2025", 1, "25%", "pct", lambda s: s.yoy("USA", "2025-01", "m")),
    C("tariffs-2025", 1, "32%", "pct", lambda s: s.yoy("USA", "2025-03", "m")),
    C("tariffs-2025", 1, "$343 billion", "usd", lambda s: s.v("USA", "2025-03", "m", "M")),
    C("tariffs-2025", 2, "42% lower", "pct", lambda s: neg(s.pyoy("USA", "CHN", "2025-05", "m"))),
    C("tariffs-2025", 2, "44% lower", "pct", lambda s: neg(s.pyoy("USA", "CHN", "2025-06", "m"))),
    C("tariffs-2025", 3, "30%", "pct", lambda s: neg(s.change(s.pv("USA", "CHN", "2025", "m"), s.pv("USA", "CHN", "2024", "m")))),
    C("tariffs-2025", 3, "$308 billion", "usd", lambda s: s.pv("USA", "CHN", "2025", "m")),
    C("tariffs-2025", 3, "9.0%", "pct", lambda s: s.share("USA", "CHN", "2025", "m")),
    C("tariffs-2025", 3, "73%", "pct", lambda s: s.change(s.pv("USA", "TWN", "2025", "m"), s.pv("USA", "TWN", "2024", "m"))),
    C("tariffs-2025", 3, "$201 billion", "usd", lambda s: s.pv("USA", "TWN", "2025", "m")),
    C("tariffs-2025", 3, "42%", "pct", lambda s: s.change(s.pv("USA", "VNM", "2025", "m"), s.pv("USA", "VNM", "2024", "m"))),
    C("tariffs-2025", 3, "$194 billion", "usd", lambda s: s.pv("USA", "VNM", "2025", "m")),
    C("tariffs-2025", 3, "4.6%", "pct", lambda s: s.change(s.v("USA", "2025", "m"), s.v("USA", "2024", "m"))),
    C("tariffs-2025", 3, "$3.42 trillion", "usd", lambda s: s.v("USA", "2025", "m")),
    C("tariffs-2025", 4, "5.5%", "pct", lambda s: s.change(s.v("CHN", "2025"), s.v("CHN", "2024"))),
    C("tariffs-2025", 4, "$3.78 trillion", "usd", lambda s: s.v("CHN", "2025")),
    C("tariffs-2025", 4, "fell 20%", "pct", lambda s: neg(s.change(s.pv("CHN", "USA", "2025"), s.pv("CHN", "USA", "2024")))),
    C("tariffs-2025", 4, "+22%", "pct", lambda s: s.change(s.pv("CHN", "VNM", "2025"), s.pv("CHN", "VNM", "2024"))),
    # Belt and Road
    C("belt-road", 1, "156 countries", "num", lambda s: len(s.lists["BRI"]["members"])),
    C("belt-road", 2, "37%", "pct", lambda s: s.list_share("CHN", "2012")),
    C("belt-road", 2, "48%", "pct", lambda s: s.list_share("CHN", "2024")),
    C("belt-road", 2, "129%", "pct", lambda s: s.change(s.list_split("CHN", "2024")[0], s.list_split("CHN", "2012")[0])),
    C("belt-road", 2, "$758 billion", "usd", lambda s: s.list_split("CHN", "2012")[0]),
    C("belt-road", 2, "$1.73 trillion", "usd", lambda s: s.list_split("CHN", "2024")[0]),
    C("belt-road", 2, "43%", "pct", lambda s: s.change(s.list_split("CHN", "2024")[1], s.list_split("CHN", "2012")[1])),
    C("belt-road", 3, "24%", "pct", lambda s: s.list_share("CHN", "2000")),
    C("belt-road", 3, "37%", "pct", lambda s: s.list_share("CHN", "2012")),
    C("belt-road", 3, "1.1 points", "num", lambda s: (s.list_share("CHN", "2012") - s.list_share("CHN", "2000")) / 12),
    C("belt-road", 3, "1 point a year after", "num", lambda s: (s.list_share("CHN", "2024") - s.list_share("CHN", "2012")) / 12),
    C("belt-road", 4, "96%", "pct", lambda s: s.list_share("CHN", "2024", "m", "CRUDE")),
    C("belt-road", 4, "88%", "pct", lambda s: s.list_share("CHN", "2024", "m", "COPPER")),
    C("belt-road", 4, "73%", "pct", lambda s: s.list_share("CHN", "2024", "m", "SOYBEANS")),
    C("belt-road", 4, "32%", "pct", lambda s: s.list_share("CHN", "2012", "x", "MACHINERY")),
    C("belt-road", 4, "42%", "pct", lambda s: s.list_share("CHN", "2024", "x", "MACHINERY")),
    C("belt-road", 4, "$4.0 billion", "usd", lambda s: s.list_split("CHN", "2012", "x", "CARS")[0]),
    C("belt-road", 4, "$53.3 billion", "usd", lambda s: s.list_split("CHN", "2024", "x", "CARS")[0]),
    C("belt-road", 5, "$64 billion", "usd", lambda s: s.bsum("debt", "CHN", 2012, set(s.lists["BRI"]["members"]))),
    C("belt-road", 5, "$189 billion", "usd", lambda s: s.bsum("debt", "CHN", 2021, set(s.lists["BRI"]["members"]))),
    C("belt-road", 5, "$170 billion", "usd", lambda s: s.bsum("debt", "CHN", 2024, set(s.lists["BRI"]["members"]))),
    C("belt-road", 5, "$103 billion", "usd", lambda s: s.bsum("debt", "JPN", 2012, set(s.lists["BRI"]["members"]))),
    C("belt-road", 5, "$83 billion", "usd", lambda s: s.bsum("debt", "JPN", 2024, set(s.lists["BRI"]["members"]))),
    C("belt-road", 5, "7.5%", "pct", lambda s: _bri_debt_share(s, 2024)),
    C("belt-road", 5, "(56%)", "pct", lambda s: 100 * s.b("debt", "CHN", "COG", 2024) / s.b("debt", "WLD", "COG", 2024)),
    C("belt-road", 5, "(53%)", "pct", lambda s: 100 * s.b("debt", "CHN", "LAO", 2024) / s.b("debt", "WLD", "LAO", 2024)),
    C("belt-road", 5, "(51%)", "pct", lambda s: 100 * s.b("debt", "CHN", "DJI", 2024) / s.b("debt", "WLD", "DJI", 2024)),
    C("belt-road", 6, "$313 billion", "usd", lambda s: s.bsum("fdi", "CHN", 2024, set(s.lists["BRI"]["members"]))),
    C("belt-road", 6, "$187 billion", "usd", lambda s: s.bsum("fdi", "CHN", 2018, set(s.lists["BRI"]["members"]))),
    C("belt-road", 6, "$85.8 billion", "usd", lambda s: s.b("fdi", "CHN", "SGP", 2024)),
    C("belt-road", 6, "18%", "pct", lambda s: 100 * s.bsum("fdi", "CHN", 2024, set(s.lists["BRI"]["members"])) / _fdi_abroad(s, 2024)),
    C("belt-road", 6, "$1.78 trillion", "usd", lambda s: _fdi_abroad(s, 2024)),
    # China's rise as an exporter (Compare view: EU merged, as in the story's views)
    C("china-rise", 1, "168", "num", lambda s: len(s.compare("gdp", "exports", 2024)[0])),
    C("china-rise", 1, "r = 0.93", "num", lambda s: s.compare("gdp", "exports", 2024)[1]),
    C("china-rise", 2, "r = 0.29", "num", lambda s: s.compare("gdp_pc", "exports", 2024)[1]),
    C("china-rise", 2, "$3.58 trillion", "usd", lambda s: s.v("CHN", "2024")),
    C("china-rise", 2, "51st", "num", lambda s: _rank(s, "gdp_pc", "exports", "CHN", 2024, 0)),
    C("china-rise", 2, "$13,300", "usd_pc", lambda s: s.i("gdp_pc", "CHN", 2024)),
    C("china-rise", 3, "$610", "usd_pc", lambda s: s.i("gdp_pc", "CHN", 1995)),
    C("china-rise", 3, "117 other", "num", lambda s: _rank(s, "gdp_pc", "exports", "CHN", 1995, 0) - 1),
    C("china-rise", 3, "6th", "num", lambda s: _rank(s, "gdp_pc", "exports", "CHN", 1995, 1)),
    C("china-rise", 3, "$149 billion", "usd", lambda s: s.v("CHN", "1995")),
    C("china-rise", 3, "$815 billion", "usd", lambda s: s.v("EU", "1995")),
    C("china-rise", 4, "2007", "num", lambda s: _first_year_above(s, "CHN", "USA")),
    C("china-rise", 4, "2014", "num", lambda s: _first_year_above(s, "CHN", "EU")),
    C("china-rise", 4, "24 times", "num", lambda s: s.v("CHN", "2024") / s.v("CHN", "1995")),
    C("china-rise", 4, "22 times", "num", lambda s: s.i("gdp_pc", "CHN", 2024) / s.i("gdp_pc", "CHN", 1995)),
    C("china-rise", 4, "44th", "num", lambda s: _rank(s, "gdp_pc", "exports", "VNM", 1995, 1)),
    C("china-rise", 4, "15th", "num", lambda s: _rank(s, "gdp_pc", "exports", "VNM", 2024, 1)),
    C("china-rise", 5, "35%", "pct", lambda s: s.metric("exports_gdp", "CHN", 2006)),
    C("china-rise", 5, "17%", "pct", lambda s: s.metric("exports_gdp", "CHN", 2019)),
    C("china-rise", 5, "19%", "pct", lambda s: s.metric("exports_gdp", "CHN", 2024)),
    C("china-rise", 5, "82%", "pct", lambda s: s.metric("exports_gdp", "VNM", 2024)),
    C("china-rise", 5, "88%", "pct", lambda s: s.metric("exports_gdp", "SGP", 2024)),
    C("china-rise", 5, "7%", "pct", lambda s: s.metric("exports_gdp", "USA", 2024)),
    C("china-rise", 5, "r = 0.27", "num", lambda s: s.compare("gdp", "exports_gdp", 2024)[1]),
    # What China sells and buys (BACI; shares of the sum over sectors, as in the panel)
    C("china-goods-mix", 1, "30% of", "pct", lambda s: s.mix("CHN", "TEXTILES", "1995")),
    C("china-goods-mix", 1, "22%", "pct", lambda s: s.mix("CHN", "MACHINERY", "1995")),
    C("china-goods-mix", 1, "13%", "pct", lambda s: s.mix("CHN", "INSTRUMENTS", "1995")),
    C("china-goods-mix", 2, "1998", "num", lambda s: _first_year_mix_above(s, "CHN", "MACHINERY", "TEXTILES")),
    C("china-goods-mix", 2, "43%", "pct", lambda s: s.mix("CHN", "MACHINERY", "2008")),
    C("china-goods-mix", 2, "peaked at 50%", "pct", lambda s: s.mix("CHN", "MACHINERY", "2020")),
    C("china-goods-mix", 2, "in 2020 and", "num", lambda s: int(max(s.periods("A", "SECTORS"), key=lambda y: s.mix("CHN", "MACHINERY", y)))),
    C("china-goods-mix", 2, "47% in 2024", "pct", lambda s: s.mix("CHN", "MACHINERY", "2024")),
    C("china-goods-mix", 2, "from 7%", "pct", lambda s: s.mix("CHN", "CHEM", "1995")),
    C("china-goods-mix", 2, "to 11%", "pct", lambda s: s.mix("CHN", "CHEM", "2024")),
    C("china-goods-mix", 2, "9% of exports", "pct", lambda s: s.mix("CHN", "TEXTILES", "2024")),
    C("china-goods-mix", 2, "$70 billion", "usd", lambda s: s.v("CHN", "1995", product="TEXTILES")),
    C("china-goods-mix", 2, "$327 billion", "usd", lambda s: s.v("CHN", "2024", product="TEXTILES")),
    C("china-goods-mix", 3, "$8.9 billion", "usd", lambda s: s.v("CHN", "2020", product="CARS")),
    C("china-goods-mix", 3, "$87.7 billion", "usd", lambda s: s.v("CHN", "2024", product="CARS")),
    C("china-goods-mix", 3, "17%", "pct", lambda s: s.share("CHN", "RUS", "2024", product="CARS")),
    C("china-goods-mix", 3, "from 4%", "pct", lambda s: s.mix("CHN", "VEHICLES", "2020")),
    C("china-goods-mix", 3, "to 7%", "pct", lambda s: s.mix("CHN", "VEHICLES", "2024")),
    C("china-goods-mix", 4, "35%", "pct", lambda s: s.mix("CHN", "MACHINERY", "1995", "m")),
    C("china-goods-mix", 4, "textiles 12%", "pct", lambda s: s.mix("CHN", "TEXTILES", "1995", "m")),
    C("china-goods-mix", 4, "energy only 4%", "pct", lambda s: s.mix("CHN", "ENERGY", "1995", "m")),
    C("china-goods-mix", 4, "ores 1%", "pct", lambda s: s.mix("CHN", "ORES", "1995", "m")),
    C("china-goods-mix", 4, "22%", "pct", lambda s: s.mix("CHN", "ENERGY", "2024", "m")),
    C("china-goods-mix", 4, "minerals 11%", "pct", lambda s: s.mix("CHN", "ORES", "2024", "m")),
    C("china-goods-mix", 4, "33% of the total", "pct", lambda s: s.mix("CHN", "ENERGY", "2024", "m") + s.mix("CHN", "ORES", "2024", "m")),
    C("china-goods-mix", 4, "fell to 25%", "pct", lambda s: s.mix("CHN", "MACHINERY", "2024", "m")),
    C("china-goods-mix", 4, "textiles to 2%", "pct", lambda s: s.mix("CHN", "TEXTILES", "2024", "m")),
    C("china-goods-mix", 5, "$302.5 billion", "usd", lambda s: s.v("CHN", "2024", "m", product="CRUDE")),
    C("china-goods-mix", 5, "14% of", "pct", lambda s: s.mix("CHN", "CRUDE", "2024", "m")),
    C("china-goods-mix", 5, "$2.3 billion", "usd", lambda s: s.v("CHN", "1995", "m", product="CRUDE")),
    C("china-goods-mix", 5, "21%", "pct", lambda s: s.share("CHN", "RUS", "2024", "m", product="CRUDE")),
    C("china-goods-mix", 5, "16%", "pct", lambda s: s.share("CHN", "SAU", "2024", "m", product="CRUDE")),
    C("china-goods-mix", 5, "12%", "pct", lambda s: s.share("CHN", "IRQ", "2024", "m", product="CRUDE")),
    C("china-goods-mix", 6, "64%", "pct", lambda s: s.share("CHN", "AUS", "2024", "m", product="IRONORE")),
    C("china-goods-mix", 6, "18%", "pct", lambda s: s.share("CHN", "BRA", "2024", "m", product="IRONORE")),
    # Wars and oil exporters
    C("war-oil", 1, "$0.8 billion", "usd", lambda s: s.v("KWT", "1991")),
    C("war-oil", 1, "$8.4 billion", "usd", lambda s: s.v("KWT", "1990")),
    C("war-oil", 1, "$0.5 billion", "usd", lambda s: s.v("IRQ", "1991")),
    C("war-oil", 1, "$10.3 billion", "usd", lambda s: s.v("IRQ", "1990")),
    C("war-oil", 1, "95%", "pct", lambda s: s.mix("KWT", "ENERGY", "1995")),
    C("war-oil", 2, "41%", "pct", lambda s: neg(s.i("gdp_growth", "KWT", 1991))),
    C("war-oil", 2, "83%", "pct", lambda s: s.i("gdp_growth", "KWT", 1992)),
    C("war-oil", 2, "$9.0 billion", "usd", lambda s: s.v("KWT", "1993")),
    C("war-oil", 3, "$0.6 billion", "usd", lambda s: max(s.v("IRQ", str(y)) for y in range(1991, 1997))),
    C("war-oil", 3, "$15.8 billion", "usd", lambda s: s.v("IRQ", "2000")),
    C("war-oil", 3, "99.7%", "pct", lambda s: s.mix("IRQ", "ENERGY", "2000")),
    C("war-oil", 3, "37%", "pct", lambda s: neg(s.i("gdp_growth", "IRQ", 2003))),
    C("war-oil", 3, "$16.6 billion", "usd", lambda s: s.v("IRQ", "2004")),
    C("war-oil", 4, "96% fuels", "pct", lambda s: s.mix("LBY", "ENERGY", "2010")),
    C("war-oil", 4, "$49.2 billion", "usd", lambda s: s.v("LBY", "2010")),
    C("war-oil", 4, "$18.2 billion", "usd", lambda s: s.v("LBY", "2011")),
    C("war-oil", 4, "−63%", "pct", lambda s: s.change(s.v("LBY", "2011"), s.v("LBY", "2010"))),
    C("war-oil", 4, "−50%", "pct", lambda s: s.i("gdp_growth", "LBY", 2011)),
    C("war-oil", 4, "26% in 2010", "pct", lambda s: s.share("LBY", "ITA", "2010")),
    C("war-oil", 4, "$12.7 billion", "usd", lambda s: s.pv("LBY", "ITA", "2010")),
    C("war-oil", 4, "$4.4 billion", "usd", lambda s: s.pv("LBY", "ITA", "2011")),
    C("war-oil", 4, "$56.6 billion", "usd", lambda s: s.v("LBY", "2012")),
    C("war-oil", 5, "90% fuels", "pct", lambda s: s.mix("YEM", "ENERGY", "2013")),
    C("war-oil", 5, "$7.2 billion", "usd", lambda s: s.v("YEM", "2013")),
    C("war-oil", 5, "$0.4 billion", "usd", lambda s: s.v("YEM", "2015")),
    C("war-oil", 5, "28%", "pct", lambda s: neg(s.i("gdp_growth", "YEM", 2015))),
    C("war-oil", 5, "$59 million", "usd", lambda s: s.v("YEM", "2024")),
    # War in Ukraine
    C("ukraine-war", 1, "$65.8 billion", "usd", lambda s: s.v("UKR", "2021")),
    C("ukraine-war", 1, "(12%)", "pct", lambda s: s.share("UKR", "CHN", "2021")),
    C("ukraine-war", 1, "(8%)", "pct", lambda s: s.share("UKR", "POL", "2021")),
    C("ukraine-war", 1, "(6%)", "pct", lambda s: s.share("UKR", "TUR", "2021")),
    C("ukraine-war", 1, "40%", "pct", lambda s: s.mix("UKR", "AGRI", "2021")),
    C("ukraine-war", 1, "24%", "pct", lambda s: s.mix("UKR", "METALS", "2021")),
    C("ukraine-war", 2, "−49%", "pct", lambda s: s.yoy("UKR", "2022-03")),
    C("ukraine-war", 2, "−50%", "pct", lambda s: s.yoy("UKR", "2022-04")),
    C("ukraine-war", 2, "32%", "pct", lambda s: neg(s.change(s.v("UKR", "2022"), s.v("UKR", "2021")))),
    C("ukraine-war", 2, "$44.5 billion", "usd", lambda s: s.v("UKR", "2022")),
    C("ukraine-war", 2, "28.8%", "pct", lambda s: neg(s.i("gdp_growth", "UKR", 2022))),
    C("ukraine-war", 3, "from $6.3 billion", "usd", lambda s: s.v("UKR", "2021", product="WHEAT")),
    C("ukraine-war", 3, "$3.8 billion", "usd", lambda s: s.v("UKR", "2022", product="WHEAT")),
    C("ukraine-war", 3, "held up ($6.3 billion)", "usd", lambda s: s.v("UKR", "2022", product="MAIZE")),
    C("ukraine-war", 3, "from 32%", "pct", lambda s: s.share("UKR", "CHN", "2021", product="MAIZE")),
    C("ukraine-war", 3, "17%", "pct", lambda s: s.share("UKR", "CHN", "2022", product="MAIZE")),
    C("ukraine-war", 3, "took 14%", "pct", lambda s: s.share("UKR", "ROU", "2022", product="MAIZE")),
    C("ukraine-war", 3, "Spain 12%", "pct", lambda s: s.share("UKR", "ESP", "2022", product="MAIZE")),
    C("ukraine-war", 4, "from 24%", "pct", lambda s: s.mix("UKR", "METALS", "2021")),
    C("ukraine-war", 4, "10%", "pct", lambda s: s.mix("UKR", "METALS", "2024")),
    C("ukraine-war", 4, "$17.1 billion", "usd", lambda s: s.v("UKR", "2021", product="METALS")),
    C("ukraine-war", 4, "$4.8 billion", "usd", lambda s: s.v("UKR", "2024", product="METALS")),
    C("ukraine-war", 4, "from 40%", "pct", lambda s: s.mix("UKR", "AGRI", "2021")),
    C("ukraine-war", 4, "59%", "pct", lambda s: s.mix("UKR", "AGRI", "2024")),
    C("ukraine-war", 5, "from 39%", "pct", lambda s: s.share("UKR", "EU", "2021")),
    C("ukraine-war", 5, "63%", "pct", lambda s: s.share("UKR", "EU", "2022")),
    C("ukraine-war", 5, "was 58%", "pct", lambda s: s.share("UKR", "EU", "2024")),
    C("ukraine-war", 5, "bought 15%", "pct", lambda s: s.share("UKR", "POL", "2022")),
    C("ukraine-war", 6, "$70.5 billion", "usd", lambda s: s.v("UKR", "2024", "m")),
    C("ukraine-war", 6, "($70.0 billion)", "usd", lambda s: s.v("UKR", "2021", "m")),
    C("ukraine-war", 6, "$40.2 billion", "usd", lambda s: s.v("UKR", "2024")),
    C("ukraine-war", 6, "$4.1 billion", "usd", lambda s: neg(s.v("UKR", "2021", "b"))),
    C("ukraine-war", 6, "$30.3 billion", "usd", lambda s: neg(s.v("UKR", "2024", "b"))),
    C("ukraine-war", 6, "20%", "pct", lambda s: s.share("UKR", "CHN", "2024", "m")),
    C("ukraine-war", 6, "from 15%", "pct", lambda s: s.share("UKR", "CHN", "2021", "m")),
]


def _bri_debt_share(s, year):
    mem = set(s.lists["BRI"]["members"])
    j = s.bil["periods"].index(str(year))
    chn, wld = s.bil["values"]["debt"]["CHN"], s.bil["values"]["debt"]["WLD"]
    es = [e for e in mem if (chn.get(e) or [None] * 99)[j] and (wld.get(e) or [None] * 99)[j]]
    return 100 * sum(chn[e][j] for e in es) / sum(wld[e][j] for e in es)


def _fdi_abroad(s, year):
    """Direct investment stock from the Chinese mainland in all other economies (positive positions)."""
    j = s.bil["periods"].index(str(year))
    return sum(v[j] for e, v in s.bil["values"]["fdi"]["CHN"].items() if e not in s.groups and v[j] and v[j] > 0)


def _rank(s, xid, yid, key, year, axis):
    """Rank (1 = largest) of `key` among the Compare points of (xid, yid), by x (axis 0) or y (axis 1)."""
    pts, _ = s.compare(xid, yid, year)
    order = sorted(pts, key=lambda k: -pts[k][axis])
    return order.index(key) + 1


def _first_year_above(s, a, b):
    """First year from which a's exports exceed b's in every later year."""
    years = s.periods()
    vals = [(s.v(a, y), s.v(b, y)) for y in years]
    if missing := [y for y, (va, vb) in zip(years, vals) if va is None or vb is None]:
        raise ValueError(f"{a} or {b} has no exports in {', '.join(missing)}")
    ok = [va > vb for va, vb in vals]
    for i in range(len(years)):
        if all(ok[i:]):
            return int(years[i])
    return None


def _first_year_mix_above(s, code, a, b):
    """First year from which product a's share of code's exports exceeds b's in every later year."""
    years = s.periods("A", "SECTORS")
    ok = [s.mix(code, a, y) > s.mix(code, b, y) for y in years]
    return next((int(years[i]) for i in range(len(years)) if all(ok[i:])), None)


# --------------------------------------------------------------------------- matching

EN_NUM = re.compile(r"([−\-+]?)\$?(\d[\d,]*(?:\.\d+)?)\s*(trillion|billion|million)?")
ZH_NUM = re.compile(r"([−\-+]?)(\d[\d,]*(?:\.\d+)?)\s*(万亿|亿|万)?(美元)?(%)?")
EN_SCALE = {"trillion": 1e6, "billion": 1e3, "million": 1.0, None: 1.0}
ZH_SCALE = {"万亿": 1e6, "亿": 100.0, "万": 0.01, None: 1.0}


def written(sign, digits, scale):
    """(value, tolerance) of a written number: half a unit of its last significant digit."""
    value = float(digits.replace(",", ""))
    if "." in digits:
        unit = 10 ** -len(digits.split(".")[1])
    else:
        d = digits.replace(",", "")
        unit = 10 ** (len(d) - len(d.rstrip("0"))) if d.strip("0") else 1
    sgn = -1 if sign in ("−", "-") else 1
    return sgn * value * scale, unit * scale / 2


def parse_en(snippet, kind):
    m = EN_NUM.search(snippet)
    if not m:
        raise ValueError(f"no number in {snippet!r}")
    scale = EN_SCALE[m.group(3)] if kind == "usd" else 1.0
    return written(m.group(1), m.group(2), scale)


def zh_candidates(text, kind):
    for m in ZH_NUM.finditer(text):
        sign, digits, mag, usd, pct = m.groups()
        if kind == "usd" and not (usd and mag):
            continue
        if kind == "usd_pc" and not (usd and not mag):
            continue
        if kind == "pct" and not pct:
            continue
        if kind == "num" and (usd or pct):
            continue
        yield written(sign, digits, ZH_SCALE[mag] if kind == "usd" else 1.0)


def plain(texts):
    """Step text without markup: [name](CODE) -> name, **bold** -> bold."""
    t = " ".join(texts if isinstance(texts, list) else [texts])
    return re.sub(r"\[([^\]]+)\]\([A-Z0-9_]+\)", r"\1", t).replace("**", "")


def close(value, target, tol):
    return value is not None and abs(value - target) <= tol + 1e-9 * max(1, abs(target))


def check(site=None, stories=STORIES, claims=CLAIMS) -> list[str]:
    site = site or Site()
    problems = []
    for c in claims:
        en = json.loads((stories / f"{c.story}.json").read_text())
        en_text = plain(en["steps"][c.step - 1]["text"])
        where = f"{c.story} step {c.step} {c.en!r}"
        if c.en not in en_text:
            problems.append(f"{where}: snippet not found in the English text")
            continue
        try:
            value = c.value(site)
        except Exception as e:  # missing series etc.
            problems.append(f"{where}: cannot compute ({type(e).__name__}: {e})")
            continue
        target, tol = parse_en(c.en, c.kind)
        if not close(value, target, tol):
            problems.append(f"{where}: data now gives {value:,.4g} (written {target:,.4g} ± {tol:.3g})")
            continue
        for lang in LANGS:
            path = stories / lang / f"{c.story}.json"
            if not path.exists():
                continue
            tr_text = plain(json.loads(path.read_text())["steps"][c.step - 1]["text"])
            if not any(close(value, t, tl) for t, tl in zh_candidates(tr_text, c.kind)):
                problems.append(f"{where}: no matching number in the {lang} text (data gives {value:,.4g})")
    return problems


def main():
    from .net import log
    problems = check()
    for p in problems:
        log(f"  MISMATCH {p}")
    log(f"check-stories: {len(CLAIMS)} figures, {len(problems)} problem(s)")
    return 1 if problems else 0

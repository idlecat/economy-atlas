import pytest

from pipeline import publish as pub
from pipeline.registry import Entity, Registry, resolve_groups
from pipeline.store import OBS_COLUMNS, connect


def make_registry(groups, extra_entities=(), **entity_kw):
    ids = {"AAA", "BBB", "CCC", "DDD", *extra_entities}
    entities = {i: Entity(id=i, name=i, **entity_kw.get(i, {})) for i in ids}
    return Registry(entities, {"groups": groups})


def make_con(rows, freq="A"):
    """rows: (source, reporter, partner, flow, period, value) for goods_trade totals."""
    con = connect()
    con.execute(f"CREATE TABLE obs ({', '.join(f'{c} {t}' for c, t in OBS_COLUMNS.items())})")
    if rows:
        con.executemany(f"INSERT INTO obs VALUES ({', '.join('?' * len(OBS_COLUMNS))})", [
            (src, "goods_trade", r, p, f, "TOTAL", freq, str(per), v, "USD", "", "")
            for src, r, p, f, per, v in rows])
    return con


CFG = {"precedence": ["a", "b"], "product": "TOTAL"}


def run(con, registry, freq="A"):
    pub.select_observations(con, "goods_trade", CFG, freq, 2000)
    mirrored = pub.derive_mirrors(con, registry)
    pub.build_pairs(con)
    pub.build_groups(con, registry)
    return mirrored


def q(con, sql):
    return con.execute(sql).fetchall()


# --------------------------------------------------------------------------- registry

def test_groups_may_not_overlap_in_the_same_year():
    with pytest.raises(ValueError, match="overlapping"):
        make_registry([
            {"id": "G1", "name": "G1", "members": [{"id": "AAA", "to": 2010}]},
            {"id": "G2", "name": "G2", "members": [{"id": "AAA", "from": 2010}]},
        ])


def test_sequential_memberships_are_allowed():
    reg = make_registry([
        {"id": "G1", "name": "G1", "members": [{"id": "AAA", "to": 2009}]},
        {"id": "G2", "name": "G2", "members": [{"id": "AAA", "from": 2010}]},
    ])
    assert [(m.group, m.start, m.end) for m in reg.memberships()] == [("G1", None, 2009), ("G2", 2010, None)]


def test_m49_rule_members_and_exclusions():
    entities = {i: Entity(id=i, name=i, m49=n, region="002") for i, n in [("AAA", "1"), ("BBB", "2")]}
    groups = resolve_groups({"groups": [{"id": "AF", "name": "AF", "m49_region": ["002"], "exclude": ["BBB"]}]}, entities)
    assert [m.entity for m in groups[0].members] == ["AAA"]


def test_unknown_member_is_an_error():
    with pytest.raises(ValueError, match="unknown entity"):
        make_registry([{"id": "G1", "name": "G1", "members": ["ZZZ"]}])


# --------------------------------------------------------------------------- publish

def test_precedence_picks_first_source_and_falls_back():
    con = make_con([
        ("b", "AAA", "BBB", "X", 2000, 1.0),
        ("a", "AAA", "BBB", "X", 2000, 2.0),   # preferred
        ("b", "AAA", "BBB", "X", 2001, 3.0),   # only source for 2001
        ("a", "AAA", "BBB", "X", 1999, 9.0),   # before start year
    ])
    run(con, make_registry([]))
    assert q(con, "SELECT period, x FROM pairs ORDER BY period") == [("2000", 2.0), ("2001", 3.0)]


def test_missing_flow_stays_null_not_zero():
    con = make_con([("a", "AAA", "BBB", "X", 2000, 5.0)])
    run(con, make_registry([]))
    assert q(con, "SELECT x, m FROM pairs") == [(5.0, None)]


def test_mirror_swaps_partner_reports():
    con = make_con([
        ("a", "AAA", "DDD", "M", 2000, 10.0),   # AAA imports from DDD -> DDD exports to AAA
        ("a", "BBB", "DDD", "X", 2000, 4.0),    # BBB exports to DDD   -> DDD imports from BBB
        ("a", "AAA", "WLD", "M", 2000, 99.0),
    ])
    reg = make_registry([], DDD={"derive": "mirror"})
    assert run(con, reg) == ["DDD"]
    assert q(con, "SELECT partner, x, m FROM pairs WHERE reporter = 'DDD' ORDER BY partner") == [
        ("AAA", 10.0, None), ("BBB", None, 4.0), ("WLD", 10.0, 4.0)]


def test_mirror_skipped_when_entity_reports():
    con = make_con([("a", "DDD", "AAA", "X", 2000, 1.0), ("a", "AAA", "DDD", "M", 2000, 2.0)])
    assert run(con, make_registry([], DDD={"derive": "mirror"})) == []


def test_group_uses_membership_as_of_each_year():
    # G = {AAA always, BBB from 2001}. CCC is never a member.
    rows = []
    for y in (2000, 2001):
        rows += [
            ("a", "AAA", "BBB", "X", y, 10.0),
            ("a", "AAA", "CCC", "X", y, 1.0),
            ("a", "AAA", "WLD", "X", y, 11.0),
            ("a", "BBB", "CCC", "X", y, 5.0),
            ("a", "BBB", "WLD", "X", y, 5.0),
        ]
    con = make_con(rows)
    run(con, make_registry([{"id": "G", "name": "G", "members": ["AAA", {"id": "BBB", "from": 2001}]}]))

    # 2000: only AAA is a member, so BBB is an outside partner; 2001: AAA->BBB is intra-group.
    assert q(con, "SELECT period, partner, x FROM group_pairs ORDER BY period, partner") == [
        ("2000", "BBB", 10.0), ("2000", "CCC", 1.0), ("2001", "CCC", 6.0)]
    assert q(con, "SELECT period, x FROM group_intra ORDER BY period") == [("2001", 10.0)]
    # extra-group exports: 2000 = AAA's world 11; 2001 = (11 + 5) - 10 intra
    assert q(con, "SELECT period, x FROM group_world ORDER BY period") == [("2000", 11.0), ("2001", 6.0)]


def test_monthly_membership_follows_the_year():
    rows = [("a", "AAA", "BBB", "X", p, 1.0) for p in ("2000-12", "2001-01")]
    con = make_con(rows, freq="M")
    run(con, make_registry([{"id": "G", "name": "G", "members": ["AAA", {"id": "BBB", "from": 2001}]}]), freq="M")
    assert q(con, "SELECT period, partner FROM group_pairs") == [("2000-12", "BBB")]
    assert q(con, "SELECT period FROM group_intra") == [("2001-01",)]


def test_covered_periods_drops_incomplete_tail():
    rows = []
    for p, reporters in [("2000-01", "AAA BBB CCC DDD"), ("2000-02", "AAA BBB CCC"), ("2000-03", "AAA")]:
        rows += [("a", r, "WLD", "X", p, 1.0) for r in reporters.split()]
    con = make_con(rows, freq="M")
    run(con, make_registry([]), freq="M")
    assert pub.covered_periods(con, 0.7) == ["2000-01", "2000-02"]
    assert pub.covered_periods(con, 0) == ["2000-01", "2000-02", "2000-03"]


def test_sig_rounds_to_millions():
    assert pub.sig(481_880_763_487) == 481900
    assert pub.sig(72_155.84) == 0.07216
    assert pub.sig(None) is None and pub.sig(0) == 0


def test_collect_aligns_to_years():
    assert pub.collect([("AAA", "2001", 2e6, None)], ["2000", "2001"]) == {"AAA": [[None, 2], [None, None]]}


# --------------------------------------------------------------------------- products

from pipeline.sources import cepii_baci  # noqa: E402


def test_hs_classification_uses_longest_prefix():
    tax = cepii_baci.load_taxonomy()
    assert cepii_baci.classify("270900", tax) == ("ENERGY", "CRUDE")
    assert cepii_baci.classify("271111", tax) == ("ENERGY", "GAS")
    assert cepii_baci.classify("271119", tax) == ("ENERGY", None)
    assert cepii_baci.classify("300490", tax) == ("CHEM", "PHARMA")
    assert cepii_baci.classify("999999", tax) == ("OTHER", None)


def test_overlapping_sectors_are_rejected():
    tax = {"sectors": [{"id": "A", "hs": ["27"]}, {"id": "B", "hs": ["2709"]}], "commodities": []}
    with pytest.raises(ValueError, match="overlaps"):
        cepii_baci.validate_taxonomy(tax)


def test_publish_selects_one_product():
    con = make_con([])
    con.executemany(f"INSERT INTO obs VALUES ({', '.join('?' * len(OBS_COLUMNS))})", [
        ("a", "goods_trade", "AAA", "BBB", "X", prod, "A", "2000", v, "USD", "", "")
        for prod, v in [("CRUDE", 1.0), ("COAL", 2.0)]])
    pub.select_observations(con, "goods_trade", CFG, "A", 2000, product="COAL")
    assert q(con, "SELECT product, value FROM chosen") == [("COAL", 2.0)]


def test_code_map_accepts_several_codes_per_entity():
    reg = make_registry([])
    reg.entities["AAA"].codes["baci"] = "276|280"
    assert reg.code_map("baci") == {"276": "AAA", "280": "AAA"}
    reg.entities["BBB"].codes["baci"] = "280"
    with pytest.raises(ValueError, match="used by both"):
        reg.code_map("baci")


# --------------------------------------------------------------------------- indicators

from pipeline import indicators as ind  # noqa: E402


def test_group_sum_needs_population_coverage():
    pop = {"AAA": {2000: 90}, "BBB": {2000: 10}}
    gdp = {"AAA": {2000: 5.0}, "BBB": {2000: 1.0}}
    assert ind.group_sum(gdp, ["AAA", "BBB"], pop, 2000) == 6.0
    # BBB has no data but only 10% of the population: still below the 95% rule
    assert ind.group_sum({"AAA": {2000: 5.0}}, ["AAA", "BBB"], pop, 2000) is None
    # a tiny missing member is fine
    pop2 = {"AAA": {2000: 99}, "BBB": {2000: 1}}
    assert ind.group_sum({"AAA": {2000: 5.0}}, ["AAA", "BBB"], pop2, 2000) == 5.0


def test_group_growth_uses_constant_membership():
    reg = make_registry([{"id": "G", "name": "G", "members": ["AAA", {"id": "BBB", "from": 2001}]}])
    raw = {
        "pop": {"AAA": {2000: 50, 2001: 50}, "BBB": {2000: 50, 2001: 50}},
        "gdp_real": {"AAA": {2000: 100.0, 2001: 110.0}, "BBB": {2000: 100.0, 2001: 100.0}},
        "gdp": {"AAA": {2000: 100.0, 2001: 110.0}, "BBB": {2000: 100.0, 2001: 100.0}},
    }
    cfg = {"indicators": [{"id": "gdp", "group": "sum"}, {"id": "gdp_real", "group": "sum"}, {"id": "pop", "group": "sum"}]}
    out = ind.compute(raw, reg, [2000, 2001], cfg)
    # 2001: members AAA+BBB, compared with the same two in 2000: 210 / 200 -> +5%, not +110%
    assert round(out["gdp_growth"]["G"][2001], 6) == 5.0
    assert out["gdp"]["G"] == {2000: 100.0, 2001: 210.0}
    assert out["gdp_pc"]["AAA"][2001] == 110.0 / 50


# --------------------------------------------------------------------------- bilateral measures

from pipeline import bilateral as bil  # noqa: E402

BIL_CFG = {"start": 2000, "measures": [
    {"id": "debt", "counterparts": {"CCC": "x", "WLD": "w"}},
    {"id": "fdi", "precedence": ["host", "investor"], "counterparts": {"CCC": "x", "WLD": "w"}},
]}


def test_bilateral_series_keep_one_basis():
    reg = make_registry([])
    rows = [  # host reports only 2001; the investor reports 2000-2001: the host series wins whole
        ("fdi", "AAA", "CCC", "2001", 5.0, "host"),
        ("fdi", "AAA", "CCC", "2000", 9.0, "investor"), ("fdi", "AAA", "CCC", "2001", 9.0, "investor"),
        ("fdi", "BBB", "CCC", "2001", 7.0, "investor"),  # no host report: use the investor's
    ]
    values, basis, years = bil.compute(rows, BIL_CFG, reg, {})
    assert values["fdi"]["CCC"]["AAA"] == {2001: 5.0}
    assert values["fdi"]["CCC"]["BBB"] == {2001: 7.0}
    assert basis == {"fdi": {"CCC": {"BBB": "investor"}}}
    assert years == [2000, 2001]


def test_bilateral_group_counts_reporters_and_skips_own_counterpart():
    reg = make_registry([{"id": "G", "name": "G", "members": ["AAA", "BBB"]},
                         {"id": "H", "name": "H", "members": ["CCC", "DDD"]}])
    pop = {"AAA": {2000: 50}, "BBB": {2000: 50}, "CCC": {2000: 50}, "DDD": {2000: 50}}
    rows = [
        ("debt", "AAA", "CCC", "2000", 4.0, ""), ("debt", "AAA", "WLD", "2000", 10.0, ""),
        ("debt", "BBB", "WLD", "2000", 6.0, ""),  # reports, but owes CCC nothing: counts as 0
        ("debt", "DDD", "CCC", "2000", 3.0, ""), ("debt", "DDD", "WLD", "2000", 3.0, ""),
    ]
    values, _, _ = bil.compute(rows, BIL_CFG, reg, pop)
    assert values["debt"]["CCC"]["G"] == {2000: 4.0}
    assert values["debt"]["WLD"]["G"] == {2000: 16.0}
    assert "H" not in values["debt"]["CCC"]  # H contains the creditor CCC itself
    assert values["debt"]["WLD"].get("H") is None  # CCC doesn't report: only 50% coverage


def test_bilateral_group_uses_host_reports_only():
    reg = make_registry([{"id": "G", "name": "G", "members": ["AAA", "BBB"]}])
    pop = {"AAA": {2000: 90}, "BBB": {2000: 10}}
    rows = [("fdi", "AAA", "CCC", "2000", 5.0, "host"), ("fdi", "AAA", "WLD", "2000", 50.0, "host"),
            ("fdi", "BBB", "CCC", "2000", 400.0, "investor")]  # offshore centre in the investor's report only
    values, _, _ = bil.compute(rows, BIL_CFG, reg, pop)
    assert values["fdi"]["CCC"]["G"] == {2000: 5.0}
    assert values["fdi"]["CCC"]["BBB"] == {2000: 400.0}  # still shown for the country itself


def test_lists_reject_unknown_members(tmp_path):
    from pipeline.registry import load_lists
    reg = make_registry([])
    path = tmp_path / "lists.json"
    path.write_text('{"lists": [{"id": "L", "counterpart": "AAA", "members": ["BBB", "ZZZ"]}]}')
    with pytest.raises(ValueError, match="ZZZ"):
        load_lists(reg.entities, path)
    path.write_text('{"lists": [{"id": "L", "counterpart": "AAA", "members": ["BBB", "CCC"]}]}')
    assert load_lists(reg.entities, path)[0]["members"] == ["BBB", "CCC"]


def test_download_does_not_cache_rejected_responses(tmp_path, monkeypatch):
    from pipeline import net
    monkeypatch.setattr(net, "http_get", lambda url, accept=None: b'[{"message": "error"}]')
    check = net.json_check(lambda d: isinstance(d, list) and len(d) == 2)
    with pytest.raises(RuntimeError, match="not cached"):
        net.download(tmp_path / "x.json", "http://example", validate=check)
    assert not (tmp_path / "x.json").exists()
    monkeypatch.setattr(net, "http_get", lambda url, accept=None: b'[{"page": 1}, []]')
    net.download(tmp_path / "x.json", "http://example", validate=check)
    assert (tmp_path / "x.json").read_bytes() == b'[{"page": 1}, []]'
    assert not list(tmp_path.glob("*.tmp"))

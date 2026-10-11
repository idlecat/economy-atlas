import pytest

from pipeline import publish as pub
from pipeline.registry import Entity, Registry, resolve_groups
from pipeline.store import OBS_COLUMNS, connect


def make_registry(groups, extra_entities=(), **entity_kw):
    ids = {"AAA", "BBB", "CCC", "DDD", *extra_entities}
    entities = {i: Entity(id=i, name=i, **entity_kw.get(i, {})) for i in ids}
    return Registry(entities, {"groups": groups})


def make_con(rows):
    """rows: (source, reporter, partner, flow, year, value) for annual goods_trade totals."""
    con = connect()
    con.execute(f"CREATE TABLE obs ({', '.join(f'{c} {t}' for c, t in OBS_COLUMNS.items())})")
    con.executemany(f"INSERT INTO obs VALUES ({', '.join('?' * len(OBS_COLUMNS))})", [
        (src, "goods_trade", r, p, f, "TOTAL", "A", str(y), v, "USD", "", "")
        for src, r, p, f, y, v in rows])
    return con


CFG = {"precedence": ["a", "b"], "product": "TOTAL", "freq": "A", "start": 2000}


def run(con, registry):
    pub.select_observations(con, "goods_trade", CFG)
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
    assert q(con, "SELECT year, x FROM pairs ORDER BY year") == [(2000, 2.0), (2001, 3.0)]


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
    assert q(con, "SELECT year, partner, x FROM group_pairs ORDER BY year, partner") == [
        (2000, "BBB", 10.0), (2000, "CCC", 1.0), (2001, "CCC", 6.0)]
    assert q(con, "SELECT year, x FROM group_intra ORDER BY year") == [(2001, 10.0)]
    # extra-group exports: 2000 = AAA's world 11; 2001 = (11 + 5) - 10 intra
    assert q(con, "SELECT year, x FROM group_world ORDER BY year") == [(2000, 11.0), (2001, 6.0)]


def test_sig_rounds_to_millions():
    assert pub.sig(481_880_763_487) == 481900
    assert pub.sig(72_155.84) == 0.07216
    assert pub.sig(None) is None and pub.sig(0) == 0


def test_collect_aligns_to_years():
    assert pub.collect([("AAA", 2001, 2e6, None)], [2000, 2001]) == {"AAA": [[None, 2], [None, None]]}

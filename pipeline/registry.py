"""Entity registry and group membership.

Entity ids are ISO 3166-1 alpha-3 codes (retired ones like SUN for historical
states, XKX for Kosovo). Every source maps its own codes to these ids through
a column in config/entities.csv named after the code scheme (e.g. `imf`).
"""
import csv
import json
from dataclasses import dataclass, field

from .paths import CONFIG

WORLD = "WLD"
NON_SCHEME_COLUMNS = {"id", "name", "m49", "valid_from", "valid_to", "derive", "part_of", "note"}


@dataclass
class Entity:
    id: str
    name: str
    m49: str = ""
    codes: dict = field(default_factory=dict)  # scheme -> source code
    valid_from: int | None = None
    valid_to: int | None = None
    derive: str = ""  # "mirror": rebuild from partner reports when the entity is not a reporter
    part_of: str = ""  # entity id of the country this territory belongs to (e.g. HKG -> CHN); shown in the UI
    note: str = ""
    # filled from UN M49 reference data
    region: str = ""
    region_name: str = ""
    subregion: str = ""
    subregion_name: str = ""
    intermediate: str = ""


@dataclass(frozen=True)
class Membership:
    group: str
    entity: str
    start: int | None = None  # inclusive; None = open-ended
    end: int | None = None

    def covers(self, year: int) -> bool:
        return (self.start is None or year >= self.start) and (self.end is None or year <= self.end)

    def overlaps(self, other: "Membership") -> bool:
        lo = max(self.start or -10**9, other.start or -10**9)
        hi = min(self.end or 10**9, other.end or 10**9)
        return lo <= hi


@dataclass
class Group:
    id: str
    name: str
    short: str
    note: str = ""
    members: list[Membership] = field(default_factory=list)


def _int(v):
    return int(v) if v not in ("", None) else None


def load_entities(path=CONFIG / "entities.csv") -> dict[str, Entity]:
    out = {}
    with open(path, newline="", encoding="utf-8") as f:
        for row in csv.DictReader(f):
            codes = {k: v for k, v in row.items() if k not in NON_SCHEME_COLUMNS and v}
            e = Entity(id=row["id"], name=row["name"], m49=row["m49"], codes=codes,
                       valid_from=_int(row["valid_from"]), valid_to=_int(row["valid_to"]),
                       derive=row["derive"], part_of=row.get("part_of", ""), note=row["note"])
            if e.id in out:
                raise ValueError(f"duplicate entity id {e.id}")
            out[e.id] = e
    return out


def resolve_groups(cfg: dict, entities: dict[str, Entity]) -> list[Group]:
    """Expand groups.json (explicit members + M49 rules) and check that no entity is in two groups in the same year."""
    groups = []
    for g in cfg["groups"]:
        if g["id"] in entities:
            raise ValueError(f"group id {g['id']} clashes with an entity id")
        members: dict[str, Membership] = {}
        for m in g.get("members", []):
            m = {"id": m} if isinstance(m, str) else m
            if m["id"] not in entities:
                raise ValueError(f"group {g['id']}: unknown entity {m['id']}")
            members[m["id"]] = Membership(g["id"], m["id"], m.get("from"), m.get("to"))
        for e in entities.values():
            if e.id in members or e.id in g.get("exclude", []):
                continue
            if (e.region in g.get("m49_region", []) or e.subregion in g.get("m49_subregion", [])
                    or e.intermediate in g.get("m49_intermediate", [])) and e.m49:
                members[e.id] = Membership(g["id"], e.id)
        groups.append(Group(g["id"], g["name"], g.get("short", g["name"]), g.get("note", ""),
                            sorted(members.values(), key=lambda m: m.entity)))

    by_entity: dict[str, list[Membership]] = {}
    for grp in groups:
        for m in grp.members:
            for other in by_entity.get(m.entity, []):
                if m.overlaps(other):
                    raise ValueError(f"{m.entity} is in both {other.group} and {m.group} in overlapping years")
            by_entity.setdefault(m.entity, []).append(m)
    return groups


class Registry:
    def __init__(self, entities: dict[str, Entity], groups_cfg: dict):
        self.entities = entities
        self.groups = resolve_groups(groups_cfg, entities)

    @classmethod
    def load(cls, m49_rows=None):
        entities = load_entities()
        if m49_rows:
            attach_m49(entities, m49_rows)
        cfg = json.loads((CONFIG / "groups.json").read_text())
        return cls(entities, cfg)

    def code_map(self, scheme: str) -> dict[str, str]:
        """source code -> entity id for one code scheme. A cell may hold several codes
        separated by "|" (e.g. a country's current and historical codes in that source)."""
        out = {}
        for e in self.entities.values():
            for code in e.codes.get(scheme, "").split("|"):
                if code:
                    if code in out:
                        raise ValueError(f"{scheme} code {code} is used by both {out[code]} and {e.id}")
                    out[code] = e.id
        return out

    def memberships(self) -> list[Membership]:
        return [m for g in self.groups for m in g.members]


def attach_m49(entities: dict[str, Entity], m49_rows):
    by_code = {r["m49"]: r for r in m49_rows}
    for e in entities.values():
        r = by_code.get(e.m49)
        if r:
            e.region, e.region_name = r["region"], r["region_name"]
            e.subregion, e.subregion_name = r["subregion"], r["subregion_name"]
            e.intermediate = r["intermediate"]

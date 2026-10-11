"""Canonical observation store.

Every observation source writes one Parquet file, data_store/observations/<source>.parquet,
with exactly these columns. Publish steps read them all through the `obs` view.
"""
import duckdb

from .paths import STORE

OBS_COLUMNS = {
    "source": "VARCHAR",     # source id, e.g. imf_imts
    "dataset": "VARCHAR",    # e.g. goods_trade
    "reporter": "VARCHAR",   # entity id (config/entities.csv)
    "partner": "VARCHAR",    # entity id, or WLD for the world total
    "flow": "VARCHAR",       # X = exports, M = imports (as reported by `reporter`)
    "product": "VARCHAR",    # TOTAL, or a product code (e.g. HS chapter) in a future dataset
    "freq": "VARCHAR",       # A, Q or M
    "period": "VARCHAR",     # 2008 | 2008-Q4 | 2008-11
    "value": "DOUBLE",
    "unit": "VARCHAR",       # USD, ...
    "valuation": "VARCHAR",  # FOB, CIF, or empty
    "flag": "VARCHAR",       # e.g. mirror, estimated; empty if none
}

OBS_DIR = STORE / "observations"
REF_DIR = STORE / "reference"
REPORT_DIR = STORE / "reports"


def connect() -> duckdb.DuckDBPyConnection:
    return duckdb.connect()


def write_observations(con, source_id: str, select_sql: str, params=None) -> int:
    """Materialize `select_sql` (which must yield OBS_COLUMNS, in order) as the source's Parquet file."""
    cols = ", ".join(f"CAST({c} AS {t}) AS {c}" for c, t in OBS_COLUMNS.items())
    con.execute(f"CREATE OR REPLACE TEMP TABLE _out AS SELECT {cols} FROM ({select_sql})", params or [])
    OBS_DIR.mkdir(parents=True, exist_ok=True)
    path = OBS_DIR / f"{source_id}.parquet"
    con.execute(f"COPY _out TO '{path}' (FORMAT parquet, COMPRESSION zstd)")
    n = con.execute("SELECT count(*) FROM _out").fetchone()[0]
    con.execute("DROP TABLE _out")
    return n


def create_obs_view(con, path_glob=None):
    path_glob = path_glob or str(OBS_DIR / "*.parquet")
    con.execute(f"CREATE OR REPLACE VIEW obs AS SELECT * FROM read_parquet('{path_glob}', union_by_name = true)")


def write_reference(con, name: str, rows: list[dict]):
    REF_DIR.mkdir(parents=True, exist_ok=True)
    cols = list(rows[0])
    con.execute(f"CREATE OR REPLACE TEMP TABLE _ref ({', '.join(f'{c} VARCHAR' for c in cols)})")
    con.executemany(f"INSERT INTO _ref VALUES ({', '.join('?' for _ in cols)})", [[r[c] for c in cols] for r in rows])
    con.execute(f"COPY _ref TO '{REF_DIR / (name + '.parquet')}' (FORMAT parquet)")
    con.execute("DROP TABLE _ref")


def read_reference(con, name: str) -> list[dict]:
    path = REF_DIR / f"{name}.parquet"
    if not path.exists():
        return []
    cur = con.execute(f"SELECT * FROM read_parquet('{path}')")
    cols = [d[0] for d in cur.description]
    return [dict(zip(cols, r)) for r in cur.fetchall()]

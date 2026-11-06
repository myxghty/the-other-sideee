"""
Thin database layer over SQLite (local dev) or PostgreSQL (production).

No ORM on purpose: the SQL that guarantees correctness under concurrency
(conditional UPDATEs, UNIQUE constraints, advisory locks) is visible and easy to explain.
Write the SQL with `?` placeholders; they are converted for PostgreSQL.
"""
import json
import os
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path

SCHEMA_PATH = Path(__file__).with_name("schema.sql")


def now_ms() -> int:
    return int(time.time() * 1000)


def dumps(value) -> str:
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def loads(value):
    return json.loads(value) if value else None


class Tx:
    """One connection inside one transaction (or a read-only session)."""

    def __init__(self, conn, is_pg: bool):
        self.conn = conn
        self.is_pg = is_pg

    def _sql(self, sql: str) -> str:
        return sql.replace("?", "%s") if self.is_pg else sql

    def run(self, sql: str, *params) -> int:
        cur = self.conn.execute(self._sql(sql), params)
        return cur.rowcount

    def all(self, sql: str, *params) -> list:
        cur = self.conn.execute(self._sql(sql), params)
        return [dict(r) for r in cur.fetchall()]

    def one(self, sql: str, *params):
        cur = self.conn.execute(self._sql(sql), params)
        row = cur.fetchone()
        return dict(row) if row else None

    def scalar(self, sql: str, *params):
        row = self.one(sql, *params)
        return next(iter(row.values())) if row else None


class Database:
    def __init__(self, url: str, pool_size: int = 10):
        self.url = url
        self.is_pg = url.startswith(("postgres://", "postgresql://"))
        if self.is_pg:
            import psycopg  # pip install "psycopg[binary,pool]"
            from psycopg.rows import dict_row

            self._psycopg = psycopg
            self._row_factory = dict_row
            try:
                from psycopg_pool import ConnectionPool

                self.pool = ConnectionPool(url, min_size=1, max_size=pool_size, kwargs={"row_factory": dict_row}, open=True)
            except ImportError:
                self.pool = None
            self.IntegrityError = psycopg.IntegrityError
            self.RetryableError = (psycopg.errors.SerializationFailure, psycopg.errors.DeadlockDetected)
        else:
            path = url.split("sqlite:///", 1)[1] if url.startswith("sqlite:///") else "medtrail.db"
            self.path = path
            Path(path).parent.mkdir(parents=True, exist_ok=True) if os.path.dirname(path) else None
            self.IntegrityError = sqlite3.IntegrityError
            self.RetryableError = (sqlite3.OperationalError,)  # "database is locked"

    # ---------- connections ----------
    def _sqlite_conn(self):
        conn = sqlite3.connect(self.path, timeout=30, isolation_level=None, check_same_thread=False)
        conn.row_factory = sqlite3.Row
        conn.execute("PRAGMA journal_mode=WAL")
        conn.execute("PRAGMA busy_timeout=30000")
        conn.execute("PRAGMA foreign_keys=ON")
        return conn

    @contextmanager
    def _pg_conn(self):
        if self.pool is not None:
            with self.pool.connection() as conn:
                yield conn
        else:
            with self._psycopg.connect(self.url, row_factory=self._row_factory) as conn:
                yield conn

    @contextmanager
    def tx(self):
        """Write transaction. Commits on success, rolls back on any exception."""
        if self.is_pg:
            with self._pg_conn() as conn:
                with conn.transaction():
                    yield Tx(conn, True)
        else:
            conn = self._sqlite_conn()
            try:
                # IMMEDIATE takes the write lock up front: SQLite runs writers one at a time.
                conn.execute("BEGIN IMMEDIATE")
                yield Tx(conn, False)
                conn.execute("COMMIT")
            except BaseException:
                conn.execute("ROLLBACK")
                raise
            finally:
                conn.close()

    @contextmanager
    def read(self):
        if self.is_pg:
            with self._pg_conn() as conn:
                yield Tx(conn, True)
                conn.rollback()
        else:
            conn = self._sqlite_conn()
            try:
                yield Tx(conn, False)
            finally:
                conn.close()

    # ---------- schema ----------
    def migrate(self):
        sql = SCHEMA_PATH.read_text()
        statements = [s.strip() for s in sql.split(";") if s.strip()]
        with self.tx() as t:
            for s in statements:
                t.run(s)

    def close(self):
        if self.is_pg and self.pool is not None:
            self.pool.close()


def next_id(t: Tx, name: str, prefix: str) -> str:
    """Atomic counter (row lock on PostgreSQL, write lock on SQLite)."""
    value = t.scalar("UPDATE counters SET value = value + 1 WHERE name = ? RETURNING value", name)
    if value is None:
        t.run("INSERT INTO counters (name, value) VALUES (?, ?)", name, 100)
        value = 100
    return f"{prefix}-{value}"


_db = None


def get_db() -> Database:
    global _db
    if _db is None:
        from .config import settings

        _db = Database(settings.database_url, settings.db_pool_size)
    return _db


def set_db(db: Database):
    global _db
    _db = db

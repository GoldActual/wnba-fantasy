from collections.abc import Generator

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from app.config import DATA_DIR, DATABASE_URL

engine = create_engine(
    DATABASE_URL,
    connect_args={"check_same_thread": False},
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, autocommit=False, future=True)


def init_db() -> None:
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    from app.models import Base  # imported here to avoid circular import at module load
    Base.metadata.create_all(bind=engine)
    _ensure_columns()


def _ensure_columns() -> None:
    """Idempotent ad-hoc migrations for SQLite. We don't run Alembic in
    Phase 1 (per PLAN.md / CP1 NOTES), so additive column changes get
    applied here. Each entry is `(table, column, definition)` — SQLite
    requires a NOT NULL ADD COLUMN to specify a default."""
    additions: list[tuple[str, str, str]] = [
        ("teams", "is_my_team", "BOOLEAN NOT NULL DEFAULT 0"),
    ]
    with engine.begin() as conn:
        from sqlalchemy import text
        for table, column, ddl in additions:
            existing = {
                row[1]
                for row in conn.exec_driver_sql(f"PRAGMA table_info({table})").fetchall()
            }
            if column not in existing:
                conn.exec_driver_sql(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")


def get_db() -> Generator[Session, None, None]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()

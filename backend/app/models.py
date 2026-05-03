from datetime import date, datetime, timezone

from sqlalchemy import (
    JSON,
    Boolean,
    Date,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Base(DeclarativeBase):
    pass


class Player(Base):
    __tablename__ = "players"

    id: Mapped[int] = mapped_column(primary_key=True)
    wnba_id: Mapped[int | None] = mapped_column(Integer, index=True, unique=True, nullable=True)
    espn_id: Mapped[str | None] = mapped_column(String, index=True, unique=True, nullable=True)
    name: Mapped[str] = mapped_column(String, nullable=False, index=True)
    wnba_team: Mapped[str | None] = mapped_column(String, nullable=True)
    positions: Mapped[list[str]] = mapped_column(JSON, default=list, nullable=False)
    is_rookie: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    stats_source: Mapped[str] = mapped_column(String, default="wnba_actual", nullable=False)

    draft_pick: Mapped[int | None] = mapped_column(Integer, nullable=True)
    school: Mapped[str | None] = mapped_column(String, nullable=True)
    projected_mpg: Mapped[float | None] = mapped_column(Float, nullable=True)
    override_note: Mapped[str | None] = mapped_column(String, nullable=True)

    # basketball-reference player slug (e.g. 'wilsoa01w') — used to construct
    # gamelog URLs for in-season per-game ingest. Populated by
    # scripts/discover-bbr-slugs.py via name match against the season totals page.
    bbr_slug: Mapped[str | None] = mapped_column(String, nullable=True, index=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now, nullable=False)

    stats: Mapped[list["StatsSeason"]] = relationship(back_populates="player", cascade="all, delete-orphan")
    roster_entry: Mapped["Roster | None"] = relationship(back_populates="player", uselist=False)
    injury: Mapped["Injury | None"] = relationship(back_populates="player", uselist=False)


class Team(Base):
    __tablename__ = "teams"

    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    draft_slot: Mapped[int] = mapped_column(Integer, nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    is_my_team: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)

    rosters: Mapped[list["Roster"]] = relationship(back_populates="team", cascade="all, delete-orphan")


class Roster(Base):
    """Current ownership view. UNIQUE on player_id — a player is on at most one team at a time.

    The full audit trail lives in `transactions`; this table is the fast-path lookup
    for the draft UI and current standings.
    """

    __tablename__ = "rosters"

    id: Mapped[int] = mapped_column(primary_key=True)
    team_id: Mapped[int] = mapped_column(ForeignKey("teams.id"), nullable=False, index=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), nullable=False, unique=True)
    slot: Mapped[str] = mapped_column(String, nullable=False)  # 'G' | 'F' | 'C' | 'UTIL'

    drafted_round: Mapped[int | None] = mapped_column(Integer, nullable=True)
    drafted_overall_pick: Mapped[int | None] = mapped_column(Integer, nullable=True)
    acquired_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)

    team: Mapped["Team"] = relationship(back_populates="rosters")
    player: Mapped["Player"] = relationship(back_populates="roster_entry")


class Transaction(Base):
    """Full audit log of roster changes. Source of truth for trade backdating.

    transaction_type values:
      - 'draft' — initial draft pick (Phase 1)
      - 'add'   — free-agent pickup
      - 'drop'  — release to FA
      - 'trade' — moves from from_team_id to to_team_id; effective_date controls stat attribution
      - 'team_dissolved' — TODO Phase 2: when a fantasy team drops mid-season,
                          their roster dissolves into FA on this effective_date
                          (see PLAN.md Phase 2 / "Mid-season team changes").
    """

    __tablename__ = "transactions"

    id: Mapped[int] = mapped_column(primary_key=True)
    transaction_type: Mapped[str] = mapped_column(String, nullable=False)
    player_id: Mapped[int | None] = mapped_column(ForeignKey("players.id"), nullable=True)
    from_team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id"), nullable=True)
    to_team_id: Mapped[int | None] = mapped_column(ForeignKey("teams.id"), nullable=True)

    effective_date: Mapped[date] = mapped_column(Date, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)
    notes: Mapped[str | None] = mapped_column(String, nullable=True)

    __table_args__ = (
        Index("ix_transactions_player_effective", "player_id", "effective_date"),
    )


class StatsSeason(Base):
    """One row per (player, season, source). A rookie can have both an
    'ncaa_projection' row and a 'wnba_actual' row for the same season —
    Phase 2 swaps in actuals once they have ~10 WNBA games.
    """

    __tablename__ = "stats_seasons"

    id: Mapped[int] = mapped_column(primary_key=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), nullable=False, index=True)
    season: Mapped[int] = mapped_column(Integer, nullable=False)
    source: Mapped[str] = mapped_column(String, nullable=False)  # 'wnba_actual' | 'ncaa_projection'

    games_played: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    minutes: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    points: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    rebounds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    assists: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    steals: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    blocks: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    created_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=_now, onupdate=_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("player_id", "season", "source", name="uq_stats_player_season_source"),
    )

    player: Mapped["Player"] = relationship(back_populates="stats")


class GameStats(Base):
    """One row per (player, game_date). Per-game logs scraped from
    basketball-reference's player gamelog pages. Aggregating these gives the
    season totals used by the live scoreboard.

    Pre-season the table is empty: the scoreboard view shows everyone at 0
    until games are played and ingested, by design (see memory:
    feedback_live_vs_value — live scoreboard is 2026 actuals only, no prior-
    season fallback).

    Why per-game (not season totals): supports backdated trades. When a trade's
    effective_date is set, stat attribution reads ownership windows from the
    transactions ledger and partitions a player's per-game rows accordingly.
    Season totals can't be split that way.

    `team` captures who the player suited up for that day — handles WNBA-side
    mid-season trades (the Player.wnba_team field is current-only)."""

    __tablename__ = "game_stats"

    id: Mapped[int] = mapped_column(primary_key=True)
    player_id: Mapped[int] = mapped_column(ForeignKey("players.id"), nullable=False, index=True)
    game_date: Mapped[date] = mapped_column(Date, nullable=False, index=True)
    season: Mapped[int] = mapped_column(Integer, nullable=False, index=True)
    team: Mapped[str | None] = mapped_column(String, nullable=True)
    opponent: Mapped[str | None] = mapped_column(String, nullable=True)
    is_home: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    started: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    minutes: Mapped[float] = mapped_column(Float, default=0.0, nullable=False)
    points: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    rebounds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    assists: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    steals: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    blocks: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    source: Mapped[str] = mapped_column(String, default="bbr", nullable=False)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)

    __table_args__ = (
        UniqueConstraint("player_id", "game_date", name="uq_game_stats_player_date"),
        Index("ix_game_stats_season_date", "season", "game_date"),
    )


class Injury(Base):
    """Current snapshot of ESPN injury report. Refresh = upsert by espn_player_id."""

    __tablename__ = "injuries"

    id: Mapped[int] = mapped_column(primary_key=True)
    player_id: Mapped[int | None] = mapped_column(ForeignKey("players.id"), nullable=True, unique=True)
    espn_player_id: Mapped[str] = mapped_column(String, nullable=False, index=True, unique=True)

    status: Mapped[str] = mapped_column(String, nullable=False)  # 'Out' | 'Day-To-Day' | ...
    return_date: Mapped[date | None] = mapped_column(Date, nullable=True)
    description: Mapped[str | None] = mapped_column(String, nullable=True)
    fetched_at: Mapped[datetime] = mapped_column(DateTime, default=_now, nullable=False)

    player: Mapped["Player | None"] = relationship(back_populates="injury")

"""Transactions API — pickup, trade, list, undo.

Per league rules each team gets 4 transactions per season (2 strategic +
2 injury). Counted by distinct event_id involving the team. The 'draft'
rows from CP5 are excluded (event_id is null on them).
"""
from __future__ import annotations

from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.db import get_db
from app.models import Player, Team, Transaction
from app.transactions import (
    INJURY_PER_TEAM,
    STRATEGIC_PER_TEAM,
    TRANSACTIONS_PER_TEAM,
    TransactionError,
    delete_event,
    record_pickup,
    record_trade,
    usage_by_team,
)

router = APIRouter()


class PickupRequest(BaseModel):
    team_id: int
    add_player_id: int
    drop_player_id: int
    effective_date: date | None = None
    category: str = Field(default="strategic", pattern="^(strategic|injury)$")
    note: str | None = None


class TradeRequest(BaseModel):
    team_a_id: int
    team_a_player_id: int
    team_b_id: int
    team_b_player_id: int
    effective_date: date | None = None
    category: str = Field(default="strategic", pattern="^(strategic|injury)$")
    note: str | None = None


def _serialize_event(rows: list[Transaction], teams_by_id: dict[int, Team], players_by_id: dict[int, Player]) -> dict:
    """Group rows under one event_id into a single audit-log entry."""
    if not rows:
        return {}
    rows = sorted(rows, key=lambda r: r.id)
    sample = rows[0]
    legs = []
    for r in rows:
        legs.append({
            "transaction_type": r.transaction_type,
            "player_id": r.player_id,
            "player_name": players_by_id[r.player_id].name if r.player_id in players_by_id else None,
            "from_team_id": r.from_team_id,
            "from_team_name": teams_by_id[r.from_team_id].name if r.from_team_id in teams_by_id else None,
            "to_team_id": r.to_team_id,
            "to_team_name": teams_by_id[r.to_team_id].name if r.to_team_id in teams_by_id else None,
        })
    teams_involved: set[int] = set()
    for r in rows:
        for tid in (r.from_team_id, r.to_team_id):
            if tid is not None:
                teams_involved.add(tid)
    # Event "type" = 'trade' if both legs are trade rows, 'pickup' if add+drop pair.
    types = {r.transaction_type for r in rows}
    if "trade" in types:
        event_type = "trade"
    elif types == {"add", "drop"}:
        event_type = "pickup"
    else:
        event_type = "/".join(sorted(types))
    return {
        "event_id": sample.event_id,
        "event_type": event_type,
        "category": sample.category,
        "effective_date": sample.effective_date.isoformat(),
        "created_at": sample.created_at.isoformat(),
        "note": sample.notes,
        "teams_involved": sorted(teams_involved),
        "legs": legs,
    }


@router.get("/transactions")
def list_transactions(db: Session = Depends(get_db)) -> dict:
    rows = list(
        db.scalars(
            select(Transaction).where(Transaction.event_id.is_not(None)).order_by(Transaction.effective_date.desc(), Transaction.id.desc())
        ).all()
    )
    teams_by_id = {t.id: t for t in db.scalars(select(Team)).all()}
    players_by_id = {p.id: p for p in db.scalars(select(Player)).all()}

    by_event: dict[str, list[Transaction]] = defaultdict(list)
    for r in rows:
        by_event[r.event_id].append(r)

    events_sorted = sorted(
        by_event.values(),
        key=lambda group: (group[0].effective_date, group[0].id),
        reverse=True,
    )
    serialized = [_serialize_event(group, teams_by_id, players_by_id) for group in events_sorted]

    usage = usage_by_team(db)
    return {
        "events": serialized,
        "usage": [
            {
                "team_id": u.team_id,
                "team_name": teams_by_id[u.team_id].name if u.team_id in teams_by_id else None,
                "strategic_used": u.strategic,
                "injury_used": u.injury,
                "total_used": u.total,
                "strategic_remaining": max(0, STRATEGIC_PER_TEAM - u.strategic),
                "injury_remaining": max(0, INJURY_PER_TEAM - u.injury),
                "total_remaining": max(0, TRANSACTIONS_PER_TEAM - u.total),
            }
            for u in usage.values()
        ],
        "limits": {
            "per_team": TRANSACTIONS_PER_TEAM,
            "strategic_per_team": STRATEGIC_PER_TEAM,
            "injury_per_team": INJURY_PER_TEAM,
        },
    }


@router.post("/transactions/pickup", status_code=201)
def post_pickup(req: PickupRequest, db: Session = Depends(get_db)) -> dict:
    try:
        event_id = record_pickup(
            db,
            team_id=req.team_id,
            add_player_id=req.add_player_id,
            drop_player_id=req.drop_player_id,
            effective_date=req.effective_date,
            category=req.category,
            note=req.note,
        )
    except TransactionError as e:
        raise HTTPException(400, str(e)) from e
    db.commit()
    return {"event_id": event_id}


@router.post("/transactions/trade", status_code=201)
def post_trade(req: TradeRequest, db: Session = Depends(get_db)) -> dict:
    try:
        event_id = record_trade(
            db,
            team_a_id=req.team_a_id,
            team_a_player_id=req.team_a_player_id,
            team_b_id=req.team_b_id,
            team_b_player_id=req.team_b_player_id,
            effective_date=req.effective_date,
            category=req.category,
            note=req.note,
        )
    except TransactionError as e:
        raise HTTPException(400, str(e)) from e
    db.commit()
    return {"event_id": event_id}


@router.delete("/transactions/{event_id}")
def undo_event(event_id: str, db: Session = Depends(get_db)) -> dict:
    try:
        deleted = delete_event(db, event_id)
    except TransactionError as e:
        raise HTTPException(404, str(e)) from e
    db.commit()
    return {"deleted_rows": deleted, "event_id": event_id}

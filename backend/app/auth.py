"""Admin-token gate for write endpoints.

Single-user app, so a single shared secret is the right shape — no user
table, no sessions, no OAuth dance. The token lives in env var
WNBA_ADMIN_TOKEN, set by the systemd unit's EnvironmentFile on the Pi
(or by launch.bat in local dev). Every write endpoint depends on
`require_admin`; reads stay public so the friend on the Tailscale Funnel
URL can browse without a token.

Header (not cookie) so the public spectator path is genuinely
cookie-free and we sidestep CSRF entirely. Frontend stores it in
localStorage and attaches it via `apiFetch`.

Fail-closed: if the env var is unset, every write returns 503 rather
than silently allowing admin. A misconfigured Pi never grants access.
"""
from __future__ import annotations

import hmac
import os

from fastapi import Header, HTTPException


def require_admin(x_admin_token: str | None = Header(default=None, alias="X-Admin-Token")) -> None:
    expected = os.environ.get("WNBA_ADMIN_TOKEN")
    if not expected:
        raise HTTPException(
            status_code=503,
            detail="admin auth not configured (WNBA_ADMIN_TOKEN unset)",
        )
    if not x_admin_token or not hmac.compare_digest(x_admin_token, expected):
        raise HTTPException(
            status_code=401,
            detail="admin token required",
            headers={"WWW-Authenticate": "X-Admin-Token"},
        )

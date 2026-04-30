"""Shared HTTP client for all scrapers.

Skeleton for Checkpoint 1 — body fills in at Checkpoint 2 once we know
which endpoints we're hitting. The shape is fixed now so every scraper
goes through the same rate-limited, identifying client.
"""
from __future__ import annotations

import time

import requests

from app.config import SCRAPE_MIN_INTERVAL_SECONDS, SCRAPE_USER_AGENT


class RateLimitedSession:
    """Wraps requests.Session with a User-Agent and a minimum gap between requests."""

    def __init__(self, min_interval_seconds: float = SCRAPE_MIN_INTERVAL_SECONDS) -> None:
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": SCRAPE_USER_AGENT})
        self.min_interval = min_interval_seconds
        self._last_request_at: float = 0.0

    def get(self, url: str, **kwargs) -> requests.Response:
        elapsed = time.monotonic() - self._last_request_at
        if elapsed < self.min_interval:
            time.sleep(self.min_interval - elapsed)
        response = self.session.get(url, timeout=30, **kwargs)
        self._last_request_at = time.monotonic()
        return response

"""Print the sample report against the current DB. No scraping.

Usage:
    python scripts/report.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from app.db import SessionLocal
from app.reports import print_sample_report


def main() -> None:
    with SessionLocal() as db:
        print_sample_report(db)


if __name__ == "__main__":
    main()

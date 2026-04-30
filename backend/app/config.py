from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent.parent
DATA_DIR = BACKEND_DIR / "data"
DB_PATH = DATA_DIR / "wnba.db"
DATABASE_URL = f"sqlite:///{DB_PATH.as_posix()}"

SCRAPE_USER_AGENT = (
    "WNBAFantasyTracker/0.1 (personal-use; contact: goldactual@gmail.com)"
)
SCRAPE_MIN_INTERVAL_SECONDS = 3.0

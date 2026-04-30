# WNBA Fantasy Draft & Season Tracker

Personal tool for a season-long WNBA fantasy league. See `PLAN.md` for the full spec and `NOTES.md` for ongoing decisions.

## Run

Two terminals.

**Backend** (FastAPI on :8000):

```bash
cd backend
python -m venv .venv
.venv\Scripts\activate          # Windows
# source .venv/bin/activate     # macOS/Linux
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

**Frontend** (Vite on :5173):

```bash
cd frontend
npm install
npm run dev
```

Open http://localhost:5173. The frontend proxies `/api/*` to the backend.

## Project layout

- `backend/` — FastAPI + SQLAlchemy 2.0 + SQLite. DB file lives at `backend/data/wnba.db` (auto-created on first run).
- `frontend/` — React + TypeScript + Vite + Tailwind v4.
- `PLAN.md` — full multi-phase build plan.
- `NOTES.md` — running log of decisions and known issues.

## Status

Checkpoint 1 (project scaffold). See `PLAN.md` for the full checkpoint sequence.

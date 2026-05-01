@echo off
REM Pull fresh WNBA.com / ESPN / Rotowire / sports-reference data.
REM Idempotent. Never touches rosters or transactions, so it's safe to
REM run mid-draft if needed. Takes ~3 minutes at the rate-limited pace.

cd /d %~dp0backend
.venv\Scripts\python scripts\refresh.py
echo.
echo ----------------------------------------
echo Refresh complete. Press any key to close.
pause >nul

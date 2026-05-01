@echo off
REM WNBA Fantasy launcher. Opens backend + frontend dev servers in
REM separate console windows, then opens the app in the default browser.
REM Close the console windows to stop the servers.

start "WNBA Backend"  cmd /k "cd /d %~dp0backend  && .venv\Scripts\python -m uvicorn app.main:app --reload"
start "WNBA Frontend" cmd /k "cd /d %~dp0frontend && npm run dev"

REM Give Vite a few seconds to boot, then open the browser.
timeout /t 4 /nobreak >nul
start "" "http://localhost:5173/"

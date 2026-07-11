@echo off
cd /d "%~dp0src"
py -m uvicorn admin_app:app --host 127.0.0.1 --port 8765 --reload --reload-dir . --reload-dir ..\admin --timeout-graceful-shutdown 3
pause
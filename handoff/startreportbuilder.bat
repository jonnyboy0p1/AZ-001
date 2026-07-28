@echo off
setlocal
cd /d "%~dp0"

set "PYTHON_EXE=C:\Users\jonavroa\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"
set "PORT=4173"

echo Fluid West Handoff Builder
echo.
echo Starting local server at:
echo http://127.0.0.1:%PORT%/index.html
echo.
echo Keep this window open while using the report builder.
echo Press Ctrl+C to stop the server.
echo.

if exist "%PYTHON_EXE%" (
  "%PYTHON_EXE%" -m http.server %PORT% --bind 127.0.0.1
) else (
  python -m http.server %PORT% --bind 127.0.0.1
)

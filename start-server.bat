@echo off
cd /d "%~dp0"
echo Starting RB20 server on http://127.0.0.1:5220/
python server.py
pause

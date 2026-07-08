@echo off
cd /d "%~dp0"
echo Starting OB Period Report Card server on http://127.0.0.1:5220/
echo Make sure mwinit has been run so the server can reach FCLM and MonitorPortal.
python server.py
pause

@echo off
REM OB Period Report Card — RB021
REM Project folder: C:\Users\rja09\OneDrive\Desktop\RB021
cd /d "%~dp0"
echo Starting RB021 server on http://127.0.0.1:5220/
echo Project folder: %~dp0
echo Make sure mwinit has been run so the server can reach FCLM and MonitorPortal.
python server.py
pause

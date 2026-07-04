@echo off
rem One-click start for the RFD2 Quality Bridge.
rem Put this next to server.js and fhnsquality.html
rem (C:\Users\jonavroa\Desktop\Quality) and double-click it.

cd /d "%~dp0"

rem Start the bridge server in its own window (leave it running all shift)
start "Quality Bridge Server" cmd /k node server.js

rem Give the server a moment, then open the FHNs Quality page
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4800/fhns#byday"

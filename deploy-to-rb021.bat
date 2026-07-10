@echo off
setlocal EnableExtensions

REM Copy the latest RB021 dashboard files to your OneDrive Desktop folder.
set "TARGET=C:\Users\rja09\OneDrive\Desktop\RB021"
set "SOURCE=%~dp0"

if not exist "%TARGET%" (
  echo Creating %TARGET%
  mkdir "%TARGET%"
)

echo.
echo Deploying RB021 from:
echo   %SOURCE%
echo to:
echo   %TARGET%
echo.

for %%F in (
  index.html
  app.js
  styles.css
  server.py
  server.js
  package.json
  config.json
  start-server.bat
  deploy-to-rb021.bat
) do (
  if exist "%SOURCE%%%F" (
    copy /Y "%SOURCE%%%F" "%TARGET%\%%F" >nul
    echo   copied %%F
  )
)

echo.
echo Done.
echo Open: file:///C:/Users/rja09/OneDrive/Desktop/RB021/index.html
echo Or run: start-server.bat  then  http://127.0.0.1:5220/
echo.
pause

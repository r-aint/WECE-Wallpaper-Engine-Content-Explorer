@echo off
rem ============================================================
rem  Wallpaper Engine Content Manager - launcher
rem  Double-click this file to start. Same as "npm start".
rem ============================================================
setlocal

set "APP_DIR=%~dp0"
if "%APP_DIR:~-1%"=="\" set "APP_DIR=%APP_DIR:~0,-1%"
set "ELECTRON=%APP_DIR%\node_modules\electron\dist\electron.exe"

if not exist "%ELECTRON%" (
  echo.
  echo  [ERROR] Electron runtime not found:
  echo          %ELECTRON%
  echo.
  echo  Please run "npm install" in the project folder first.
  echo.
  pause
  exit /b 1
)

rem "start" launches Electron detached; this console window closes immediately.
start "" "%ELECTRON%" "%APP_DIR%"

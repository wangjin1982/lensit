@echo off
rem LensIt launcher (ASCII-only + CRLF, see README)
cd /d "%~dp0"
if not exist node_modules\electron\dist\electron.exe (
  echo Dependencies missing. Run: npm install
  pause
  exit /b 1
)
start "" "node_modules\electron\dist\electron.exe" .

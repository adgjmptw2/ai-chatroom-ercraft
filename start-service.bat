@echo off
cd /d "%~dp0"
node scripts\service.mjs run
if errorlevel 1 pause

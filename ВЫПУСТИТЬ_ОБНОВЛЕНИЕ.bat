@echo off
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
    echo.
    echo Node.js not found in PATH. Install from nodejs.org and restart.
    pause
    exit /b 1
)
node release_helper.js
echo.
pause
exit /b %errorlevel%
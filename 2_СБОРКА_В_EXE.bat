@echo off
cd /d "%~dp0"
call npm run build
if errorlevel 1 (
    echo.
    echo BUILD FAILED. Code: %errorlevel%
    pause
    exit /b 1
)
echo.
echo OK. Installer: dist\ZapretGUISetup.exe
pause
exit /b 0
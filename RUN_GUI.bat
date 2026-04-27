@echo off
setlocal

:: Fix trailing backslash for WorkingDirectory
set "SD=%~dp0"
if "%SD:~-1%"=="\" set "SD=%SD:~0,-1%"

:: Check for admin rights
net session >nul 2>&1
if %errorLevel% neq 0 (
    echo [INFO] Requesting admin privileges...
    powershell -Command "Start-Process cmd -ArgumentList '/k \"\"%~f0\"\"' -WorkingDirectory '%SD%' -Verb RunAs"
    exit /b
)

:: Now in admin mode
echo [OK] Running as Administrator.
cd /d "%~dp0"

:: Check for Node.js
where node >nul 2>&1
if %errorLevel% neq 0 (
    echo [CRITICAL] Node.js not found! Please install Node.js from nodejs.org
    pause
    exit /b
)

:: Check for node_modules
if not exist node_modules (
    echo [INFO] node_modules not found. Running npm install...
    npm install
)

echo [INFO] Starting application...
npm start

if %errorLevel% neq 0 (
    echo [ERROR] Application failed with code %errorLevel%.
)

pause

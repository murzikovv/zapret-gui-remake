@echo off
chcp 65001 > nul
echo ========================================================
echo   ЗАПУСК СЕРВЕРА АНАЛИТИКИ И ТУННЕЛЯ В ИНТЕРНЕТ
echo ========================================================
echo.
echo 1. Установка зависимости (localtunnel)...
cd analytics-server
call npm install localtunnel --no-fund --no-audit

echo 2. Запуск туннеля и сервера...
node start_with_tunnel.js
pause

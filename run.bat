@echo off
chcp 65001 > nul
title MUSE AI TOOL - STUDIO BRIDGE (Node.js)
cd /d "%~dp0node"
echo ========================================================
echo         MUSE AI TOOL - CHAT SYNC BRIDGE (Node.js)
echo   Dang khoi dong server tai http://localhost:5000 ...
echo   (Neu server tu dung vi loi, no se tu bat lai sau 2 giay)
echo ========================================================
echo.

if not exist node_modules (
    echo [Thieu thu vien] Dang cai dat cac thu vien can thiet...
    call npm install
    echo.
) else (
    echo [OK] Da co du thu vien, bo qua buoc cai dat.
)

start "" "http://localhost:5000/trieu-dinh"
:loop
node server.js
echo.
echo [Server da dung - dang bat lai...]
timeout /t 2 /nobreak > nul
goto loop

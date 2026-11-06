@echo off
chcp 65001 > nul
title MUSE AI TOOL - TAILSCALE (Node.js)
set MUSE_PUBLIC=1
set MUSE_HOST=0.0.0.0
echo ========================================================
echo   CHE DO TAILSCALE: may khac trong mang Tailscale cua ban
echo   vao duoc Tool qua IP Tailscale cua may nay, co mat khau.
echo   Mat khau nam o: %~dp0node\data\password.txt (hoac bien MUSE_PASSWORD)
echo ========================================================
tailscale ip -4
echo.
echo Tren thiet bi khac (da noi Tailscale) mo:  http://IP-o-tren:5000/connect
echo.
cd /d "%~dp0node"
if not exist node_modules (
    echo [Thieu thu vien] Dang cai dat cac thu vien can thiet...
    call npm install
    echo.
)
:loop
node server.js
echo [Server da dung - bat lai sau 2 giay]
timeout /t 2 /nobreak > nul
goto loop

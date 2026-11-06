@echo off
chcp 65001 > nul
title MUSE AI TOOL - LAN (Node.js)
echo ========================================================
echo   Che do MANG NOI BO: may khac trong cung mang nhin thay Tool
echo   Khong co mat khau - chi dung o mang tin cay!
echo ========================================================
ipconfig | findstr /i "IPv4"
echo.
echo Tren may khac mo:  http://IP-o-tren:5000/connect
echo.
set MUSE_HOST=0.0.0.0
cd /d "%~dp0node"
if not exist node_modules (
    echo [Thieu thu vien] Dang cai dat cac thu vien can thiet...
    call npm install
    echo.
)
start "" "http://localhost:5000/trieu-dinh"
node server.js
pause

@echo off
chcp 65001 > nul
title MUSE AI TOOL - LAN
echo ========================================================
echo   Che do MANG NOI BO: may khac trong cung mang nhin thay Tool
echo   Khong co mat khau - chi dung o mang tin cay!
echo ========================================================
ipconfig | findstr /i "IPv4"
echo.
echo Tren may khac mo:  http://IP-o-tren:5000/connect
echo.
set MUSE_HOST=0.0.0.0
start "" "http://localhost:5000/trieu-dinh"
python server.py
pause

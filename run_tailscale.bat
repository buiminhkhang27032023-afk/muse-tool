@echo off
chcp 65001 > nul
title MUSE AI TOOL - TAILSCALE
set MUSE_PUBLIC=1
set MUSE_HOST=0.0.0.0
echo ========================================================
echo   CHE DO TAILSCALE: may khac trong mang Tailscale cua ban
echo   vao duoc Tool qua IP Tailscale cua may nay, co mat khau.
echo   Mat khau nam o: %~dp0data\password.txt (hoac bien MUSE_PASSWORD)
echo ========================================================
tailscale ip -4
echo.
echo Tren thiet bi khac (da noi Tailscale) mo:  http://IP-o-tren:5000/connect
echo.
:loop
python server.py
echo [Server da dung - bat lai sau 2 giay]
timeout /t 2 /nobreak > nul
goto loop

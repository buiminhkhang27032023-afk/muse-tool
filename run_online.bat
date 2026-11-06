@echo off
chcp 65001 > nul
title MUSE AI TOOL - ONLINE
set MUSE_PUBLIC=1
set MUSE_HTTPS=1
set MUSE_PORT=5000
echo ========================================================
echo   CHE DO TEN MIEN: bat buoc dang nhap
echo   Mat khau nam o: %~dp0data\password.txt (hoac bien MUSE_PASSWORD)
echo   Dua ra Internet bang Cloudflare Tunnel: xem DEPLOY.md
echo ========================================================
:loop
python server.py
echo [Server da dung - bat lai sau 2 giay]
timeout /t 2 /nobreak > nul
goto loop

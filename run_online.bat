@echo off
chcp 65001 > nul
title MUSE AI TOOL - ONLINE (Node.js)
set MUSE_PUBLIC=1
set MUSE_HTTPS=1
set MUSE_PORT=5000
echo ========================================================
echo   CHE DO TEN MIEN: bat buoc dang nhap
echo   Mat khau nam o: %~dp0node\data\password.txt (hoac bien MUSE_PASSWORD)
echo   Dua ra Internet bang Cloudflare Tunnel: xem DEPLOY.md
echo ========================================================
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

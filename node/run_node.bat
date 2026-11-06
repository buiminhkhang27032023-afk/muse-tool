@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist node_modules (
    echo [Thieu thu vien] Dang cai dat cac thu vien can thiet cho ban Node.js...
    call npm install
    echo.
) else (
    echo [OK] Da co du thu vien, bo qua buoc cai dat.
)

echo ============================================================
echo  MUSE AI BRIDGE AND CHAT TOOL (Node.js)
echo  Mo trinh duyet tai: http://localhost:5000
echo ============================================================
node server.js
pause

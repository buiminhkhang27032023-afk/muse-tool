@echo off
chcp 65001 > nul
title MUSE AI TOOL - STUDIO BRIDGE
echo ========================================================
echo         MUSE AI TOOL - CHAT SYNC BRIDGE
echo   Dang khoi dong server tai http://localhost:5000 ...
echo   (Neu server tu dung vi loi, no se tu bat lai sau 2 giay)
echo ========================================================
echo.

python -c "import flask, flask_cors, waitress" 2>nul
if errorlevel 1 (
    echo [Thieu thu vien] Dang cai dat cac thu vien can thiet...
    pip install -r requirements.txt
    echo.
) else (
    echo [OK] Da co du thu vien, bo qua buoc cai dat.
)

start "" "http://localhost:5000/trieu-dinh"
:loop
python server.py
echo.
echo [Server da dung - dang bat lai...]
timeout /t 2 /nobreak > nul
goto loop

@echo off
cd /d D:\VATM-PMU\vatm-docmanager\vatm-app
echo === VATM Local OCR Worker ===
echo.
if not exist scripts\worker.env (
    echo [SETUP] Chua co file worker.env
    echo Sao chep scripts\worker.env.example thanh scripts\worker.env
    echo va dien email + password Firebase vao do.
    echo.
    pause
    exit /b 1
)
node --input-type=module scripts\local-ocr-worker.js
pause

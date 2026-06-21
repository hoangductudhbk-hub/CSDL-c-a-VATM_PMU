@echo off
echo === Fix git index + push ===
cd /d D:\VATM-PMU\vatm-docmanager\vatm-app

echo Xoa index corrupt...
del /f .git\index.lock 2>nul
del /f .git\index 2>nul

echo Reset git index...
git reset HEAD

echo Add va commit...
git add -A
git commit -m "fix: add Mistral to AI chain, fix test-keys 500, switch process-batch to Mistral OCR"

echo Push len GitHub...
git push

echo === XONG! ===
pause

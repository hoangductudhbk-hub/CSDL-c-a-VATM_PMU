@echo off
echo === Apply bundle + push to GitHub ===
cd /d D:\VATM-PMU\vatm-docmanager\vatm-app

echo Xoa lock files...
del /f .git\index.lock 2>nul
del /f .git\objects\multi-pack-index 2>nul

echo Fetch tu bundle...
git fetch vatm-bundle.bundle main:tmp-bundle-branch

echo Merge vao main...
git checkout main
git merge tmp-bundle-branch --no-edit

echo Push len GitHub...
git push origin main

echo Xoa branch tam...
git branch -D tmp-bundle-branch 2>nul

echo === XONG! Vercel se tu deploy ===
pause

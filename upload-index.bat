@echo off
echo ========================================
echo Uploading all changes to GitHub...
echo ========================================
git add .
set /p msg="Enter commit message (Press Enter for default): "
if "%msg%"=="" set msg="update files and folders"
git commit -m %msg%
git push -u origin main --force
echo.
echo ========================================
echo Upload completed successfully!
echo ========================================
pause
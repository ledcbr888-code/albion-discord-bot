@echo off
echo ติดตั้ง sharp (ถ้ายังไม่มี)...
call npm install sharp --save
echo.
echo เริ่มแปลง PNG -> WebP 85%%...
node compress-avalon-B-webp.js
pause

@echo off
echo ติดตั้ง sharp (ถ้ายังไม่มี)...
call npm install sharp --save
echo.
echo เริ่มบีบ PNG แบบ lossless...
node compress-avalon-A-lossless.js
pause

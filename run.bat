@echo off
chcp 65001 >nul
cd /d "%~dp0"
node --version >nul 2>&1
if errorlevel 1 (
  echo Node.js نصب نیست. ابتدا Node.js نسخه 22.5 یا جدیدتر را نصب کنید.
  pause
  exit /b 1
)
echo قطعه‌یار در حال اجراست. مرورگر را روی http://127.0.0.1:3000 باز کنید.
echo برای توقف سرور Ctrl+C را بزنید.
node server.js
pause

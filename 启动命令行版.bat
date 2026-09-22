@echo off
chcp 65001 >nul
title X-Downloader CLI
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   未找到 Node.js，请先安装：https://nodejs.org
  echo.
  pause
  exit /b 1
)

node cli.js %*
echo.
pause

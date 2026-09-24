@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

node server.js
goto END

:NONODE
echo.
echo   [ERROR] Node.js not found.
echo   Please install it from: https://nodejs.org
echo.
pause
exit /b 1

:END
echo.
echo   Server stopped.
pause

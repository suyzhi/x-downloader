@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 goto NONODE

if "%~1"=="" goto INTERACTIVE
node cli.js %*
goto END

:INTERACTIVE
node cli.js
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
echo   Done.
pause

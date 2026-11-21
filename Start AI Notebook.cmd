@echo off
setlocal
pushd "%~dp0"
where npm.cmd >nul 2>nul
if errorlevel 1 goto missing_npm
if not exist "node_modules\.bin\electron.cmd" (
  call npm.cmd ci
  if errorlevel 1 goto failed
)
call npm.cmd start
if errorlevel 1 goto failed
popd
exit /b 0

:missing_npm
echo Install Node.js and npm, then reopen this file.
:failed
pause
popd
exit /b 1

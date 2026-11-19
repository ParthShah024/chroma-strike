@echo off
setlocal
cd /d "%~dp0"

set "PORTABLE_NODE=%LOCALAPPDATA%\nodejs-portable\node-v26.13.1-win-x64"
if exist "%PORTABLE_NODE%\node.exe" (
    set "PATH=%PORTABLE_NODE%;%PATH%"
)

where node >nul 2>&1
if errorlevel 1 (
    echo [Chroma Strike] Node.js was not found on PATH or at "%PORTABLE_NODE%".
    echo Please install Node.js LTS from https://nodejs.org/ and run this script again.
    pause
    exit /b 1
)

if not exist "node_modules" (
    echo [Chroma Strike] Installing dependencies...
    call npm install
)

echo [Chroma Strike] Starting 6-Player Single-Port Server on http://0.0.0.0:5174/ ...
start "Chroma Strike MP Server" /min node ".\server\gameServer.mjs"
echo [Chroma Strike] Starting Vite dev server on http://0.0.0.0:5173/ ...
start "" "http://127.0.0.1:5173/"
node ".\node_modules\vite\bin\vite.js" --port 5173 --host 0.0.0.0

@echo off
rem Starts Clipper Studio (local only) and opens it in your browser. Close this window to stop it.
cd /d "%~dp0"
if not exist "web\dist\index.html" (
  echo The interface is not built yet. Building it once...
  pushd web
  set NODE_OPTIONS=--use-system-ca
  call npm run build || (echo Build failed. & pause & exit /b 1)
  popd
)
start "" http://127.0.0.1:8765
".venv\Scripts\python.exe" -m server --port 8765
pause

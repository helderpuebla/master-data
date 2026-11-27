@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo Node.js nao foi encontrado neste computador.
    pause
    exit /b 1
)

node --use-system-ca servidor-site.cjs
if errorlevel 1 (
    echo O servidor web foi encerrado com erro.
    pause
    exit /b 1
)

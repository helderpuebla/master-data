@echo off
setlocal
cd /d "%~dp0"

if exist "%~dp0atualizar-materiais.exe" (
    "%~dp0atualizar-materiais.exe"
) else (
    where python >nul 2>nul
    if errorlevel 1 (
        echo Python nao foi encontrado neste computador.
        pause
        exit /b 1
    )
    python "%~dp0atualizar-materiais.py"
)

if errorlevel 1 (
    echo A sincronizacao terminou com erro.
    pause
    exit /b 1
)

pause

@echo off
:: Obsidian API Sync - Windows Startup Script
cd /d "%~dp0\server"

:: Ensure virtual environment exists
if not exist ".venv\Scripts\activate.bat" (
    echo [ERROR] Virtual environment not found. Please run setup first.
    exit /b 1
)

:: Activate and run
call .venv\Scripts\activate.bat
uvicorn main:app --host 0.0.0.0 --port 8000

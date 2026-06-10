#!/bin/bash
# Obsidian API Sync - Linux/macOS Startup Script

# Navigate to the server directory relative to this script
cd "$(dirname "$0")/server"

# Ensure virtual environment exists
if [ ! -f ".venv/bin/activate" ]; then
    echo "[ERROR] Virtual environment not found. Please run setup first."
    exit 1
fi

# Activate and run
source .venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8000

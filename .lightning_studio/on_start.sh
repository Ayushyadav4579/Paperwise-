#!/usr/bin/env bash
set -euo pipefail
cd "${PAPERWISE_HOME:-$HOME/Paperwise-}"
if [ ! -d server ]; then
  echo "Paperwise server directory missing at $PWD/server; clone the repository or set PAPERWISE_HOME." >&2
  exit 1
fi
python -m pip install -r server/requirements.txt
mkdir -p "$HOME/.cache/paperwise"
# Keep logs persistent across restarts.
nohup python -m uvicorn server.app:app --host 0.0.0.0 --port "${PORT:-8000}" \
  >> "$HOME/.cache/paperwise/api.log" 2>&1 &
echo $! > "$HOME/.cache/paperwise/api.pid"

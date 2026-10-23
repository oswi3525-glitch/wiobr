#!/bin/bash
# WioBrowse Cloud startup loop for container hosting (e.g. Pterodactyl / Games panel).
#
# Behavior:
#   1. Ensures a git repo exists in WORKDIR and tracks origin/main.
#   2. Fetches + hard-resets to origin/main every loop iteration.
#   3. Runs npm ci / install and npm run build whenever code changes or node_modules is missing.
#   4. Starts the server. .env is sourced ONLY inside a subshell so its variables
#      (e.g. NODE_ENV=production) do NOT leak into this loop's environment.
#      Without this, npm would see NODE_ENV=production on the next build and skip
#      devDependencies (like Vite), breaking the build.
#   5. While the server runs, polls origin/main every 60s; on update, restarts the server.
#
# Required env on the host: none. The script is self-contained.

set -u

N=/usr/local/bin/npm
U=https://github.com/oswi3525-glitch/wiobr.git
WORKDIR=/home/container

cd "$WORKDIR" || exit 1

# --- Ensure git remote points at the right repo --------------------------------
if [ -d .git ]; then
  git remote set-url origin "$U" 2>/dev/null || git remote add origin "$U"
else
  git init -q
  git remote add origin "$U"
fi

# Allow building native modules from source if prebuilt binaries are unavailable.
export npm_config_build_from_source=true
export npm_config_jobs=1

LAST_HEAD=""

while true; do
  # --- Fetch latest code ---------------------------------------------------------
  if ! git fetch -q origin main; then
    echo "[warn] git fetch failed, retrying in 60s" >&2
    sleep 60
    continue
  fi
  git reset -q --hard origin/main

  HEAD=$(git rev-parse HEAD 2>/dev/null)
  if [ -z "$HEAD" ]; then
    echo "[warn] no code checked out, retrying in 60s" >&2
    sleep 60
    continue
  fi

  # --- Install / build when code changed or node_modules missing ----------------
  if [ "$HEAD" != "$LAST_HEAD" ] || [ ! -d node_modules ]; then
    if [ -f package-lock.json ]; then
      "$N" ci --no-audit --no-fund \
        || { echo "[warn] npm ci failed, retrying in 60s" >&2; sleep 60; continue; }
    else
      "$N" install --no-audit --no-fund \
        || { echo "[warn] npm install failed, retrying in 60s" >&2; sleep 60; continue; }
    fi
    "$N" run build --if-present \
      || { echo "[warn] npm run build failed, retrying in 60s" >&2; sleep 60; continue; }
    LAST_HEAD="$HEAD"
  fi

  # --- Start server --------------------------------------------------------------
  # Source .env inside a subshell so its vars do not leak into this loop's
  # environment (critical: NODE_ENV must not pollute the loop shell).
  if [ -f .env ]; then
    (
      set -a
      . ./.env
      exec "$N" start
    ) &
  else
    setsid "$N" start &
  fi
  PID=$!

  # --- Watch for updates while the server is running -----------------------------
  while kill -0 "$PID" 2>/dev/null; do
    sleep 60
    if git fetch -q origin main; then
      NEW_HEAD=$(git rev-parse origin/main 2>/dev/null)
      if [ -n "$NEW_HEAD" ] && [ "$HEAD" != "$NEW_HEAD" ]; then
        echo "[info] update detected on origin/main, restarting server" >&2
        kill -TERM -- "-$PID" 2>/dev/null
        sleep 5
        kill -KILL -- "-$PID" 2>/dev/null
        break
      fi
    fi
  done

  wait "$PID" 2>/dev/null
  sleep 5
done
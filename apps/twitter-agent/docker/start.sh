#!/usr/bin/env bash
# Runs both processes in one container for the simplest possible single-service
# deploy on Render/Railway: the APScheduler loop (agent/main.py) in the
# background, and the FastAPI dashboard (dashboard/app.py) in the foreground
# so Docker's process supervisor tracks the container's health via it.
# For a more resilient two-service deployment, run these as separate Railway/
# Render services instead — see README.md's "Deployment" section.
set -euo pipefail

python -m agent.main &
SCHEDULER_PID=$!

trap 'kill -TERM $SCHEDULER_PID 2>/dev/null || true' TERM INT

uvicorn dashboard.app:app --host "${DASHBOARD_HOST:-0.0.0.0}" --port "${DASHBOARD_PORT:-8080}" &
DASHBOARD_PID=$!

wait -n $SCHEDULER_PID $DASHBOARD_PID
EXIT_CODE=$?
kill -TERM $SCHEDULER_PID $DASHBOARD_PID 2>/dev/null || true
exit $EXIT_CODE

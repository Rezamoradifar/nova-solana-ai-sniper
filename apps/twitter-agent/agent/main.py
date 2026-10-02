"""Entrypoint for the scheduler process (the dashboard is a separate
process — see docker/start.sh — since a web server and a long-lived
background scheduler have different restart/health-check needs)."""

from __future__ import annotations

import logging
import signal
import time

from apscheduler.schedulers.background import BackgroundScheduler

from agent import scheduler as agent_scheduler
from core.config import settings
from memory.db import init_db

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(name)s: %(message)s",
)
logger = logging.getLogger("agent.main")


def main() -> None:
    logger.info("Starting %s scheduler...", settings.agent_name)
    init_db()

    scheduler = BackgroundScheduler(timezone="UTC")
    agent_scheduler.start(scheduler)
    scheduler.start()
    logger.info("Scheduler started. Jobs: %s", [j.id for j in scheduler.get_jobs()])

    stop = {"flag": False}

    def _handle_signal(*_args):
        stop["flag"] = True

    signal.signal(signal.SIGTERM, _handle_signal)
    signal.signal(signal.SIGINT, _handle_signal)

    try:
        while not stop["flag"]:
            time.sleep(1)
    finally:
        logger.info("Shutting down scheduler...")
        scheduler.shutdown(wait=False)


if __name__ == "__main__":
    main()

"""
Entry point for the DexScreener data ingestion system.

Usage:
    python main.py

Environment variables are loaded from .env (see .env.example).
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from logging.handlers import RotatingFileHandler

from config import Config
from database import DatabaseManager
from ingestion import DexScreenerIngestion


def setup_logging(config: Config) -> None:
    """
    Configure the root logger with:
    - A RotatingFileHandler (10 MB per file, 5 backups) writing to LOG_DIR/ingestion.log
    - A StreamHandler writing to stdout
    Both handlers use the same level (LOG_LEVEL from config).
    """
    log_dir = config.log_dir
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, "ingestion.log")

    level_name = config.log_level.upper()
    level = getattr(logging, level_name, logging.INFO)

    formatter = logging.Formatter(
        fmt="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
        datefmt="%Y-%m-%dT%H:%M:%S%z",
    )

    file_handler = RotatingFileHandler(
        filename=log_file,
        maxBytes=10 * 1024 * 1024,  # 10 MB
        backupCount=5,
        encoding="utf-8",
    )
    file_handler.setLevel(level)
    file_handler.setFormatter(formatter)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setLevel(level)
    console_handler.setFormatter(formatter)

    root_logger = logging.getLogger()
    root_logger.setLevel(level)
    # Remove any pre-existing handlers to avoid duplicate output
    root_logger.handlers.clear()
    root_logger.addHandler(file_handler)
    root_logger.addHandler(console_handler)

    # Suppress noisy third-party loggers
    logging.getLogger("asyncio").setLevel(logging.WARNING)
    logging.getLogger("aiohttp").setLevel(logging.WARNING)
    logging.getLogger("asyncpg").setLevel(logging.WARNING)


async def main() -> None:
    """Application entry point."""
    config = Config()
    setup_logging(config)

    logger = logging.getLogger(__name__)
    logger.info(
        "DexScreener ingestion starting up "
        "(sync_interval=%ds, request_delay=%dms, max_retries=%d)",
        config.sync_interval_seconds,
        config.request_delay_ms,
        config.max_retries,
    )

    db = DatabaseManager()
    await db.initialize(config)

    ingestion = DexScreenerIngestion(config, db)
    try:
        await ingestion.run_forever()
    except Exception:
        logger.exception("Fatal error in ingestion loop")
        sys.exit(1)
    finally:
        await db.close()
        logger.info("DexScreener ingestion shut down cleanly")


if __name__ == "__main__":
    asyncio.run(main())

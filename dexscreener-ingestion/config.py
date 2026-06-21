"""
Configuration module for DexScreener ingestion system.
Loads settings from environment variables / .env file using python-dotenv.
"""

import os
from dataclasses import dataclass, field
from dotenv import load_dotenv

load_dotenv()


@dataclass
class Config:
    """Application configuration loaded from environment variables."""

    # Database
    database_url: str = field(default_factory=lambda: os.environ.get(
        "DATABASE_URL", "postgresql://user:password@localhost:5432/dexscreener"
    ))

    # Logging
    log_level: str = field(default_factory=lambda: os.environ.get("LOG_LEVEL", "INFO"))
    log_dir: str = field(default_factory=lambda: os.environ.get("LOG_DIR", "logs"))

    # Sync behaviour
    sync_interval_seconds: int = field(default_factory=lambda: int(
        os.environ.get("SYNC_INTERVAL_SECONDS", "30")
    ))

    # HTTP / rate-limiting
    request_delay_ms: int = field(default_factory=lambda: int(
        os.environ.get("REQUEST_DELAY_MS", "300")
    ))
    max_retries: int = field(default_factory=lambda: int(
        os.environ.get("MAX_RETRIES", "5")
    ))
    retry_base_delay: float = field(default_factory=lambda: float(
        os.environ.get("RETRY_BASE_DELAY", "1.0")
    ))

    # Database pool
    max_connections: int = field(default_factory=lambda: int(
        os.environ.get("MAX_CONNECTIONS", "10")
    ))

    def __post_init__(self) -> None:
        if not self.database_url:
            raise ValueError("DATABASE_URL must be set in environment or .env file")
        if self.sync_interval_seconds < 1:
            raise ValueError("SYNC_INTERVAL_SECONDS must be >= 1")
        if self.request_delay_ms < 0:
            raise ValueError("REQUEST_DELAY_MS must be >= 0")
        if self.max_retries < 0:
            raise ValueError("MAX_RETRIES must be >= 0")
        if self.retry_base_delay <= 0:
            raise ValueError("RETRY_BASE_DELAY must be > 0")
        if self.max_connections < 1:
            raise ValueError("MAX_CONNECTIONS must be >= 1")

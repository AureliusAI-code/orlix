"""
Database layer for DexScreener ingestion.
Uses asyncpg for non-blocking PostgreSQL access.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any, Optional

import asyncpg

from config import Config
from models import Pair, Token, TokenBoost, TokenProfile

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# DDL
# ---------------------------------------------------------------------------

_DDL_TOKENS = """
CREATE TABLE IF NOT EXISTS tokens (
    address       TEXT        NOT NULL,
    chain_id      TEXT        NOT NULL,
    name          TEXT,
    symbol        TEXT,
    decimals      INT,
    price_usd     NUMERIC,
    price_native  NUMERIC,
    updated_at    TIMESTAMPTZ,
    PRIMARY KEY (address, chain_id)
);
"""

_DDL_PAIRS = """
CREATE TABLE IF NOT EXISTS pairs (
    pair_address        TEXT        NOT NULL,
    chain_id            TEXT        NOT NULL,
    dex_id              TEXT,
    base_token_address  TEXT,
    base_token_symbol   TEXT,
    base_token_name     TEXT,
    quote_token_address TEXT,
    quote_token_symbol  TEXT,
    price_native        NUMERIC,
    price_usd           NUMERIC,
    volume_h1           NUMERIC,
    volume_h6           NUMERIC,
    volume_h24          NUMERIC,
    price_change_m5     NUMERIC,
    price_change_h1     NUMERIC,
    price_change_h6     NUMERIC,
    price_change_h24    NUMERIC,
    liquidity_usd       NUMERIC,
    liquidity_base      NUMERIC,
    liquidity_quote     NUMERIC,
    fdv                 NUMERIC,
    market_cap          NUMERIC,
    txns_h1_buys        INT,
    txns_h1_sells       INT,
    txns_h6_buys        INT,
    txns_h6_sells       INT,
    txns_h24_buys       INT,
    txns_h24_sells      INT,
    pair_created_at     TIMESTAMPTZ,
    updated_at          TIMESTAMPTZ,
    PRIMARY KEY (pair_address, chain_id)
);
"""

_DDL_TOKEN_PROFILES = """
CREATE TABLE IF NOT EXISTS token_profiles (
    token_address TEXT        NOT NULL,
    chain_id      TEXT        NOT NULL,
    url           TEXT,
    description   TEXT,
    icon          TEXT,
    header        TEXT,
    open_graph    TEXT,
    links         JSONB,
    updated_at    TIMESTAMPTZ,
    PRIMARY KEY (token_address, chain_id)
);
"""

_DDL_TOKEN_BOOSTS = """
CREATE TABLE IF NOT EXISTS token_boosts (
    token_address TEXT        NOT NULL,
    chain_id      TEXT        NOT NULL,
    url           TEXT,
    amount        NUMERIC,
    total_amount  NUMERIC,
    boost_type    TEXT        NOT NULL DEFAULT 'unknown',
    updated_at    TIMESTAMPTZ,
    PRIMARY KEY (token_address, chain_id, boost_type)
);
"""

_DDL_RAW_API_LOG = """
CREATE TABLE IF NOT EXISTS raw_api_log (
    id            BIGSERIAL   PRIMARY KEY,
    endpoint      TEXT,
    params        JSONB,
    status_code   INT,
    response_size INT,
    fetched_at    TIMESTAMPTZ
);
"""

_DDL_INDEXES = """
CREATE INDEX IF NOT EXISTS idx_tokens_chain_id           ON tokens        (chain_id);
CREATE INDEX IF NOT EXISTS idx_pairs_chain_id            ON pairs         (chain_id);
CREATE INDEX IF NOT EXISTS idx_pairs_base_token_address  ON pairs         (base_token_address);
CREATE INDEX IF NOT EXISTS idx_token_profiles_chain_id   ON token_profiles(chain_id);
CREATE INDEX IF NOT EXISTS idx_token_boosts_chain_id     ON token_boosts  (chain_id);
CREATE INDEX IF NOT EXISTS idx_raw_api_log_fetched_at    ON raw_api_log   (fetched_at);
CREATE INDEX IF NOT EXISTS idx_raw_api_log_endpoint      ON raw_api_log   (endpoint);
"""


class DatabaseManager:
    """Manages an asyncpg connection pool and exposes upsert helpers."""

    def __init__(self) -> None:
        self._pool: Optional[asyncpg.Pool] = None

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def initialize(self, config: Config) -> None:
        """Create the connection pool and ensure all tables exist."""
        logger.info("Connecting to database (max_connections=%d)", config.max_connections)
        self._pool = await asyncpg.create_pool(
            dsn=config.database_url,
            min_size=1,
            max_size=config.max_connections,
            command_timeout=60,
        )
        await self._run_ddl()
        logger.info("Database initialised successfully")

    async def close(self) -> None:
        """Close the connection pool gracefully."""
        if self._pool is not None:
            await self._pool.close()
            self._pool = None
            logger.info("Database connection pool closed")

    @property
    def pool(self) -> asyncpg.Pool:
        if self._pool is None:
            raise RuntimeError("DatabaseManager has not been initialised; call initialize() first")
        return self._pool

    # ------------------------------------------------------------------
    # DDL helpers
    # ------------------------------------------------------------------

    async def _run_ddl(self) -> None:
        async with self.pool.acquire() as conn:
            async with conn.transaction():
                for ddl in (
                    _DDL_TOKENS,
                    _DDL_PAIRS,
                    _DDL_TOKEN_PROFILES,
                    _DDL_TOKEN_BOOSTS,
                    _DDL_RAW_API_LOG,
                    _DDL_INDEXES,
                ):
                    await conn.execute(ddl)

    # ------------------------------------------------------------------
    # Upserts
    # ------------------------------------------------------------------

    async def upsert_tokens(self, tokens: list[Token]) -> None:
        """Bulk upsert a list of Token objects."""
        if not tokens:
            return

        rows = [
            (
                t.address,
                t.chain_id,
                t.name,
                t.symbol,
                t.decimals,
                t.price_usd,
                t.price_native,
                t.updated_at or _now(),
            )
            for t in tokens
        ]

        sql = """
            INSERT INTO tokens
                (address, chain_id, name, symbol, decimals, price_usd, price_native, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
            ON CONFLICT (address, chain_id) DO UPDATE SET
                name         = EXCLUDED.name,
                symbol       = EXCLUDED.symbol,
                decimals     = EXCLUDED.decimals,
                price_usd    = EXCLUDED.price_usd,
                price_native = EXCLUDED.price_native,
                updated_at   = EXCLUDED.updated_at
        """
        async with self.pool.acquire() as conn:
            try:
                await conn.executemany(sql, rows)
                logger.debug("Upserted %d token(s)", len(rows))
            except Exception:
                logger.exception("Failed to upsert tokens")
                raise

    async def upsert_pairs(self, pairs: list[Pair]) -> None:
        """Bulk upsert a list of Pair objects."""
        if not pairs:
            return

        rows = [
            (
                p.pair_address,
                p.chain_id,
                p.dex_id,
                p.base_token_address,
                p.base_token_symbol,
                p.base_token_name,
                p.quote_token_address,
                p.quote_token_symbol,
                p.price_native,
                p.price_usd,
                p.volume_h1,
                p.volume_h6,
                p.volume_h24,
                p.price_change_m5,
                p.price_change_h1,
                p.price_change_h6,
                p.price_change_h24,
                p.liquidity_usd,
                p.liquidity_base,
                p.liquidity_quote,
                p.fdv,
                p.market_cap,
                p.txns_h1_buys,
                p.txns_h1_sells,
                p.txns_h6_buys,
                p.txns_h6_sells,
                p.txns_h24_buys,
                p.txns_h24_sells,
                p.pair_created_at,
                p.updated_at or _now(),
            )
            for p in pairs
        ]

        sql = """
            INSERT INTO pairs (
                pair_address, chain_id, dex_id,
                base_token_address, base_token_symbol, base_token_name,
                quote_token_address, quote_token_symbol,
                price_native, price_usd,
                volume_h1, volume_h6, volume_h24,
                price_change_m5, price_change_h1, price_change_h6, price_change_h24,
                liquidity_usd, liquidity_base, liquidity_quote,
                fdv, market_cap,
                txns_h1_buys, txns_h1_sells,
                txns_h6_buys, txns_h6_sells,
                txns_h24_buys, txns_h24_sells,
                pair_created_at, updated_at
            )
            VALUES (
                $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
                $21, $22, $23, $24, $25, $26, $27, $28, $29, $30
            )
            ON CONFLICT (pair_address, chain_id) DO UPDATE SET
                dex_id              = EXCLUDED.dex_id,
                base_token_address  = EXCLUDED.base_token_address,
                base_token_symbol   = EXCLUDED.base_token_symbol,
                base_token_name     = EXCLUDED.base_token_name,
                quote_token_address = EXCLUDED.quote_token_address,
                quote_token_symbol  = EXCLUDED.quote_token_symbol,
                price_native        = EXCLUDED.price_native,
                price_usd           = EXCLUDED.price_usd,
                volume_h1           = EXCLUDED.volume_h1,
                volume_h6           = EXCLUDED.volume_h6,
                volume_h24          = EXCLUDED.volume_h24,
                price_change_m5     = EXCLUDED.price_change_m5,
                price_change_h1     = EXCLUDED.price_change_h1,
                price_change_h6     = EXCLUDED.price_change_h6,
                price_change_h24    = EXCLUDED.price_change_h24,
                liquidity_usd       = EXCLUDED.liquidity_usd,
                liquidity_base      = EXCLUDED.liquidity_base,
                liquidity_quote     = EXCLUDED.liquidity_quote,
                fdv                 = EXCLUDED.fdv,
                market_cap          = EXCLUDED.market_cap,
                txns_h1_buys        = EXCLUDED.txns_h1_buys,
                txns_h1_sells       = EXCLUDED.txns_h1_sells,
                txns_h6_buys        = EXCLUDED.txns_h6_buys,
                txns_h6_sells       = EXCLUDED.txns_h6_sells,
                txns_h24_buys       = EXCLUDED.txns_h24_buys,
                txns_h24_sells      = EXCLUDED.txns_h24_sells,
                pair_created_at     = EXCLUDED.pair_created_at,
                updated_at          = EXCLUDED.updated_at
        """
        async with self.pool.acquire() as conn:
            try:
                await conn.executemany(sql, rows)
                logger.debug("Upserted %d pair(s)", len(rows))
            except Exception:
                logger.exception("Failed to upsert pairs")
                raise

    async def upsert_token_profiles(self, profiles: list[TokenProfile]) -> None:
        """Bulk upsert a list of TokenProfile objects."""
        if not profiles:
            return

        rows = [
            (
                p.token_address,
                p.chain_id,
                p.url,
                p.description,
                p.icon,
                p.header,
                p.open_graph,
                json.dumps(p.links) if p.links is not None else None,
                p.updated_at or _now(),
            )
            for p in profiles
        ]

        sql = """
            INSERT INTO token_profiles
                (token_address, chain_id, url, description, icon, header, open_graph, links, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9)
            ON CONFLICT (token_address, chain_id) DO UPDATE SET
                url         = EXCLUDED.url,
                description = EXCLUDED.description,
                icon        = EXCLUDED.icon,
                header      = EXCLUDED.header,
                open_graph  = EXCLUDED.open_graph,
                links       = EXCLUDED.links,
                updated_at  = EXCLUDED.updated_at
        """
        async with self.pool.acquire() as conn:
            try:
                await conn.executemany(sql, rows)
                logger.debug("Upserted %d token profile(s)", len(rows))
            except Exception:
                logger.exception("Failed to upsert token profiles")
                raise

    async def upsert_token_boosts(self, boosts: list[TokenBoost]) -> None:
        """Bulk upsert a list of TokenBoost objects."""
        if not boosts:
            return

        rows = [
            (
                b.token_address,
                b.chain_id,
                b.url,
                b.amount,
                b.total_amount,
                b.boost_type,
                b.updated_at or _now(),
            )
            for b in boosts
        ]

        sql = """
            INSERT INTO token_boosts
                (token_address, chain_id, url, amount, total_amount, boost_type, updated_at)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            ON CONFLICT (token_address, chain_id, boost_type) DO UPDATE SET
                url          = EXCLUDED.url,
                amount       = EXCLUDED.amount,
                total_amount = EXCLUDED.total_amount,
                updated_at   = EXCLUDED.updated_at
        """
        async with self.pool.acquire() as conn:
            try:
                await conn.executemany(sql, rows)
                logger.debug("Upserted %d token boost(s)", len(rows))
            except Exception:
                logger.exception("Failed to upsert token boosts")
                raise

    async def log_api_request(
        self,
        endpoint: str,
        params: Optional[dict[str, Any]],
        status_code: int,
        response_size: int,
        fetched_at: Optional[datetime] = None,
    ) -> None:
        """Append a row to raw_api_log."""
        sql = """
            INSERT INTO raw_api_log (endpoint, params, status_code, response_size, fetched_at)
            VALUES ($1, $2::jsonb, $3, $4, $5)
        """
        async with self.pool.acquire() as conn:
            try:
                await conn.execute(
                    sql,
                    endpoint,
                    json.dumps(params) if params else None,
                    status_code,
                    response_size,
                    fetched_at or _now(),
                )
            except Exception:
                logger.exception("Failed to log API request for endpoint=%s", endpoint)


# ---------------------------------------------------------------------------
# Internal helpers
# ---------------------------------------------------------------------------

def _now() -> datetime:
    return datetime.now(tz=timezone.utc)

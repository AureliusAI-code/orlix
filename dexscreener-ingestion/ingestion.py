"""
DexScreener API client and ingestion orchestration.

Endpoints used:
  GET https://api.dexscreener.com/token-profiles/latest/v1
  GET https://api.dexscreener.com/token-boosts/top/v1
  GET https://api.dexscreener.com/token-boosts/latest/v1
  GET https://api.dexscreener.com/latest/dex/tokens/{addresses}
  GET https://api.dexscreener.com/latest/dex/pairs/{chainId}/{pairAddress}
  GET https://api.dexscreener.com/latest/dex/search?q={query}
"""

from __future__ import annotations

import asyncio
import logging
import random
import time
from datetime import datetime, timezone
from typing import Any, Optional

import aiohttp

from config import Config
from database import DatabaseManager
from models import Pair, Token, TokenBoost, TokenProfile

logger = logging.getLogger(__name__)

_BASE_URL = "https://api.dexscreener.com"

# Popular token symbols to search for each sync cycle
_SEARCH_QUERIES: list[str] = [
    "ETH", "BTC", "SOL", "USDC", "USDT",
    "BNB", "MATIC", "AVAX", "ARB", "OP",
    "LINK", "UNI", "AAVE", "CRV", "MKR",
    "COMP", "SNX", "SUSHI", "DOGE", "SHIB",
]


# ---------------------------------------------------------------------------
# Rate limiter
# ---------------------------------------------------------------------------

class RateLimiter:
    """
    Simple sliding-window rate limiter that enforces a minimum delay
    (in milliseconds) between consecutive HTTP requests.
    """

    def __init__(self, min_delay_ms: int = 300) -> None:
        self._min_delay: float = min_delay_ms / 1000.0
        self._last_request_time: float = 0.0
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        """Block until enough time has passed since the last request."""
        async with self._lock:
            now = time.monotonic()
            elapsed = now - self._last_request_time
            wait = self._min_delay - elapsed
            if wait > 0:
                await asyncio.sleep(wait)
            self._last_request_time = time.monotonic()


# ---------------------------------------------------------------------------
# HTTP client
# ---------------------------------------------------------------------------

class DexScreenerClient:
    """
    Thin aiohttp wrapper with integrated rate limiting and retry logic.

    Returns (data, status_code, response_size) for every request.
    data is None if the request ultimately failed after all retries.
    """

    def __init__(self, config: Config, rate_limiter: RateLimiter) -> None:
        self._config = config
        self._rate_limiter = rate_limiter
        self._session: Optional[aiohttp.ClientSession] = None

    async def start(self) -> None:
        connector = aiohttp.TCPConnector(limit=self._config.max_connections)
        timeout = aiohttp.ClientTimeout(total=30, connect=10)
        self._session = aiohttp.ClientSession(
            connector=connector,
            timeout=timeout,
            headers={"Accept": "application/json", "User-Agent": "dexscreener-ingestion/1.0"},
        )

    async def close(self) -> None:
        if self._session and not self._session.closed:
            await self._session.close()

    async def fetch(
        self,
        url: str,
        params: Optional[dict[str, str]] = None,
    ) -> tuple[Optional[Any], int, int]:
        """
        Fetch *url* with optional query *params*.

        Returns
        -------
        (data, status_code, response_size)
            data           – parsed JSON body, or None on failure
            status_code    – last HTTP status code received (0 on connection error)
            response_size  – body size in bytes (0 on connection error)
        """
        if self._session is None:
            raise RuntimeError("DexScreenerClient not started; call start() first")

        max_retries = self._config.max_retries
        base_delay = self._config.retry_base_delay

        for attempt in range(max_retries + 1):
            await self._rate_limiter.acquire()

            try:
                async with self._session.get(url, params=params) as resp:
                    raw_bytes = await resp.read()
                    status_code = resp.status
                    response_size = len(raw_bytes)

                    if status_code == 200:
                        try:
                            data = await resp.json(content_type=None)
                        except Exception:
                            # Fall back to manual JSON decode on content-type mismatch
                            import json as _json
                            data = _json.loads(raw_bytes)
                        return data, status_code, response_size

                    if status_code == 429:
                        wait = 60.0
                        logger.warning(
                            "Rate-limited (429) on %s – waiting %.0fs before retry",
                            url, wait,
                        )
                        await asyncio.sleep(wait)
                        continue

                    if status_code in (400, 404):
                        # Permanent client errors – do not retry
                        logger.warning("Permanent error %d for %s", status_code, url)
                        return None, status_code, response_size

                    # Transient server error – apply exponential backoff
                    if attempt < max_retries:
                        jitter = random.uniform(0, 0.5)
                        delay = base_delay * (2 ** attempt) + jitter
                        logger.warning(
                            "HTTP %d for %s – retry %d/%d in %.2fs",
                            status_code, url, attempt + 1, max_retries, delay,
                        )
                        await asyncio.sleep(delay)
                    else:
                        logger.error(
                            "HTTP %d for %s – giving up after %d retries",
                            status_code, url, max_retries,
                        )
                        return None, status_code, response_size

            except (aiohttp.ClientError, asyncio.TimeoutError) as exc:
                if attempt < max_retries:
                    jitter = random.uniform(0, 0.5)
                    delay = base_delay * (2 ** attempt) + jitter
                    logger.warning(
                        "Connection error for %s (%s) – retry %d/%d in %.2fs",
                        url, exc, attempt + 1, max_retries, delay,
                    )
                    await asyncio.sleep(delay)
                else:
                    logger.error(
                        "Connection error for %s (%s) – giving up after %d retries",
                        url, exc, max_retries,
                    )
                    return None, 0, 0

        return None, 0, 0


# ---------------------------------------------------------------------------
# Ingestion orchestrator
# ---------------------------------------------------------------------------

class DexScreenerIngestion:
    """Fetches data from DexScreener and persists it via DatabaseManager."""

    def __init__(self, config: Config, db: DatabaseManager) -> None:
        self._config = config
        self._db = db
        self._rate_limiter = RateLimiter(min_delay_ms=config.request_delay_ms)
        self._client = DexScreenerClient(config, self._rate_limiter)

    # ------------------------------------------------------------------
    # Lifecycle
    # ------------------------------------------------------------------

    async def _start(self) -> None:
        await self._client.start()

    async def _stop(self) -> None:
        await self._client.close()

    # ------------------------------------------------------------------
    # Fetch helpers
    # ------------------------------------------------------------------

    async def _fetch_and_log(
        self,
        url: str,
        params: Optional[dict[str, str]] = None,
    ) -> Optional[Any]:
        """Fetch a URL, log the request to DB, and return the parsed body."""
        fetched_at = _now()
        data, status_code, response_size = await self._client.fetch(url, params=params)
        try:
            await self._db.log_api_request(
                endpoint=url,
                params=params,
                status_code=status_code,
                response_size=response_size,
                fetched_at=fetched_at,
            )
        except Exception:
            logger.exception("Failed to log API request; continuing")
        return data

    # ------------------------------------------------------------------
    # Public fetch methods
    # ------------------------------------------------------------------

    async def fetch_token_profiles_latest(self) -> list[TokenProfile]:
        """Fetch /token-profiles/latest/v1."""
        url = f"{_BASE_URL}/token-profiles/latest/v1"
        data = await self._fetch_and_log(url)
        if not isinstance(data, list):
            logger.warning("Unexpected response from token-profiles/latest: %r", type(data))
            return []
        profiles: list[TokenProfile] = []
        for item in data:
            try:
                profiles.append(await self.parse_token_profile(item))
            except Exception:
                logger.exception("Failed to parse token profile: %r", item)
        return profiles

    async def fetch_token_boosts_top(self) -> list[TokenBoost]:
        """Fetch /token-boosts/top/v1."""
        url = f"{_BASE_URL}/token-boosts/top/v1"
        data = await self._fetch_and_log(url)
        if not isinstance(data, list):
            logger.warning("Unexpected response from token-boosts/top: %r", type(data))
            return []
        boosts: list[TokenBoost] = []
        for item in data:
            try:
                boosts.append(await self.parse_token_boost(item, boost_type="top"))
            except Exception:
                logger.exception("Failed to parse top token boost: %r", item)
        return boosts

    async def fetch_token_boosts_latest(self) -> list[TokenBoost]:
        """Fetch /token-boosts/latest/v1."""
        url = f"{_BASE_URL}/token-boosts/latest/v1"
        data = await self._fetch_and_log(url)
        if not isinstance(data, list):
            logger.warning("Unexpected response from token-boosts/latest: %r", type(data))
            return []
        boosts: list[TokenBoost] = []
        for item in data:
            try:
                boosts.append(await self.parse_token_boost(item, boost_type="latest"))
            except Exception:
                logger.exception("Failed to parse latest token boost: %r", item)
        return boosts

    async def fetch_pairs_by_token_addresses(
        self,
        addresses: list[str],
        chain_id: str,
    ) -> list[Pair]:
        """
        Fetch /latest/dex/tokens/{addresses} for up to 30 addresses at a time.
        DexScreener allows comma-separated addresses.
        """
        if not addresses:
            return []

        all_pairs: list[Pair] = []
        # API limit: max 30 addresses per call
        chunk_size = 30
        for i in range(0, len(addresses), chunk_size):
            chunk = addresses[i : i + chunk_size]
            joined = ",".join(chunk)
            url = f"{_BASE_URL}/latest/dex/tokens/{joined}"
            data = await self._fetch_and_log(url)
            if not isinstance(data, dict):
                continue
            for raw_pair in data.get("pairs") or []:
                # Filter to the requested chain_id if provided
                if chain_id and raw_pair.get("chainId") != chain_id:
                    continue
                try:
                    all_pairs.append(await self.parse_pair(raw_pair))
                except Exception:
                    logger.exception("Failed to parse pair: %r", raw_pair)
        return all_pairs

    async def fetch_pair(self, chain_id: str, pair_address: str) -> list[Pair]:
        """Fetch /latest/dex/pairs/{chainId}/{pairAddress}."""
        url = f"{_BASE_URL}/latest/dex/pairs/{chain_id}/{pair_address}"
        data = await self._fetch_and_log(url)
        if not isinstance(data, dict):
            return []
        pairs: list[Pair] = []
        for raw_pair in data.get("pairs") or []:
            try:
                pairs.append(await self.parse_pair(raw_pair))
            except Exception:
                logger.exception("Failed to parse pair: %r", raw_pair)
        return pairs

    async def search_pairs(self, query: str) -> list[Pair]:
        """Fetch /latest/dex/search?q={query}."""
        url = f"{_BASE_URL}/latest/dex/search"
        data = await self._fetch_and_log(url, params={"q": query})
        if not isinstance(data, dict):
            return []
        pairs: list[Pair] = []
        for raw_pair in data.get("pairs") or []:
            try:
                pairs.append(await self.parse_pair(raw_pair))
            except Exception:
                logger.exception("Failed to parse pair: %r", raw_pair)
        return pairs

    # ------------------------------------------------------------------
    # Parsers
    # ------------------------------------------------------------------

    async def parse_pair(self, raw: dict) -> Pair:
        """Convert a raw DexScreener pair dict to a Pair dataclass."""
        volume = raw.get("volume") or {}
        price_change = raw.get("priceChange") or {}
        liquidity = raw.get("liquidity") or {}
        txns = raw.get("txns") or {}
        base_token = raw.get("baseToken") or {}
        quote_token = raw.get("quoteToken") or {}

        def _txns(period: str, side: str) -> Optional[int]:
            bucket = txns.get(period) or {}
            val = bucket.get(side)
            return int(val) if val is not None else None

        pair_created_at: Optional[datetime] = None
        created_ts = raw.get("pairCreatedAt")
        if created_ts is not None:
            try:
                # DexScreener returns milliseconds epoch
                pair_created_at = datetime.fromtimestamp(
                    int(created_ts) / 1000, tz=timezone.utc
                )
            except (ValueError, OSError):
                pair_created_at = None

        return Pair(
            pair_address=raw.get("pairAddress", ""),
            chain_id=raw.get("chainId", ""),
            dex_id=raw.get("dexId"),
            base_token_address=base_token.get("address"),
            base_token_symbol=base_token.get("symbol"),
            base_token_name=base_token.get("name"),
            quote_token_address=quote_token.get("address"),
            quote_token_symbol=quote_token.get("symbol"),
            price_native=_to_float(raw.get("priceNative")),
            price_usd=_to_float(raw.get("priceUsd")),
            volume_h1=_to_float(volume.get("h1")),
            volume_h6=_to_float(volume.get("h6")),
            volume_h24=_to_float(volume.get("h24")),
            price_change_m5=_to_float(price_change.get("m5")),
            price_change_h1=_to_float(price_change.get("h1")),
            price_change_h6=_to_float(price_change.get("h6")),
            price_change_h24=_to_float(price_change.get("h24")),
            liquidity_usd=_to_float(liquidity.get("usd")),
            liquidity_base=_to_float(liquidity.get("base")),
            liquidity_quote=_to_float(liquidity.get("quote")),
            fdv=_to_float(raw.get("fdv")),
            market_cap=_to_float(raw.get("marketCap")),
            txns_h1_buys=_txns("h1", "buys"),
            txns_h1_sells=_txns("h1", "sells"),
            txns_h6_buys=_txns("h6", "buys"),
            txns_h6_sells=_txns("h6", "sells"),
            txns_h24_buys=_txns("h24", "buys"),
            txns_h24_sells=_txns("h24", "sells"),
            pair_created_at=pair_created_at,
            updated_at=_now(),
        )

    async def parse_token_profile(self, raw: dict) -> TokenProfile:
        """Convert a raw token-profile dict to a TokenProfile dataclass."""
        links_raw = raw.get("links")
        links: Optional[list[dict]] = None
        if isinstance(links_raw, list):
            links = [
                {"label": lnk.get("label"), "url": lnk.get("url")}
                for lnk in links_raw
                if isinstance(lnk, dict)
            ]

        return TokenProfile(
            token_address=raw.get("tokenAddress", ""),
            chain_id=raw.get("chainId", ""),
            url=raw.get("url"),
            chain_id_str=raw.get("chainId"),
            description=raw.get("description"),
            icon=raw.get("icon"),
            header=raw.get("header"),
            open_graph=raw.get("openGraph"),
            links=links,
            updated_at=_now(),
        )

    async def parse_token_boost(self, raw: dict, boost_type: str = "unknown") -> TokenBoost:
        """Convert a raw token-boost dict to a TokenBoost dataclass."""
        return TokenBoost(
            token_address=raw.get("tokenAddress", ""),
            chain_id=raw.get("chainId", ""),
            url=raw.get("url"),
            amount=_to_float(raw.get("amount")),
            total_amount=_to_float(raw.get("totalAmount")),
            boost_type=boost_type,
            updated_at=_now(),
        )

    # ------------------------------------------------------------------
    # Sync logic
    # ------------------------------------------------------------------

    async def run_sync_cycle(self) -> dict:
        """
        Execute one complete sync cycle.

        Returns a stats dict with counts of records fetched and persisted.
        """
        stats: dict[str, int] = {
            "profiles_fetched": 0,
            "boosts_top_fetched": 0,
            "boosts_latest_fetched": 0,
            "pairs_fetched": 0,
            "errors": 0,
        }

        # 1. Token profiles
        try:
            profiles = await self.fetch_token_profiles_latest()
            await self._db.upsert_token_profiles(profiles)
            stats["profiles_fetched"] = len(profiles)
            logger.info("Synced %d token profile(s)", len(profiles))
        except Exception:
            logger.exception("Error during token profile sync")
            stats["errors"] += 1

        # 2. Token boosts – top
        try:
            boosts_top = await self.fetch_token_boosts_top()
            await self._db.upsert_token_boosts(boosts_top)
            stats["boosts_top_fetched"] = len(boosts_top)
            logger.info("Synced %d top token boost(s)", len(boosts_top))
        except Exception:
            logger.exception("Error during top token boost sync")
            stats["errors"] += 1

        # 3. Token boosts – latest
        try:
            boosts_latest = await self.fetch_token_boosts_latest()
            await self._db.upsert_token_boosts(boosts_latest)
            stats["boosts_latest_fetched"] = len(boosts_latest)
            logger.info("Synced %d latest token boost(s)", len(boosts_latest))
        except Exception:
            logger.exception("Error during latest token boost sync")
            stats["errors"] += 1

        # 4. Search pairs for all configured queries
        all_pairs: list[Pair] = []
        derived_tokens: dict[str, Token] = {}

        for query in _SEARCH_QUERIES:
            try:
                pairs = await self.search_pairs(query)
                all_pairs.extend(pairs)

                # Derive Token records from pair base tokens
                for pair in pairs:
                    if pair.base_token_address and pair.chain_id:
                        key = (pair.base_token_address, pair.chain_id)
                        if key not in derived_tokens:
                            derived_tokens[key] = Token(
                                address=pair.base_token_address,
                                chain_id=pair.chain_id,
                                name=pair.base_token_name,
                                symbol=pair.base_token_symbol,
                                price_usd=pair.price_usd,
                                price_native=pair.price_native,
                                updated_at=pair.updated_at,
                            )
            except Exception:
                logger.exception("Error searching pairs for query=%r", query)
                stats["errors"] += 1

        # Deduplicate pairs by (pair_address, chain_id)
        seen_pairs: dict[tuple[str, str], Pair] = {}
        for pair in all_pairs:
            key = (pair.pair_address, pair.chain_id)
            if key not in seen_pairs:
                seen_pairs[key] = pair

        deduped_pairs = list(seen_pairs.values())
        stats["pairs_fetched"] = len(deduped_pairs)

        try:
            await self._db.upsert_pairs(deduped_pairs)
            logger.info("Upserted %d unique pair(s)", len(deduped_pairs))
        except Exception:
            logger.exception("Error upserting pairs")
            stats["errors"] += 1

        try:
            await self._db.upsert_tokens(list(derived_tokens.values()))
            logger.info("Upserted %d derived token(s)", len(derived_tokens))
        except Exception:
            logger.exception("Error upserting derived tokens")
            stats["errors"] += 1

        return stats

    async def run_forever(self) -> None:
        """
        Main ingestion loop.
        Runs a sync cycle every SYNC_INTERVAL_SECONDS seconds.
        Handles keyboard interrupt cleanly.
        """
        await self._start()
        interval = self._config.sync_interval_seconds
        logger.info("Starting ingestion loop (interval=%ds)", interval)

        try:
            cycle = 0
            while True:
                cycle += 1
                cycle_start = time.monotonic()
                logger.info("=== Sync cycle #%d starting ===", cycle)

                try:
                    stats = await self.run_sync_cycle()
                    elapsed = time.monotonic() - cycle_start
                    logger.info(
                        "=== Sync cycle #%d done in %.2fs | stats=%r ===",
                        cycle, elapsed, stats,
                    )
                except Exception:
                    logger.exception("Unhandled exception in sync cycle #%d", cycle)

                elapsed = time.monotonic() - cycle_start
                sleep_time = max(0.0, interval - elapsed)
                if sleep_time > 0:
                    logger.debug("Sleeping %.1fs until next cycle", sleep_time)
                    await asyncio.sleep(sleep_time)

        except (KeyboardInterrupt, asyncio.CancelledError):
            logger.info("Ingestion loop cancelled – shutting down")
        finally:
            await self._stop()


# ---------------------------------------------------------------------------
# Utilities
# ---------------------------------------------------------------------------

def _to_float(value: Any) -> Optional[float]:
    """Safely cast a value to float, returning None on failure."""
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def _now() -> datetime:
    return datetime.now(tz=timezone.utc)

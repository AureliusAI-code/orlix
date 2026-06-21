"""
Dataclass models representing DexScreener API entities.
All timestamps are timezone-aware datetime objects (UTC).
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime
from typing import Any, Optional


@dataclass
class Token:
    """Represents a token as stored in the tokens table."""

    address: str
    chain_id: str
    name: Optional[str] = None
    symbol: Optional[str] = None
    decimals: Optional[int] = None
    price_usd: Optional[float] = None
    price_native: Optional[float] = None
    updated_at: Optional[datetime] = None


@dataclass
class Pair:
    """Represents a trading pair as returned by DexScreener."""

    pair_address: str
    chain_id: str
    dex_id: Optional[str] = None

    # Base token
    base_token_address: Optional[str] = None
    base_token_symbol: Optional[str] = None
    base_token_name: Optional[str] = None

    # Quote token
    quote_token_address: Optional[str] = None
    quote_token_symbol: Optional[str] = None

    # Prices
    price_native: Optional[float] = None
    price_usd: Optional[float] = None

    # Volume
    volume_h1: Optional[float] = None
    volume_h6: Optional[float] = None
    volume_h24: Optional[float] = None

    # Price changes
    price_change_m5: Optional[float] = None
    price_change_h1: Optional[float] = None
    price_change_h6: Optional[float] = None
    price_change_h24: Optional[float] = None

    # Liquidity
    liquidity_usd: Optional[float] = None
    liquidity_base: Optional[float] = None
    liquidity_quote: Optional[float] = None

    # Market data
    fdv: Optional[float] = None
    market_cap: Optional[float] = None

    # Transactions (1h)
    txns_h1_buys: Optional[int] = None
    txns_h1_sells: Optional[int] = None

    # Transactions (6h)
    txns_h6_buys: Optional[int] = None
    txns_h6_sells: Optional[int] = None

    # Transactions (24h)
    txns_h24_buys: Optional[int] = None
    txns_h24_sells: Optional[int] = None

    pair_created_at: Optional[datetime] = None
    updated_at: Optional[datetime] = None


@dataclass
class TokenProfile:
    """Represents a token profile from the /token-profiles endpoint."""

    token_address: str
    chain_id: str
    url: Optional[str] = None
    chain_id_str: Optional[str] = None
    description: Optional[str] = None
    icon: Optional[str] = None
    header: Optional[str] = None
    open_graph: Optional[str] = None
    # links is a list of dicts: [{"label": ..., "url": ...}]
    links: Optional[list[dict[str, Any]]] = field(default=None)
    updated_at: Optional[datetime] = None


@dataclass
class TokenBoost:
    """Represents a token boost record from the /token-boosts endpoint."""

    token_address: str
    chain_id: str
    url: Optional[str] = None
    amount: Optional[float] = None
    total_amount: Optional[float] = None
    boost_type: str = "unknown"
    updated_at: Optional[datetime] = None

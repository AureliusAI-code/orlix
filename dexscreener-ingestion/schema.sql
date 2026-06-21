-- =============================================================================
-- DexScreener Ingestion – PostgreSQL Schema
-- =============================================================================
-- All tables use CREATE TABLE IF NOT EXISTS so the script is idempotent.
-- Indexes are created with CREATE INDEX IF NOT EXISTS for the same reason.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- tokens
-- ---------------------------------------------------------------------------
COMMENT ON TABLE tokens IS
    'One row per (address, chain_id) representing a unique on-chain token. '
    'Updated every sync cycle with the latest price data derived from trading pairs.';

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

CREATE INDEX IF NOT EXISTS idx_tokens_chain_id
    ON tokens (chain_id);

-- ---------------------------------------------------------------------------
-- pairs
-- ---------------------------------------------------------------------------
COMMENT ON TABLE pairs IS
    'One row per (pair_address, chain_id) representing a DEX liquidity pair. '
    'Contains current price, volume, liquidity, market cap and transaction counts '
    'across multiple time windows (5m, 1h, 6h, 24h).';

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

CREATE INDEX IF NOT EXISTS idx_pairs_chain_id
    ON pairs (chain_id);

CREATE INDEX IF NOT EXISTS idx_pairs_base_token_address
    ON pairs (base_token_address);

-- ---------------------------------------------------------------------------
-- token_profiles
-- ---------------------------------------------------------------------------
COMMENT ON TABLE token_profiles IS
    'Marketing / metadata profiles for tokens as returned by the '
    '/token-profiles/latest/v1 endpoint. Contains descriptions, icons, '
    'headers and social/website links stored as JSONB.';

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

CREATE INDEX IF NOT EXISTS idx_token_profiles_chain_id
    ON token_profiles (chain_id);

-- ---------------------------------------------------------------------------
-- token_boosts
-- ---------------------------------------------------------------------------
COMMENT ON TABLE token_boosts IS
    'Paid boost records from /token-boosts/top/v1 and /token-boosts/latest/v1. '
    'boost_type distinguishes "top" from "latest" records. '
    'amount is the individual boost spend; total_amount is the cumulative spend.';

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

CREATE INDEX IF NOT EXISTS idx_token_boosts_chain_id
    ON token_boosts (chain_id);

-- ---------------------------------------------------------------------------
-- raw_api_log
-- ---------------------------------------------------------------------------
COMMENT ON TABLE raw_api_log IS
    'Audit log of every outbound HTTP request made to the DexScreener API. '
    'Records the endpoint URL, query parameters, HTTP status code, response '
    'body size in bytes, and the UTC timestamp at which the request was sent. '
    'Useful for debugging, rate-limit analysis and request cost attribution.';

CREATE TABLE IF NOT EXISTS raw_api_log (
    id            BIGSERIAL   PRIMARY KEY,
    endpoint      TEXT,
    params        JSONB,
    status_code   INT,
    response_size INT,
    fetched_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_raw_api_log_fetched_at
    ON raw_api_log (fetched_at);

CREATE INDEX IF NOT EXISTS idx_raw_api_log_endpoint
    ON raw_api_log (endpoint);

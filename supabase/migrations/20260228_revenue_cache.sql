CREATE TABLE IF NOT EXISTS revenue_cache (
  account_key TEXT PRIMARY KEY,
  net_cents BIGINT NOT NULL DEFAULT 0,
  gross_cents BIGINT NOT NULL DEFAULT 0,
  transfers_cents BIGINT NOT NULL DEFAULT 0,
  products_sold INT NOT NULL DEFAULT 0,
  cached_through BIGINT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

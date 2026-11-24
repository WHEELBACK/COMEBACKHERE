-- Merchant ledger / transaction table
CREATE TABLE IF NOT EXISTS merchant_transactions (
    id BIGSERIAL PRIMARY KEY,
    merchant_id BIGINT NOT NULL,
    amount NUMERIC(18, 2) NOT NULL,
    currency VARCHAR(3) NOT NULL DEFAULT 'USD',
    status VARCHAR(32) NOT NULL DEFAULT 'pending',
    reference VARCHAR(128),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Composite index supporting merchant ledger range scans filtered by
-- merchant_id and ordered/filtered on created_at (issue #1022).
CREATE INDEX IF NOT EXISTS idx_merchant_transactions_merchant_created
    ON merchant_transactions (merchant_id, created_at DESC);

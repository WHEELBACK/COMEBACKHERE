-- Merchant transaction/ledger lookups.
--
-- These queries filter by merchant_id and a created_at range. They rely on the
-- composite index `idx_merchant_transactions_merchant_created_at`
-- (merchant_id, created_at DESC) defined in backend/src/db/schema.sql so the
-- planner performs an index scan instead of a sequential scan on large ledgers.

-- name: ListMerchantTransactions
-- Fetch a page of a merchant's transactions within an optional time range.
-- The (merchant_id, created_at DESC) index supports both the equality on
-- merchant_id and the range/ordering on created_at.
SELECT
    id,
    merchant_id,
    amount,
    currency,
    status,
    reference,
    created_at
FROM merchant_transactions
WHERE merchant_id = $1
  AND created_at >= $2
  AND created_at < $3
ORDER BY created_at DESC
LIMIT $4
OFFSET $5;

-- name: CountMerchantTransactions
-- Count matching rows for pagination; same index-backed predicate.
SELECT COUNT(*)
FROM merchant_transactions
WHERE merchant_id = $1
  AND created_at >= $2
  AND created_at < $3;

-- Payment notification dead-letter queue (DLQ)
-- Notifications that exceed max retries are persisted here with error context
-- and stack trace so merchants can inspect and manually re-trigger them.
CREATE TABLE IF NOT EXISTS notification_dlq (
    id              BIGSERIAL PRIMARY KEY,
    notification_id BIGINT NOT NULL,
    merchant_id     BIGINT NOT NULL,
    endpoint_url    TEXT NOT NULL,
    payload         JSONB NOT NULL,
    attempt_count   INTEGER NOT NULL DEFAULT 0,
    last_error      TEXT,
    error_stack     TEXT,
    status          TEXT NOT NULL DEFAULT 'pending',
    retriggered_at  TIMESTAMPTZ,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notification_dlq_merchant_id
    ON notification_dlq (merchant_id);

CREATE INDEX IF NOT EXISTS idx_notification_dlq_status
    ON notification_dlq (status);

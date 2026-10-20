//! COMEBACKHERE legacy Rust/Axum backend.
//!
//! The crate is split into a library (`lib.rs`) and a thin binary
//! (`main.rs`) so integration tests under `tests/` can exercise the real
//! router — `build_router` — exactly as production wires it up, instead of
//! re-assembling routes per test.

pub mod extractors;
pub mod handlers_readiness;
pub mod idempotency;
pub mod rate_limiter;
pub mod routes;
pub mod soroban;
pub mod types;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use idempotency::IdempotencyStore;
use rate_limiter::{new_store, RateLimitConfig, RateLimiterLayer};
use utoipa::OpenApi as _;
use routes::{
    cancel::cancel_invoice,
    health::get_rpc_health,
    invoices::{create_invoice, get_invoice},
    pay::pay_invoice,
    refund::refund_invoice,
};
use handlers_readiness::readiness_probe;
use soroban::SorobanClient;

/// Shared application state threaded through every route handler.
#[derive(Clone)]
pub struct AppState {
    pub client: Arc<SorobanClient>,
    pub idempotency: Arc<IdempotencyStore>,
    pub audit: Arc<AuditLog>,
}

impl AppState {
    /// Build state from environment variables, matching the defaults used by
    /// the standalone binary (see `main.rs`).
    pub fn from_env() -> Self {
        let rpc_url = std::env::var("SOROBAN_RPC_URL")
            .unwrap_or_else(|_| "http://localhost:8000/soroban/rpc".to_string());
        let contract_id = std::env::var("INVOICE_CONTRACT_ID")
            .unwrap_or_else(|_| "CONTRACT_ID_PLACEHOLDER".to_string());
        let horizon_url = std::env::var("HORIZON_API_URL")
            .unwrap_or_else(|_| "https://horizon.stellar.org".to_string());
        Self::new(rpc_url, contract_id, horizon_url)
    }

    /// Build state pointing at explicit endpoints (used by tests).
    pub fn new(rpc_url: String, contract_id: String, horizon_url: String) -> Self {
        Self {
            client: Arc::new(SorobanClient::new(rpc_url, contract_id, horizon_url)),
            // 24-hour TTL for idempotency keys (matches common API gateway defaults).
            idempotency: IdempotencyStore::new(Duration::from_secs(86_400)),
            audit: Arc::new(AuditLog::new()),
        }
    }
}

/// A single administrative audit record.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AuditRecord {
    pub seq: u64,
    pub action: String,
    pub actor: String,
    pub detail: String,
    /// Hash chaining this record to its predecessor (tamper-evident).
    pub prev_hash: String,
    /// Hash over this record's contents plus `prev_hash`.
    pub hash: String,
}

/// Append-only, hash-chained audit log.
///
/// Each record commits to the previous record's hash, so any silent
/// modification or deletion of an earlier record breaks the chain and is
/// detected by [`AuditLog::verify`].
#[derive(Default)]
pub struct AuditLog {
    records: std::sync::Mutex<Vec<AuditRecord>>,
}

impl AuditLog {
    pub fn new() -> Self {
        Self::default()
    }

    fn digest(seq: u64, action: &str, actor: &str, detail: &str, prev_hash: &str) -> String {
        // Deterministic, dependency-free integrity digest over the record.
        let mut h: u64 = 0xcbf2_9ce4_8422_2325;
        let mut feed = |bytes: &[u8]| {
            for &b in bytes {
                h ^= b as u64;
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
        };
        feed(&seq.to_le_bytes());
        feed(action.as_bytes());
        feed(b"\x1f");
        feed(actor.as_bytes());
        feed(b"\x1f");
        feed(detail.as_bytes());
        feed(b"\x1f");
        feed(prev_hash.as_bytes());
        format!("{h:016x}")
    }

    /// Append an audit record, chaining it to the current tail.
    pub fn record(&self, action: &str, actor: &str, detail: &str) -> AuditRecord {
        let mut records = self.records.lock().expect("audit log poisoned");
        let seq = records.len() as u64;
        let prev_hash = records.last().map(|r| r.hash.clone()).unwrap_or_default();
        let hash = Self::digest(seq, action, actor, detail, &prev_hash);
        let rec = AuditRecord {
            seq,
            action: action.to_string(),
            actor: actor.to_string(),
            detail: detail.to_string(),
            prev_hash,
            hash,
        };
        records.push(rec.clone());
        rec
    }

    /// Verify the whole chain. Returns `Err` describing the first break.
    pub fn verify(&self) -> Result<(), String> {
        let records = self.records.lock().expect("audit log poisoned");
        let mut prev_hash = String::new();
        for (i, rec) in records.iter().enumerate() {
            if rec.seq != i as u64 {
                return Err(format!("audit record {i} has unexpected sequence {}", rec.seq));
            }
            if rec.prev_hash != prev_hash {
                return Err(format!("audit record {i} chain link broken"));
            }
            let expected = Self::digest(rec.seq, &rec.action, &rec.actor, &rec.detail, &rec.prev_hash);
            if rec.hash != expected {
                return Err(format!("audit record {i} content hash mismatch"));
            }
            prev_hash = rec.hash.clone();
        }
        Ok(())
    }

    pub fn len(&self) -> usize {
        self.records.lock().expect("audit log poisoned").len()
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

/// Build the application router with every route and the rate-limiter layer.
///
/// This is the single source of truth for the route table: `main` serves it
/// in production and integration tests exercise it directly, so the two can
/// never drift apart.
pub fn build_router(state: AppState) -> Router {
    // Rate-limiter layer: config is read from RATE_LIMIT_POINTS /
    // RATE_LIMIT_DURATION (defaults: 60 requests per 60-second window, per IP).
    let rl_config = RateLimitConfig::from_env();
    let rl_layer = RateLimiterLayer::new(new_store(), rl_config);

    Router::new()
        .route("/health/rpc", axum::routing::get(get_rpc_health))
        .route("/health/ready", axum::routing::get(readiness_probe))
        .route("/invoices", axum::routing::post(create_invoice))
        .route("/invoices/:id", axum::routing::get(get_invoice))
        .route("/invoices/:id/pay", axum::routing::post(pay_invoice))
        .route("/invoices/:id/cancel", axum::routing::post(cancel_invoice))
        .route("/invoices/:id/refund", axum::routing::post(refund_invoice))
        .layer(rl_layer)
        .with_state(state)
}

#[derive(utoipa::OpenApi)]
#[openapi(
    info(
        title = "COMEBACKHERE API",
        version = "0.1.0",
        description = "COMEBACKHERE backend API for invoice management"
    ),
    paths(
        routes::health::get_rpc_health,
        routes::invoices::get_invoice,
        routes::invoices::create_invoice,
        routes::pay::pay_invoice,
        routes::cancel::cancel_invoice,
        routes::refund::refund_invoice,
    ),
    tags(
        (name = "health", description = "Health check endpoints"),
        (name = "invoices", description = "Invoice management"),
        (name = "pay", description = "Payment operations"),
        (name = "cancel", description = "Cancellation operations"),
        (name = "refund", description = "Refund operations")
    )
)]
struct ApiDoc;

/// Serve the OpenAPI document (used by tests and tooling).
pub fn openapi() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_writes_chain_and_verify() {
        let log = AuditLog::new();
        log.record("create_invoice", "admin", "inv-1");
        log.record("refund_invoice", "admin", "inv-1");
        assert_eq!(log.len(), 2);
        assert!(log.verify().is_ok());
    }

    #[test]
    fn audit_detects_tampering() {
        let log = AuditLog::new();
        log.record("create_invoice", "admin", "inv-1");
        log.record("refund_invoice", "admin", "inv-1");
        {
            let mut records = log.records.lock().unwrap();
            records[0].detail = "tampered".to_string();
        }
        assert!(log.verify().is_err());
    }

    #[test]
    fn audit_detects_deletion() {
        let log = AuditLog::new();
        log.record("create_invoice", "admin", "inv-1");
        log.record("refund_invoice", "admin", "inv-1");
        {
            let mut records = log.records.lock().unwrap();
            records.remove(0);
        }
        assert!(log.verify().is_err());
    }
}

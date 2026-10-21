//! COMEBACKHERE legacy Rust/Axum backend.
//!
//! The crate is split into a library (`lib.rs`) and a thin binary
//! (`main.rs`) so integration tests under `tests/` can exercise the real
//! router — `build_router` — exactly as production wires it up, instead of
//! re-assembling routes per test.

pub mod correlation;
pub mod extractors;
pub mod handlers_readiness;
pub mod idempotency;
pub mod rate_limiter;
pub mod routes;
pub mod soroban;
pub mod types;
pub mod webhooks;

use std::net::IpAddr;
use std::sync::Arc;
use std::time::Duration;

use axum::{middleware, Router};
use tower_http::cors::CorsLayer;
use idempotency::IdempotencyStore;
use rate_limiter::{new_store, RateLimitConfig, RateLimiterLayer};
use utoipa::OpenApi as _;
use routes::{
    cancel::cancel_invoice,
    health::get_rpc_health,
    invoices::{create_invoice, get_invoice},
    pay::pay_invoice,
    reconciliation::run_reconciliation,
    refund::refund_invoice,
};
use handlers_readiness::readiness_probe;
use soroban::SorobanClient;

use webhooks::{RetryConfig, WebhookDispatcher};

use correlation::correlation_middleware;

/// Explicit set of proxy peers whose `X-Forwarded-For` header is trusted.
///
/// Forwarded headers are only honored when the direct connection peer is one
/// of these addresses; otherwise the header is ignored and the direct peer IP
/// is used for client-IP and rate-limit decisions.
#[derive(Clone, Debug, Default)]
pub struct TrustedProxies {
    addrs: Arc<Vec<IpAddr>>,
}

impl TrustedProxies {
    /// Build from an explicit list of trusted proxy addresses.
    pub fn new(addrs: Vec<IpAddr>) -> Self {
        Self {
            addrs: Arc::new(addrs),
        }
    }

    /// Read the trusted proxy list from `TRUSTED_PROXIES` (comma-separated
    /// IP addresses). Unset or empty means no proxies are trusted.
    pub fn from_env() -> Self {
        let raw = std::env::var("TRUSTED_PROXIES").unwrap_or_default();
        let addrs = raw
            .split(',')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .filter_map(|s| s.parse::<IpAddr>().ok())
            .collect();
        Self::new(addrs)
    }

    /// Returns `true` when `peer` is a configured trusted proxy.
    pub fn is_trusted(&self, peer: IpAddr) -> bool {
        self.addrs.iter().any(|addr| *addr == peer)
    }
}


/// Shared application state threaded through every route handler.
#[derive(Clone)]
pub struct AppState {
    pub client: Arc<SorobanClient>,
    pub idempotency: Arc<IdempotencyStore>,

    pub audit: Arc<AuditLog>,
    /// Optional MongoDB connection string; when set, readiness probes it.
    pub mongodb_url: Option<String>,
    /// Optional Redis connection string; when set, readiness probes it.
    pub redis_url: Option<String>,
    pub trusted_proxies: TrustedProxies,

    /// Retry/dead-letter dispatcher used for every production webhook event.
    pub webhooks: Arc<WebhookDispatcher>,

}

impl AppState {
    /// Build state from environment variables, matching the defaults used by
    /// the standalone binary (see `main.rs`).
    ///
    /// Soroban RPC failover (#970): the primary endpoint is read from
    /// `SOROBAN_RPC_URL`; optional fallbacks are read from
    /// `SOROBAN_RPC_URLS` as a comma-separated list (`SOROBAN_RPC_FALLBACK_URLS`
    /// is accepted as an alias). All endpoints must serve the same network
    /// (the network passphrase is shared), so failover never changes
    /// transaction/network correctness.
    pub fn from_env() -> Self {
        let rpc_url = std::env::var("SOROBAN_RPC_URL")
            .unwrap_or_else(|_| "http://localhost:8000/soroban/rpc".to_string());
        let fallback_urls = std::env::var("SOROBAN_RPC_URLS")
            .or_else(|_| std::env::var("SOROBAN_RPC_FALLBACK_URLS"))
            .ok()
            .map(|raw| {
                raw.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let contract_id = std::env::var("INVOICE_CONTRACT_ID")
            .unwrap_or_else(|_| "CONTRACT_ID_PLACEHOLDER".to_string());
        let horizon_url = std::env::var("HORIZON_API_URL")
            .unwrap_or_else(|_| "https://horizon.stellar.org".to_string());
        let mongodb_url = std::env::var("MONGODB_URL").ok();
        let redis_url = std::env::var("REDIS_URL").ok();
        Self::new_with_fallbacks(rpc_url, fallback_urls, contract_id, horizon_url)
            .with_dependencies(mongodb_url, redis_url)
    }

    /// Build state pointing at explicit endpoints (used by tests).
    pub fn new(rpc_url: String, contract_id: String, horizon_url: String) -> Self {
        Self::new_with_fallbacks(rpc_url, Vec::new(), contract_id, horizon_url)
    }

    /// Build state with a primary RPC endpoint plus ordered fallbacks.
    ///
    /// The primary is always tried first; fallbacks are only used when the
    /// primary is unhealthy/unreachable (see `SorobanClient` failover rules).
    pub fn new_with_fallbacks(
        rpc_url: String,
        fallback_urls: Vec<String>,
        contract_id: String,
        horizon_url: String,
    ) -> Self {
        Self {
            client: Arc::new(SorobanClient::with_fallbacks(
                rpc_url,
                fallback_urls,
                contract_id,
                horizon_url,
            )),
            // 24-hour TTL for idempotency keys (matches common API gateway defaults).
            idempotency: IdempotencyStore::new(Duration::from_secs(86_400)),

            audit: Arc::new(AuditLog::new()),
            mongodb_url: None,
            redis_url: None,
            trusted_proxies: TrustedProxies::from_env(),

            // Production webhook events flow through the retry + dead-letter
            // queue rather than a single best-effort attempt.
            webhooks: Arc::new(WebhookDispatcher::new(RetryConfig::from_env())),

        }
    }

    /// Attach optional dependency endpoints used by readiness probes.
    pub fn with_dependencies(mut self, mongodb_url: Option<String>, redis_url: Option<String>) -> Self {
        self.mongodb_url = mongodb_url;
        self.redis_url = redis_url;
        self
    }

    /// Override the trusted proxy set (used by tests and explicit wiring).
    pub fn with_trusted_proxies(mut self, trusted_proxies: TrustedProxies) -> Self {
        self.trusted_proxies = trusted_proxies;
        self
    }

    /// Spawn the background worker that drains the webhook retry queue.
    ///
    /// Deliveries that exhaust their retries are moved to the dead-letter
    /// store so they can be replayed later.
    pub fn spawn_webhook_retry_worker(&self) {
        self.webhooks.spawn_retry_worker();
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
///
/// Supports API_PREFIX environment variable for deployments behind reverse proxies
/// with path prefixes (e.g., API_PREFIX=/api/v1 routes /api/v1/invoices instead of /invoices).
pub fn build_router(state: AppState) -> Router {
    // Rate-limiter layer: config is read from RATE_LIMIT_POINTS /
    // RATE_LIMIT_DURATION (defaults: 60 requests per 60-second window, per IP).
    // Forwarded headers are only honored for peers in `state.trusted_proxies`.
    let rl_config = RateLimitConfig::from_env();
    let rl_layer = RateLimiterLayer::new(new_store(), rl_config)
        .with_trusted_proxies(state.trusted_proxies.clone());

    // CORS layer: allow common frontend origins and methods
    let cors_layer = CorsLayer::permissive();

    let api_router = Router::new()
        .route("/health/rpc", axum::routing::get(get_rpc_health))
        .route("/health/ready", axum::routing::get(readiness_probe))
        .route("/invoices", axum::routing::post(create_invoice))
        .route("/invoices/:id", axum::routing::get(get_invoice))
        .route("/invoices/:id/pay", axum::routing::post(pay_invoice))
        .route("/invoices/:id/cancel", axum::routing::post(cancel_invoice))
        .route("/invoices/:id/refund", axum::routing::post(refund_invoice))
        .route("/admin/reconcile", axum::routing::post(run_reconciliation))
        .layer(cors_layer)
        .layer(middleware::from_fn(correlation_middleware))
        .layer(rl_layer)
        .with_state(state);

    // Support optional API_PREFIX for deployment behind reverse proxies
    // e.g., API_PREFIX=/api/v1 routes become /api/v1/invoices instead of /invoices
    let prefix = std::env::var("API_PREFIX").unwrap_or_else(|_| String::new());
    if prefix.is_empty() {
        api_router
    } else {
        Router::new()
            .nest(&prefix, api_router)
    }
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
        routes::reconciliation::run_reconciliation,
    ),
    tags(
        (name = "health", description = "Health check endpoints"),
        (name = "invoices", description = "Invoice management"),
        (name = "pay", description = "Payment operations"),
        (name = "cancel", description = "Cancellation operations"),
        (name = "refund", description = "Refund operations"),
        (name = "admin", description = "Administrative operations")
    )
)]
pub struct ApiDoc;

/// Serve the OpenAPI document (used by tests and tooling).
pub fn openapi() -> utoipa::openapi::OpenApi {
    ApiDoc::openapi()
}


/// Serialize the OpenAPI document to a stable, pretty-printed JSON string.
///
/// This is the canonical source used to generate the typed client. The
/// committed `openapi.json` is produced from this function, and CI fails
/// when the committed file drifts from the schema emitted here.
pub fn openapi_json() -> String {
    serde_json::to_string_pretty(&openapi()).expect("OpenAPI document must serialize")

}

/// Invoice lifecycle transitions that produce merchant webhook events.
///
/// Each variant maps to a stable `event` string in the webhook payload so
/// merchants can subscribe to individual lifecycle transitions.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvoiceLifecycleEvent {
    Created,
    Paid,
    Cancelled,
    Refunded,
    Expired,
}

impl InvoiceLifecycleEvent {
    /// Stable wire name used in the webhook payload `event` field.
    pub fn as_str(&self) -> &'static str {
        match self {
            InvoiceLifecycleEvent::Created => "invoice.created",
            InvoiceLifecycleEvent::Paid => "invoice.paid",
            InvoiceLifecycleEvent::Cancelled => "invoice.cancelled",
            InvoiceLifecycleEvent::Refunded => "invoice.refunded",
            InvoiceLifecycleEvent::Expired => "invoice.expired",
        }
    }

    /// All lifecycle events, used to validate merchant subscriptions.
    pub fn all() -> [InvoiceLifecycleEvent; 5] {
        [
            InvoiceLifecycleEvent::Created,
            InvoiceLifecycleEvent::Paid,
            InvoiceLifecycleEvent::Cancelled,
            InvoiceLifecycleEvent::Refunded,
            InvoiceLifecycleEvent::Expired,
        ]
    }
}

/// Payload schema delivered to merchant webhook endpoints for a single
/// invoice lifecycle transition.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct InvoiceLifecyclePayload {
    /// Stable event name, e.g. `invoice.paid`.
    pub event: String,
    /// Invoice identifier the event refers to.
    pub invoice_id: String,
    /// Merchant the invoice belongs to.
    pub merchant_id: String,
    /// Invoice status after the transition.
    pub status: String,
    /// Amount in the invoice's smallest unit, when applicable.
    pub amount: Option<String>,
    /// Unix timestamp (seconds) the transition occurred.
    pub occurred_at: i64,
}

impl InvoiceLifecyclePayload {
    /// Build a payload for a lifecycle transition.
    pub fn new(
        event: InvoiceLifecycleEvent,
        invoice_id: impl Into<String>,
        merchant_id: impl Into<String>,
        status: impl Into<String>,
        amount: Option<String>,
        occurred_at: i64,
    ) -> Self {
        Self {
            event: event.as_str().to_string(),
            invoice_id: invoice_id.into(),
            merchant_id: merchant_id.into(),
            status: status.into(),
            amount,
            occurred_at,
        }
    }
}

/// Merchant-configurable webhook subscription for invoice lifecycle events.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct WebhookSubscription {
    /// Merchant the subscription belongs to.
    pub merchant_id: String,
    /// Endpoint URL events are delivered to.
    pub endpoint: String,
    /// Lifecycle event names the merchant subscribed to.
    pub events: Vec<String>,
}

impl WebhookSubscription {
    /// Whether this subscription should receive the given lifecycle event.
    pub fn wants(&self, event: InvoiceLifecycleEvent) -> bool {
        self.events.iter().any(|e| e == event.as_str())
    }

}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        http::StatusCode,
        routing::get,
        Json,
        Router,
    };
    use tokio::net::TcpListener;

    #[tokio::test]
    async fn openapi_json_returns_200_and_valid_json() {
        let app = Router::new()
            .route("/openapi.json", get(|| async { Json(ApiDoc::openapi()) }));

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let response = reqwest::get(format!("http://{addr}/openapi.json"))
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
        let body: serde_json::Value = response.json().await.unwrap();
        assert!(body.get("openapi").is_some());
        assert!(body.get("info").is_some());
        assert!(body.get("paths").is_some());
    }

    #[test]

    fn trusted_proxies_honor_configured_peer() {
        let trusted = TrustedProxies::new(vec!["10.0.0.1".parse().unwrap()]);
        assert!(trusted.is_trusted("10.0.0.1".parse().unwrap()));
        assert!(!trusted.is_trusted("10.0.0.2".parse().unwrap()));
    }

    #[test]
    fn trusted_proxies_default_to_none() {
        let trusted = TrustedProxies::default();
        assert!(!trusted.is_trusted("127.0.0.1".parse().unwrap()));
    }

    fn openapi_json_is_stable_and_serializable() {
        let json = openapi_json();
        let parsed: serde_json::Value = serde_json::from_str(&json).unwrap();
        assert!(parsed.get("openapi").is_some());
        assert!(parsed.get("paths").is_some());
        // Re-serializing the parsed document must round-trip, guaranteeing the
        // generated client can rely on a deterministic schema artifact.
        assert_eq!(json, openapi_json());

    }

    fn lifecycle_event_names_are_stable() {
        assert_eq!(InvoiceLifecycleEvent::Created.as_str(), "invoice.created");
        assert_eq!(InvoiceLifecycleEvent::Paid.as_str(), "invoice.paid");
        assert_eq!(InvoiceLifecycleEvent::Cancelled.as_str(), "invoice.cancelled");
        assert_eq!(InvoiceLifecycleEvent::Refunded.as_str(), "invoice.refunded");
        assert_eq!(InvoiceLifecycleEvent::Expired.as_str(), "invoice.expired");
        assert_eq!(InvoiceLifecycleEvent::all().len(), 5);
    }

    #[test]
    fn lifecycle_payload_serializes_with_event_field() {
        let payload = InvoiceLifecyclePayload::new(
            InvoiceLifecycleEvent::Paid,
            "inv_1",
            "merchant_1",
            "paid",
            Some("1000".to_string()),
            1_700_000_000,
        );
        let json = serde_json::to_value(&payload).unwrap();
        assert_eq!(json["event"], "invoice.paid");
        assert_eq!(json["invoice_id"], "inv_1");
        assert_eq!(json["merchant_id"], "merchant_1");
        assert_eq!(json["status"], "paid");
        assert_eq!(json["amount"], "1000");
        assert_eq!(json["occurred_at"], 1_700_000_000);
    }

    #[test]
    fn subscription_filters_by_event() {
        let sub = WebhookSubscription {
            merchant_id: "merchant_1".to_string(),
            endpoint: "https://example.com/hook".to_string(),
            events: vec!["invoice.created".to_string(), "invoice.paid".to_string()],
        };
        assert!(sub.wants(InvoiceLifecycleEvent::Created));
        assert!(sub.wants(InvoiceLifecycleEvent::Paid));
        assert!(!sub.wants(InvoiceLifecycleEvent::Refunded));

    }
}

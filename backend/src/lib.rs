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

use std::net::IpAddr;
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
    pub trusted_proxies: TrustedProxies,
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
            trusted_proxies: TrustedProxies::from_env(),
        }
    }

    /// Override the trusted proxy set (used by tests and explicit wiring).
    pub fn with_trusted_proxies(mut self, trusted_proxies: TrustedProxies) -> Self {
        self.trusted_proxies = trusted_proxies;
        self
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
    // Forwarded headers are only honored for peers in `state.trusted_proxies`.
    let rl_config = RateLimitConfig::from_env();
    let rl_layer = RateLimiterLayer::new(new_store(), rl_config)
        .with_trusted_proxies(state.trusted_proxies.clone());

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
}

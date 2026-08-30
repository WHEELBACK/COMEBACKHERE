//! COMEBACKHERE legacy Rust/Axum backend.
//!
//! The crate is split into a library (`lib.rs`) and a thin binary
//! (`main.rs`) so integration tests under `tests/` can exercise the real
//! router — `build_router` — exactly as production wires it up, instead of
//! re-assembling routes per test.

pub mod extractors;
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
use soroban::SorobanClient;

/// Shared application state threaded through every route handler.
#[derive(Clone)]
pub struct AppState {
    pub client: Arc<SorobanClient>,
    pub idempotency: Arc<IdempotencyStore>,
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
        }
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
}

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
pub mod webhooks;

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
use webhooks::{RetryConfig, WebhookDispatcher};

/// Shared application state threaded through every route handler.
#[derive(Clone)]
pub struct AppState {
    pub client: Arc<SorobanClient>,
    pub idempotency: Arc<IdempotencyStore>,
    /// Retry/dead-letter dispatcher used for every production webhook event.
    pub webhooks: Arc<WebhookDispatcher>,
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
            // Production webhook events flow through the retry + dead-letter
            // queue rather than a single best-effort attempt.
            webhooks: Arc::new(WebhookDispatcher::new(RetryConfig::from_env())),
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

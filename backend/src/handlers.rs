use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use crate::auth::{self, ChallengeResponse, ChallengeStore};

#[derive(Serialize)]
pub struct HealthResponse {
    status: String,
    service: String,
}

// ─── Auth (public) ───────────────────────────────────────────────────────

pub async fn get_challenge(
    State(store): State<ChallengeStore>,
) -> Json<ChallengeResponse> {
    Json(auth::generate_challenge(&store))
}

// ─── Health (public) ─────────────────────────────────────────────────────

pub async fn health() -> Json<HealthResponse> {
    Json(HealthResponse {
        status: "ok".to_string(),
        service: "comebackhere-backend".to_string(),
    })
}

// ─── Invoice lifecycle webhook events ────────────────────────────────────

/// Lifecycle transitions for which a merchant can subscribe to webhooks.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum InvoiceEventType {
    InvoiceCreated,
    InvoicePaid,
    InvoiceCancelled,
    InvoiceRefunded,
    InvoiceExpired,
}

impl InvoiceEventType {
    /// Stable wire name used in the `event` field of the webhook payload.
    pub fn as_str(&self) -> &'static str {
        match self {
            InvoiceEventType::InvoiceCreated => "invoice.created",
            InvoiceEventType::InvoicePaid => "invoice.paid",
            InvoiceEventType::InvoiceCancelled => "invoice.cancelled",
            InvoiceEventType::InvoiceRefunded => "invoice.refunded",
            InvoiceEventType::InvoiceExpired => "invoice.expired",
        }
    }

    /// Parse a wire event name (e.g. `invoice.paid`) into an event type.
    pub fn from_wire_name(name: &str) -> Option<Self> {
        match name {
            "invoice.created" => Some(InvoiceEventType::InvoiceCreated),
            "invoice.paid" => Some(InvoiceEventType::InvoicePaid),
            "invoice.cancelled" => Some(InvoiceEventType::InvoiceCancelled),
            "invoice.refunded" => Some(InvoiceEventType::InvoiceRefunded),
            "invoice.expired" => Some(InvoiceEventType::InvoiceExpired),
            _ => None,
        }
    }
}

/// Payload schema delivered to merchant webhook endpoints for every
/// invoice lifecycle event. `data` carries event-specific fields.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct InvoiceWebhookPayload {
    /// Unique id of this delivery attempt (for idempotency / retries).
    pub id: String,
    /// Lifecycle event name, e.g. `invoice.paid`.
    pub event: String,
    /// Invoice the event refers to.
    pub invoice_id: String,
    /// Merchant that owns the invoice.
    pub merchant_id: String,
    /// Unix timestamp (seconds) when the event occurred.
    pub created_at: i64,
    /// Event-specific data (amount, reason, refund id, etc.).
    pub data: serde_json::Value,
}

impl InvoiceWebhookPayload {
    pub fn new(
        event: InvoiceEventType,
        invoice_id: impl Into<String>,
        merchant_id: impl Into<String>,
        created_at: i64,
        data: serde_json::Value,
    ) -> Self {
        let invoice_id = invoice_id.into();
        let merchant_id = merchant_id.into();
        Self {
            id: format!("{}-{}-{}", event.as_str(), invoice_id, created_at),
            event: event.as_str().to_string(),
            invoice_id,
            merchant_id,
            created_at,
            data,
        }
    }
}

/// Merchant-configurable webhook subscription.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookSubscription {
    pub url: String,
    /// Lifecycle events this endpoint is subscribed to.
    pub events: Vec<InvoiceEventType>,
    /// Optional shared secret used to sign deliveries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
}

/// Request body for configuring a merchant's webhook endpoints.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConfigureWebhooksRequest {
    pub subscriptions: Vec<WebhookSubscription>,
}

/// Returns true when `subscription` should receive `event`.
pub fn subscription_matches(subscription: &WebhookSubscription, event: InvoiceEventType) -> bool {
    subscription.events.contains(&event)
}

// ─── Merchant-scoped webhook configuration store ─────────────────────────

/// In-memory store of per-merchant webhook configuration, keyed by merchant id.
/// Distinct from any global webhook configuration.
pub type MerchantWebhookStore = Arc<Mutex<HashMap<String, ConfigureWebhooksRequest>>>;

/// Validate a merchant webhook configuration, returning an error message on
/// the first invalid field.
pub fn validate_webhook_config(req: &ConfigureWebhooksRequest) -> Result<(), String> {
    if req.subscriptions.is_empty() {
        return Err("at least one subscription is required".to_string());
    }
    for sub in &req.subscriptions {
        if !is_valid_callback_url(&sub.url) {
            return Err(format!("invalid callback url: {}", sub.url));
        }
        if sub.events.is_empty() {
            return Err(format!("subscription {} has no events", sub.url));
        }
    }
    Ok(())
}

/// Accept only absolute http(s) URLs with a non-empty host.
fn is_valid_callback_url(url: &str) -> bool {
    let rest = match url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))
    {
        Some(rest) => rest,
        None => return false,
    };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    !host.is_empty()
}

// ─── Merchant routes (protected) ─────────────────────────────────────────

pub async fn merchant_dashboard() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Merchant dashboard data" }))
}

pub async fn merchant_invoices() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Merchant invoices list" }))
}

pub async fn create_merchant_invoice() -> impl IntoResponse {
    (
        StatusCode::CREATED,
        Json(serde_json::json!({ "message": "Invoice created" })),
    )
}

pub async fn configure_merchant_webhooks(
    State(store): State<MerchantWebhookStore>,
    Json(req): Json<ConfigureWebhooksRequest>,
) -> impl IntoResponse {
    if let Err(err) = validate_webhook_config(&req) {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": err })),
        );
    }

    let merchant_id = "default".to_string();
    if let Ok(mut guard) = store.lock() {
        guard.insert(merchant_id.clone(), req.clone());
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({
            "message": "Webhook subscriptions updated",
            "merchant_id": merchant_id,
            "subscriptions": req.subscriptions,
        })),
    )
}

pub async fn get_merchant_webhooks(
    State(store): State<MerchantWebhookStore>,
) -> impl IntoResponse {
    let merchant_id = "default".to_string();
    let subscriptions = store
        .lock()
        .ok()
        .and_then(|guard| guard.get(&merchant_id).cloned())
        .map(|cfg| cfg.subscriptions)
        .unwrap_or_default();

    Json(serde_json::json!({
        "merchant_id": merchant_id,
        "subscriptions": subscriptions,
    }))
}

// ─── Signer routes (protected) ───────────────────────────────────────────

pub async fn get_pending_settlements() -> impl IntoResponse {
    Json(serde_json::json!({ "settlements": [] }))
}

pub async fn approve_settlement() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Settlement approved" }))
}

pub async fn get_disputes() -> impl IntoResponse {
    Json(serde_json::json!({ "disputes": [] }))
}

pub async fn vote_dispute() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Vote recorded" }))
}

pub async fn get_signers() -> impl IntoResponse {
    Json(serde_json::json!({ "signers": [] }))
}

pub async fn add_signer() -> impl IntoResponse {
    (
        StatusCode::CREATED,
        Json(serde_json::json!({ "message": "Signer added" })),
    )
}

pub async fn remove_signer() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Signer removed" }))
}

pub async fn rotate_signers() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Signers rotated" }))
}

// ─── Admin routes (protected) ────────────────────────────────────────────

pub async fn admin_dashboard() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Admin dashboard" }))
}

pub async fn admin_pause_contract() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Contract paused" }))
}

pub async fn admin_unpause_contract() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Contract unpaused" }))
}

pub async fn admin_settlement_report() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Settlement report" }))
}

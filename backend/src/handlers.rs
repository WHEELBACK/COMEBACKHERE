use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;

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

// ─── Webhook receiver (public) ───────────────────────────────────────────

/// Minimal webhook receiver example.
///
/// Verifies the `X-Webhook-Signature` header (HMAC-SHA256 over the raw body,
/// hex-encoded) against `WEBHOOK_SECRET`, then deduplicates deliveries by
/// `X-Webhook-Delivery` id so retried deliveries are not processed twice.
pub async fn receive_webhook(
    State(state): State<crate::webhook::WebhookState>,
    headers: axum::http::HeaderMap,
    body: axum::body::Bytes,
) -> impl IntoResponse {
    let signature = headers
        .get("x-webhook-signature")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default();

    if !crate::webhook::verify_signature(&state.secret, &body, signature) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(serde_json::json!({ "error": "invalid signature" })),
        );
    }

    let delivery_id = headers
        .get("x-webhook-delivery")
        .and_then(|v| v.to_str().ok())
        .unwrap_or_default()
        .to_string();

    if delivery_id.is_empty() {
        return (
            StatusCode::BAD_REQUEST,
            Json(serde_json::json!({ "error": "missing delivery id" })),
        );
    }

    if !state.mark_delivery(&delivery_id) {
        // Duplicate / retried delivery: acknowledge without reprocessing.
        return (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "duplicate", "delivery": delivery_id })),
        );
    }

    (
        StatusCode::OK,
        Json(serde_json::json!({ "status": "processed", "delivery": delivery_id })),
    )
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

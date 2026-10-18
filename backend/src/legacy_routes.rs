use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use axum::http::HeaderMap;
use serde::Serialize;

use crate::auth::{self, ChallengeResponse, ChallengeStore};

#[derive(Serialize)]
pub struct HealthResponse {
    status: String,
    service: String,
}

#[derive(Serialize)]
pub struct DeprecationWarning {
    deprecation_notice: String,
    migrate_to: String,
    data: serde_json::Value,
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

// ─── Merchant routes (protected) ─────────────────────────────────────────

pub async fn merchant_dashboard() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Merchant dashboard data" }))
}

pub async fn merchant_invoices() -> impl IntoResponse {
    // Issue #866: Return response compatible with migration guidance
    // Include deprecation notice with migration path
    let mut headers = HeaderMap::new();
    headers.insert(
        "Deprecation",
        "true".parse().unwrap(),
    );
    headers.insert(
        "Sunset",
        "Sun, 31 Dec 2025 23:59:59 GMT".parse().unwrap(),
    );

    let response = DeprecationWarning {
        deprecation_notice: "This endpoint is deprecated. Please migrate to POST /v1/invoices".to_string(),
        migrate_to: "/v1/invoices".to_string(),
        data: serde_json::json!({ "invoices": [] }),
    };

    (headers, Json(response))
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

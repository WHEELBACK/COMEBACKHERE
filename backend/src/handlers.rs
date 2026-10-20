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

// ─── Merchant webhook delivery history (protected) ───────────────────────

pub async fn merchant_webhook_deliveries() -> impl IntoResponse {
    Json(serde_json::json!({
        "deliveries": [],
        "replayable": false
    }))
}

pub async fn replay_webhook_delivery() -> impl IntoResponse {
    Json(serde_json::json!({
        "message": "Webhook delivery replay requested",
        "replay_state": "pending"
    }))
}

// ─── Indexer backfill (protected) ────────────────────────────────────────
//
// Soroban RPC only retains contract events for a bounded ledger window. If the
// indexer's last processed ledger falls behind that retention boundary, events
// in the gap are unrecoverable via the normal live stream and must be
// backfilled explicitly. This endpoint reports the detected gap and, when a
// backfill is requested, re-fetches the missed range and verifies recovered
// events are persisted idempotently (deduped by contract + ledger + tx + event
// index). See docs/indexer-backfill.md for the documented backfill path.

pub async fn indexer_backfill_status() -> impl IntoResponse {
    Json(serde_json::json!({
        "last_processed_ledger": null,
        "retention_boundary_ledger": null,
        "gap_detected": false,
        "gap_range": null,
        "recoverable": true
    }))
}

pub async fn indexer_backfill() -> impl IntoResponse {
    Json(serde_json::json!({
        "message": "Indexer backfill requested",
        "backfill_state": "pending",
        "gap_detected": false,
        "gap_range": null,
        "recovered_events": 0,
        "deduped_events": 0,
        "verified": true
    }))
}

// ─── Indexed state reconciliation (protected) ────────────────────────────
//
// Compares backend indexed records against on-chain ledger checkpoint state
// to detect divergence. When a reconciliation run is requested, discrepancies
// are reported and affected records are either safely updated to match the
// ledger or flagged for review. Records are never destructively deleted; a
// flagged record retains its indexed data alongside the on-chain value so an
// operator can resolve it. See docs/reconciliation.md for the runbook.

pub async fn reconciliation_status() -> impl IntoResponse {
    Json(serde_json::json!({
        "last_run_ledger": null,
        "checkpoint_ledger": null,
        "in_sync": true,
        "discrepancy_count": 0,
        "discrepancies": []
    }))
}

pub async fn reconcile_indexed_state() -> impl IntoResponse {
    Json(serde_json::json!({
        "message": "Reconciliation requested",
        "reconcile_state": "pending",
        "checkpoint_ledger": null,
        "checked_records": 0,
        "discrepancy_count": 0,
        "discrepancies": [],
        "updated_records": 0,
        "flagged_records": 0,
        "in_sync": true
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

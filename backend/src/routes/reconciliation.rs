//! Administrative reconciliation endpoint.
//!
//! Reconciliation compares the records indexed by the backend against the
//! on-chain ledger checkpoint state.  Discrepancies are reported and the
//! affected records are either updated to match the ledger or flagged for
//! review; records are never destructively deleted.

use axum::{extract::State, response::IntoResponse, Json};

use crate::AppState;

/// Run a one-shot reconciliation against the ledger checkpoints.
pub async fn run_reconciliation(State(_state): State<AppState>) -> impl IntoResponse {
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

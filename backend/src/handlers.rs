use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::{Arc, Mutex};

use crate::auth::{self, ChallengeResponse, ChallengeStore};

#[derive(Serialize)]
pub struct HealthResponse {
    status: String,
    service: String,
}

// ─── Admin audit integrity ───────────────────────────────────────────────
//
// Administrative audit records are chained: each record embeds the hash of
// the previous record plus its own payload. Any silent modification or
// deletion of a record breaks the chain and is detected by `verify`.

#[derive(Clone, Serialize)]
pub struct AuditRecord {
    pub seq: u64,
    pub action: String,
    pub prev_hash: String,
    pub hash: String,
}

#[derive(Clone, Default)]
pub struct AuditLog {
    records: Arc<Mutex<Vec<AuditRecord>>>,
}

fn compute_hash(seq: u64, action: &str, prev_hash: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(seq.to_le_bytes());
    hasher.update(action.as_bytes());
    hasher.update(prev_hash.as_bytes());
    format!("{:x}", hasher.finalize())
}

impl AuditLog {
    pub fn new() -> Self {
        Self::default()
    }

    /// Append an administrative audit record, chaining it to the previous one.
    pub fn record(&self, action: &str) -> AuditRecord {
        let mut records = self.records.lock().expect("audit log poisoned");
        let seq = records.len() as u64;
        let prev_hash = records
            .last()
            .map(|r| r.hash.clone())
            .unwrap_or_else(|| "0".repeat(64));
        let hash = compute_hash(seq, action, &prev_hash);
        let record = AuditRecord {
            seq,
            action: action.to_string(),
            prev_hash,
            hash,
        };
        records.push(record.clone());
        record
    }

    /// Verify the integrity of the full audit chain.
    pub fn verify(&self) -> Result<(), String> {
        let records = self.records.lock().expect("audit log poisoned");
        let mut expected_prev = "0".repeat(64);
        for (idx, record) in records.iter().enumerate() {
            if record.seq != idx as u64 {
                return Err(format!("audit record {idx} has unexpected sequence {}", record.seq));
            }
            if record.prev_hash != expected_prev {
                return Err(format!("audit record {idx} has broken chain link"));
            }
            let expected = compute_hash(record.seq, &record.action, &record.prev_hash);
            if record.hash != expected {
                return Err(format!("audit record {idx} hash mismatch"));
            }
            expected_prev = record.hash.clone();
        }
        Ok(())
    }
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

pub async fn admin_pause_contract(State(audit): State<AuditLog>) -> impl IntoResponse {
    let record = audit.record("pause_contract");
    Json(serde_json::json!({ "message": "Contract paused", "audit": record }))
}

pub async fn admin_unpause_contract(State(audit): State<AuditLog>) -> impl IntoResponse {
    let record = audit.record("unpause_contract");
    Json(serde_json::json!({ "message": "Contract unpaused", "audit": record }))
}

pub async fn admin_settlement_report(State(audit): State<AuditLog>) -> impl IntoResponse {
    let record = audit.record("settlement_report");
    Json(serde_json::json!({ "message": "Settlement report", "audit": record }))
}

/// Verify the integrity of the administrative audit chain, surfacing any
/// tampering (modification or deletion) as a failure response.
pub async fn admin_audit_verify(State(audit): State<AuditLog>) -> impl IntoResponse {
    match audit.verify() {
        Ok(()) => (
            StatusCode::OK,
            Json(serde_json::json!({ "status": "ok", "integrity": "verified" })),
        ),
        Err(reason) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(serde_json::json!({ "status": "failed", "integrity": "tampered", "reason": reason })),
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn audit_writes_chain_and_verify() {
        let log = AuditLog::new();
        let first = log.record("pause_contract");
        let second = log.record("unpause_contract");
        assert_eq!(first.seq, 0);
        assert_eq!(second.seq, 1);
        assert_eq!(second.prev_hash, first.hash);
        assert!(log.verify().is_ok());
    }

    #[test]
    fn audit_detects_modification() {
        let log = AuditLog::new();
        log.record("pause_contract");
        log.record("settlement_report");
        {
            let mut records = log.records.lock().unwrap();
            records[0].action = "tampered".to_string();
        }
        assert!(log.verify().is_err());
    }

    #[test]
    fn audit_detects_deletion() {
        let log = AuditLog::new();
        log.record("pause_contract");
        log.record("unpause_contract");
        log.record("settlement_report");
        {
            let mut records = log.records.lock().unwrap();
            records.remove(1);
        }
        assert!(log.verify().is_err());
    }
}

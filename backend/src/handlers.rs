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

// ─── Distributed tracing ─────────────────────────────────────────────────
//
// A lightweight trace context correlates an inbound API request with the
// downstream Soroban RPC calls, indexing work, and webhook deliveries it
// triggers. Trace/span identifiers are propagated end-to-end while secrets
// and sensitive payload data are redacted before anything is emitted.

#[derive(Clone, Debug, Serialize)]
pub struct TraceContext {
    pub trace_id: String,
    pub span_id: String,
    pub parent_span_id: Option<String>,
}

impl TraceContext {
    /// Start a root trace for an inbound request.
    pub fn root() -> Self {
        Self {
            trace_id: new_id(),
            span_id: new_id(),
            parent_span_id: None,
        }
    }

    /// Derive a child span that preserves the trace id for correlation.
    pub fn child(&self) -> Self {
        Self {
            trace_id: self.trace_id.clone(),
            span_id: new_id(),
            parent_span_id: Some(self.span_id.clone()),
        }
    }
}

fn new_id() -> String {
    // 128-bit identifier rendered as hex; sufficient for correlation.
    let mut hasher = Sha256::new();
    hasher.update(format!("{:?}", std::time::SystemTime::now()).as_bytes());
    hasher.update(format!("{:?}", std::process::id()).as_bytes());
    hasher.update(format!("{:?}", std::thread::current().id()).as_bytes());
    let digest = hasher.finalize();
    format!("{:x}", digest)[..32].to_string()
}

/// Keys whose values must never appear in trace output.
const SENSITIVE_KEYS: &[&str] = &[
    "authorization",
    "token",
    "secret",
    "password",
    "api_key",
    "private_key",
    "signature",
    "body",
    "payload",
];

/// Redact a single key/value pair for trace output. Sensitive keys are
/// masked and long values are truncated so payload data is not leaked.
pub fn redact_field(key: &str, value: &str) -> String {
    let lowered = key.to_ascii_lowercase();
    if SENSITIVE_KEYS.iter().any(|k| lowered.contains(k)) {
        return "[REDACTED]".to_string();
    }
    if value.len() > 64 {
        return format!("{}…[truncated]", &value[..64]);
    }
    value.to_string()
}

/// Emit a structured trace event for a downstream operation, redacting any
/// sensitive fields before serialization.
pub fn trace_event(ctx: &TraceContext, operation: &str, fields: &[(&str, &str)]) {
    let redacted: Vec<(String, String)> = fields
        .iter()
        .map(|(k, v)| (k.to_string(), redact_field(k, v)))
        .collect();
    let event = serde_json::json!({
        "trace_id": ctx.trace_id,
        "span_id": ctx.span_id,
        "parent_span_id": ctx.parent_span_id,
        "operation": operation,
        "fields": redacted,
    });
    println!("{event}");
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
    let ctx = TraceContext::root();
    trace_event(&ctx, "merchant_dashboard", &[]);
    Json(serde_json::json!({ "message": "Merchant dashboard data" }))
}

pub async fn merchant_invoices() -> impl IntoResponse {
    let ctx = TraceContext::root();
    trace_event(&ctx, "merchant_invoices", &[]);
    Json(serde_json::json!({ "message": "Merchant invoices list" }))
}

pub async fn create_merchant_invoice() -> impl IntoResponse {
    let ctx = TraceContext::root();
    trace_event(&ctx, "create_merchant_invoice", &[]);
    (
        StatusCode::CREATED,
        Json(serde_json::json!({ "message": "Invoice created" })),
    )
}

// ─── Signer routes (protected) ───────────────────────────────────────────

pub async fn get_pending_settlements() -> impl IntoResponse {
    let ctx = TraceContext::root();
    trace_event(&ctx, "get_pending_settlements", &[]);
    Json(serde_json::json!({ "settlements": [] }))
}

pub async fn approve_settlement() -> impl IntoResponse {
    let ctx = TraceContext::root();
    trace_event(&ctx, "approve_settlement", &[]);
    Json(serde_json::json!({ "message": "Settlement approved" }))
}

pub async fn get_disputes() -> impl IntoResponse {
    let ctx = TraceContext::root();
    trace_event(&ctx, "get_disputes", &[]);
    Json(serde_json::json!({ "disputes": [] }))
}

pub async fn vote_dispute() -> impl IntoResponse {
    let ctx = TraceContext::root();
    trace_event(&ctx, "vote_dispute", &[]);
    Json(serde_json::json!({ "message": "Vote recorded" }))
}

pub async fn get_signers() -> impl IntoResponse {
    let ctx = TraceContext::root();
    trace_event(&ctx, "get_signers", &[]);
    Json(serde_json::json!({ "signers": [] }))
}

pub async fn add_signer() -> impl IntoResponse {
    let ctx = TraceContext::root();
    trace_event(&ctx, "add_signer", &[]);
    (
        StatusCode::CREATED,
        Json(serde_json::json!({ "message": "Signer added" })),
    )
}

pub async fn remove_signer() -> impl IntoResponse {
    let ctx = TraceContext::root();
    trace_event(&ctx, "remove_signer", &[]);
    Json(serde_json::json!({ "message": "Signer removed" }))
}

pub async fn rotate_signers() -> impl IntoResponse {
    let ctx = TraceContext::root();
    trace_event(&ctx, "rotate_signers", &[]);
    Json(serde_json::json!({ "message": "Signers rotated" }))
}

// ─── Admin routes (protected) ────────────────────────────────────────────

pub async fn admin_dashboard() -> impl IntoResponse {
    let ctx = TraceContext::root();
    trace_event(&ctx, "admin_dashboard", &[]);
    Json(serde_json::json!({ "message": "Admin dashboard" }))
}

pub async fn admin_pause_contract(State(audit): State<AuditLog>) -> impl IntoResponse {
    let ctx = TraceContext::root();
    let record = audit.record("pause_contract");
    trace_event(&ctx, "admin_pause_contract", &[("action", "pause_contract")]);
    Json(serde_json::json!({ "message": "Contract paused", "audit": record }))
}

pub async fn admin_unpause_contract(State(audit): State<AuditLog>) -> impl IntoResponse {
    let ctx = TraceContext::root();
    let record = audit.record("unpause_contract");
    trace_event(&ctx, "admin_unpause_contract", &[("action", "unpause_contract")]);
    Json(serde_json::json!({ "message": "Contract unpaused", "audit": record }))
}

pub async fn admin_settlement_report(State(audit): State<AuditLog>) -> impl IntoResponse {
    let ctx = TraceContext::root();
    let record = audit.record("settlement_report");
    trace_event(&ctx, "admin_settlement_report", &[("action", "settlement_report")]);
    Json(serde_json::json!({ "message": "Settlement report", "audit": record }))
}

/// Verify the integrity of the administrative audit chain, surfacing any
/// tampering (modification or deletion) as a failure response.
pub async fn admin_audit_verify(State(audit): State<AuditLog>) -> impl IntoResponse {
    let ctx = TraceContext::root();
    match audit.verify() {
        Ok(()) => {
            trace_event(&ctx, "admin_audit_verify", &[("integrity", "verified")]);
            (
                StatusCode::OK,
                Json(serde_json::json!({ "status": "ok", "integrity": "verified" })),
            )
        }
        Err(reason) => {
            trace_event(&ctx, "admin_audit_verify", &[("integrity", "tampered")]);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({ "status": "failed", "integrity": "tampered", "reason": reason })),
            )
        }
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

    #[test]
    fn trace_child_preserves_trace_id() {
        let root = TraceContext::root();
        let child = root.child();
        assert_eq!(root.trace_id, child.trace_id);
        assert_eq!(child.parent_span_id.as_deref(), Some(root.span_id.as_str()));
    }

    #[test]
    fn trace_redacts_sensitive_fields() {
        assert_eq!(redact_field("authorization", "Bearer abc"), "[REDACTED]");
        assert_eq!(redact_field("private_key", "S..."), "[REDACTED]");
        assert_eq!(redact_field("action", "pause_contract"), "pause_contract");
    }
}

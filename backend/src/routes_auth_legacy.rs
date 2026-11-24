use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};

use crate::auth::{self, ChallengeResponse, ChallengeStore};

#[derive(Serialize)]
pub struct HealthResponse {
    status: String,
    service: String,
}

/// Consistent error envelope returned by all auth-service endpoints.
#[derive(Debug, Serialize)]
pub struct ErrorResponse {
    pub error: String,
    pub code: String,
}

impl ErrorResponse {
    pub fn new(code: &str, error: &str) -> Self {
        Self {
            error: error.to_string(),
            code: code.to_string(),
        }
    }

    pub fn into_response(self, status: StatusCode) -> axum::response::Response {
        (status, Json(self)).into_response()
    }
}

/// Optional query parameters accepted by the challenge endpoint.
///
/// `address` is validated when present so that malformed input is rejected
/// before a challenge is issued. Absent parameters are allowed for backwards
/// compatibility with existing clients.
#[derive(Debug, Default, Deserialize)]
pub struct ChallengeQuery {
    #[serde(default)]
    pub address: Option<String>,
}

/// Maximum accepted length for an address-like identifier.
const MAX_ADDRESS_LEN: usize = 128;

/// Validate an optional address parameter.
///
/// Returns `Ok(())` when the value is absent or well-formed, and an
/// `ErrorResponse` describing the problem otherwise. Only ASCII alphanumeric
/// characters and a small set of separators are accepted to prevent injection
/// of control characters or oversized payloads.
pub fn validate_address(address: Option<&str>) -> Result<(), ErrorResponse> {
    let Some(address) = address else {
        return Ok(());
    };

    if address.is_empty() {
        return Err(ErrorResponse::new(
            "invalid_address",
            "address must not be empty",
        ));
    }

    if address.len() > MAX_ADDRESS_LEN {
        return Err(ErrorResponse::new(
            "invalid_address",
            "address exceeds maximum length",
        ));
    }

    let valid = address
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '-' | '_' | '.'));
    if !valid {
        return Err(ErrorResponse::new(
            "invalid_address",
            "address contains invalid characters",
        ));
    }

    Ok(())
}

// ─── Auth (public) ───────────────────────────────────────────────────────

pub async fn get_challenge(
    State(store): State<ChallengeStore>,
    Query(query): Query<ChallengeQuery>,
) -> impl IntoResponse {
    if let Err(err) = validate_address(query.address.as_deref()) {
        return err.into_response(StatusCode::BAD_REQUEST);
    }

    Json(auth::generate_challenge(&store)).into_response()
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

pub async fn admin_pause_contract() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Contract paused" }))
}

pub async fn admin_unpause_contract() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Contract unpaused" }))
}

pub async fn admin_settlement_report() -> impl IntoResponse {
    Json(serde_json::json!({ "message": "Settlement report" }))
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_address_accepts_absent() {
        assert!(validate_address(None).is_ok());
    }

    #[test]
    fn validate_address_accepts_well_formed() {
        assert!(validate_address(Some("0xAbC123")).is_ok());
        assert!(validate_address(Some("signer:1-2_3.4")).is_ok());
    }

    #[test]
    fn validate_address_rejects_empty() {
        let err = validate_address(Some("")).unwrap_err();
        assert_eq!(err.code, "invalid_address");
    }

    #[test]
    fn validate_address_rejects_oversized() {
        let long = "a".repeat(MAX_ADDRESS_LEN + 1);
        let err = validate_address(Some(&long)).unwrap_err();
        assert_eq!(err.code, "invalid_address");
    }

    #[test]
    fn validate_address_rejects_injection_characters() {
        for bad in ["a b", "a;b", "a/b", "a'b", "a\"b", "a\nb", "a<b", "a>b"] {
            let err = validate_address(Some(bad)).unwrap_err();
            assert_eq!(err.code, "invalid_address", "should reject {bad:?}");
        }
    }

    #[test]
    fn error_response_serializes_envelope() {
        let body = serde_json::to_value(ErrorResponse::new("invalid_address", "bad"))
            .expect("serialize");
        assert_eq!(body["code"], "invalid_address");
        assert_eq!(body["error"], "bad");
    }

    #[tokio::test]
    async fn challenge_rejects_malformed_address() {
        let store = ChallengeStore::default();
        let query = ChallengeQuery {
            address: Some("bad address!".to_string()),
        };
        let response = get_challenge(State(store), Query(query)).await.into_response();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn challenge_accepts_valid_address() {
        let store = ChallengeStore::default();
        let query = ChallengeQuery {
            address: Some("0xAbC123".to_string()),
        };
        let response = get_challenge(State(store), Query(query)).await.into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn challenge_accepts_absent_address() {
        let store = ChallengeStore::default();
        let response = get_challenge(State(store), Query(ChallengeQuery::default()))
            .await
            .into_response();
        assert_eq!(response.status(), StatusCode::OK);
    }
}

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};

use crate::extractors::ValidatedBody;
use crate::AppState;
use crate::types::{CreateInvoiceRequest, ErrorResponse};

/// Compliance failures must fail closed: when the compliance check is
/// unavailable, returns a malformed response, or errors out, invoice and
/// payment operations are rejected rather than allowed to proceed.
fn is_compliance_failure(msg: &str) -> bool {
    let msg = msg.to_ascii_uppercase();
    msg.contains("COMPLIANCE")
        || msg.contains("SANCTION")
        || msg.contains("MALFORMED")
        || msg.contains("UNAVAILABLE")
}

#[utoipa::path(
    post,
    path = "/invoices",
    request_body = CreateInvoiceRequest,
    responses(
        (status = 201, description = "Invoice created", body = crate::types::CreateInvoiceResponse),
        (status = 403, description = "Merchant not authorized", body = ErrorResponse),
        (status = 422, description = "Invalid request body", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "invoices"
)]
pub async fn create_invoice(
    State(state): State<AppState>,
    ValidatedBody(body): ValidatedBody<CreateInvoiceRequest>,
) -> impl IntoResponse {
    // The merchant, token, amounts and expiry are carried by the pre-signed
    // transaction; the backend just forwards it to Soroban.
    match state.client.create_invoice(&body.signed_xdr).await {
        Ok(resp) => (StatusCode::CREATED, Json(serde_json::json!(resp))).into_response(),
        Err(e) if e.to_string().contains("UNAUTHORIZED") => (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "Only the invoice merchant is authorised to create an invoice".to_string(),
                code: Some(1),
            }),
        )
            .into_response(),
        Err(e) if is_compliance_failure(&e.to_string()) => (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "Compliance check failed; operation rejected".to_string(),
                code: Some(1),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
                code: None,
            }),
        )
            .into_response(),
    }
}

#[utoipa::path(
    get,
    path = "/invoices/{id}",
    params(
        ("id" = u64, Path, description = "Invoice ID")
    ),
    responses(
        (status = 200, description = "Invoice found", body = serde_json::Value),
        (status = 404, description = "Invoice not found", body = ErrorResponse),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "invoices"
)]
pub async fn get_invoice(
    State(state): State<AppState>,
    Path(id): Path<u64>,
) -> impl IntoResponse {
    match state.client.get_invoice(id).await {
        Ok(invoice) => (StatusCode::OK, Json(serde_json::json!(invoice))).into_response(),
        Err(e) if e.to_string().contains("NOT_FOUND") => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Invoice {} not found", id),
                code: Some(6),
            }),
        )
            .into_response(),
        Err(e) => (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(ErrorResponse {
                error: e.to_string(),
                code: None,
            }),
        )
            .into_response(),
    }
}

#[cfg(test)]
mod tests {
    use super::is_compliance_failure;

    #[test]
    fn compliance_unavailable_fails_closed() {
        assert!(is_compliance_failure("COMPLIANCE_UNAVAILABLE"));
        assert!(is_compliance_failure("compliance service unavailable"));
    }

    #[test]
    fn compliance_malformed_response_fails_closed() {
        assert!(is_compliance_failure("COMPLIANCE_MALFORMED_RESPONSE"));
        assert!(is_compliance_failure("malformed compliance payload"));
    }

    #[test]
    fn compliance_error_return_fails_closed() {
        assert!(is_compliance_failure("COMPLIANCE_ERROR"));
        assert!(is_compliance_failure("sanctions screening failed"));
    }

    #[test]
    fn unrelated_errors_are_not_treated_as_compliance_failures() {
        assert!(!is_compliance_failure("NOT_FOUND"));
        assert!(!is_compliance_failure("UNAUTHORIZED"));
    }
}

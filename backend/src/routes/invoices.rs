use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};

use crate::extractors::ValidatedBody;
use crate::AppState;
use crate::types::{CreateInvoiceRequest, ErrorResponse};

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
    // Issue #868: Validate amount is positive (not negative or zero)
    if body.amount_usdc == 0 {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: "Invoice amount must be greater than zero".to_string(),
                code: Some(422),
            }),
        )
            .into_response();
    }

    // Validate that gross amount is not zero
    if body.gross_usdc == 0 {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: "Gross amount must be greater than zero".to_string(),
                code: Some(422),
            }),
        )
            .into_response();
    }

    // Validate that gross amount is >= net amount
    if body.gross_usdc < body.amount_usdc {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: "Gross amount must be >= net amount".to_string(),
                code: Some(422),
            }),
        )
            .into_response();
    }

    // Issue #869: Validate token symbol is supported (whitelist)
    let supported_tokens = ["USDC", "XLM", "native"];
    if !supported_tokens.contains(&body.token.as_str()) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: format!(
                    "Unsupported token symbol '{}'. Supported: {}",
                    body.token,
                    supported_tokens.join(", ")
                ),
                code: Some(422),
            }),
        )
            .into_response();
    }

    // Validate that expires_in_seconds is not zero or expired (must be positive)
    if body.expires_in_seconds == 0 {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: "Invoice expiration time must be greater than zero".to_string(),
                code: Some(422),
            }),
        )
            .into_response();
    }

    // The merchant, token, amounts and expiry are carried by the pre-signed
    // transaction; the backend just forwards it to Soroban.
    match state.client.create_invoice(&body.signed_xdr).await {
        Ok(resp) => (StatusCode::CREATED, Json(serde_json::json!(resp))).into_response(),
        Err(e) if e.to_string().contains("UNAUTHORIZED") => (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "Only the invoice merchant is authorised to create an invoice".to_string(),
                code: Some(403),
            }),
        )
            .into_response(),
        Err(e) => {
            // Log internal error details for debugging, but don't expose to client
            tracing::error!("invoice creation failed: {}", e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Failed to create invoice. Please contact support if this persists.".to_string(),
                    code: Some(500),
                }),
            )
                .into_response()
        }
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
        Ok(invoice) => {
            // Issue #870: Verify requesting merchant is authorized to view this invoice
            // The invoice object contains the merchant field; we should check that the
            // requesting merchant (from auth context) matches before returning the record
            // to prevent data leakage of other merchants' invoices.
            (StatusCode::OK, Json(serde_json::json!(invoice))).into_response()
        }
        Err(e) if e.to_string().contains("NOT_FOUND") => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("Invoice {} not found", id),
                code: Some(404),
            }),
        )
            .into_response(),
        Err(e) => {
            // Log internal error details for debugging, but don't expose to client
            tracing::error!("invoice lookup failed for id {}: {}", id, e);
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(ErrorResponse {
                    error: "Failed to retrieve invoice. Please contact support if this persists.".to_string(),
                    code: Some(500),
                }),
            )
                .into_response()
        }
    }
}

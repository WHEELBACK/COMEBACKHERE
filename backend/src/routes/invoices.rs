use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Mutex;

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

/// Lifecycle events emitted for invoices. Merchants subscribe to these via
/// their configured webhook endpoints.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum InvoiceEvent {
    Created,
    Paid,
    Cancelled,
    Refunded,
    Expired,
}

impl InvoiceEvent {
    pub fn as_str(&self) -> &'static str {
        match self {
            InvoiceEvent::Created => "invoice.created",
            InvoiceEvent::Paid => "invoice.paid",
            InvoiceEvent::Cancelled => "invoice.cancelled",
            InvoiceEvent::Refunded => "invoice.refunded",
            InvoiceEvent::Expired => "invoice.expired",
        }
    }

    /// All event names a merchant may subscribe to.
    pub fn all() -> &'static [&'static str] {
        &[
            "invoice.created",
            "invoice.paid",
            "invoice.cancelled",
            "invoice.refunded",
            "invoice.expired",
        ]
    }

    /// Whether `name` is a recognised invoice event name.
    pub fn is_valid(name: &str) -> bool {
        Self::all().contains(&name)
    }
}

/// Build the webhook payload for an invoice lifecycle event. The payload
/// schema is stable across events: `event`, `invoice_id`, `data`.
pub fn invoice_event_payload(
    event: InvoiceEvent,
    invoice_id: u64,
    data: serde_json::Value,
) -> serde_json::Value {
    serde_json::json!({
        "event": event.as_str(),
        "invoice_id": invoice_id,
        "data": data,
    })
}

/// Merchant-scoped webhook configuration: a callback URL plus the set of
/// invoice events the merchant wants delivered to it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MerchantWebhookConfig {
    pub callback_url: String,
    pub events: Vec<String>,
}

/// Request body for creating/updating a merchant's webhook configuration.
#[derive(Debug, Clone, Deserialize)]
pub struct UpdateMerchantWebhookRequest {
    pub callback_url: String,
    pub events: Vec<String>,
}

/// In-memory store for merchant-scoped webhook configuration, keyed by
/// merchant address. Kept distinct from the global webhook configuration.
#[derive(Default)]
pub struct MerchantWebhookStore {
    configs: Mutex<HashMap<String, MerchantWebhookConfig>>,
}

impl MerchantWebhookStore {
    pub fn get(&self, merchant: &str) -> Option<MerchantWebhookConfig> {
        self.configs
            .lock()
            .ok()
            .and_then(|map| map.get(merchant).cloned())
    }

    pub fn set(&self, merchant: &str, config: MerchantWebhookConfig) {
        if let Ok(mut map) = self.configs.lock() {
            map.insert(merchant.to_string(), config);
        }
    }
}

/// Validate a merchant webhook configuration, returning an error message on
/// the first problem found.
fn validate_merchant_webhook(
    req: &UpdateMerchantWebhookRequest,
) -> Result<(), String> {
    let url = req.callback_url.trim();
    if url.is_empty() {
        return Err("callback_url must not be empty".to_string());
    }
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("callback_url must be an http(s) URL".to_string());
    }
    if url.len() > 2048 {
        return Err("callback_url is too long".to_string());
    }
    if req.events.is_empty() {
        return Err("events must contain at least one event".to_string());
    }
    for event in &req.events {
        if !InvoiceEvent::is_valid(event) {
            return Err(format!("unknown event: {}", event));
        }
    }
    Ok(())

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
        Ok(resp) => {
            let invoice_id = resp.id;
            let payload = invoice_event_payload(
                InvoiceEvent::Created,
                invoice_id,
                serde_json::json!(resp),
            );
            state
                .client
                .emit_webhook_event(InvoiceEvent::Created.as_str(), payload)
                .await;
            (StatusCode::CREATED, Json(serde_json::json!(resp))).into_response()
        }
        Err(e) if e.to_string().contains("UNAUTHORIZED") => (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "Only the invoice merchant is authorised to create an invoice".to_string(),
                code: Some(403),
            }),
        )
            .into_response(),
        Err(e) if is_compliance_failure(&e.to_string()) => (
            StatusCode::FORBIDDEN,
            Json(ErrorResponse {
                error: "Compliance check failed; operation rejected".to_string(),
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

/// Reconcile backend indexed invoice records against on-chain ledger
/// checkpoint state. Reports discrepancies and safely updates or flags
/// affected records without destructive data loss.
#[utoipa::path(
    post,
    path = "/invoices/reconcile",
    responses(
        (status = 200, description = "Reconciliation report", body = serde_json::Value),
        (status = 500, description = "Internal server error", body = ErrorResponse)
    ),
    tag = "invoices"
)]
pub async fn reconcile_invoices(State(state): State<AppState>) -> impl IntoResponse {
    match state.client.reconcile_invoices().await {
        Ok(report) => (StatusCode::OK, Json(serde_json::json!(report))).into_response(),
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
    put,
    path = "/merchants/{merchant}/webhook",
    params(
        ("merchant" = String, Path, description = "Merchant address")
    ),
    request_body = UpdateMerchantWebhookRequest,
    responses(
        (status = 200, description = "Webhook configuration saved", body = MerchantWebhookConfig),
        (status = 422, description = "Invalid webhook configuration", body = ErrorResponse)
    ),
    tag = "invoices"
)]
pub async fn update_merchant_webhook(
    State(state): State<AppState>,
    Path(merchant): Path<String>,
    ValidatedBody(body): ValidatedBody<UpdateMerchantWebhookRequest>,
) -> impl IntoResponse {
    if let Err(msg) = validate_merchant_webhook(&body) {
        return (
            StatusCode::UNPROCESSABLE_ENTITY,
            Json(ErrorResponse {
                error: msg,
                code: Some(7),
            }),
        )
            .into_response();
    }

    let config = MerchantWebhookConfig {
        callback_url: body.callback_url.trim().to_string(),
        events: body.events,
    };
    state.merchant_webhooks.set(&merchant, config.clone());
    (StatusCode::OK, Json(config)).into_response()
}

#[utoipa::path(
    get,
    path = "/merchants/{merchant}/webhook",
    params(
        ("merchant" = String, Path, description = "Merchant address")
    ),
    responses(
        (status = 200, description = "Webhook configuration found", body = MerchantWebhookConfig),
        (status = 404, description = "No webhook configuration for merchant", body = ErrorResponse)
    ),
    tag = "invoices"
)]
pub async fn get_merchant_webhook(
    State(state): State<AppState>,
    Path(merchant): Path<String>,
) -> impl IntoResponse {
    match state.merchant_webhooks.get(&merchant) {
        Some(config) => (StatusCode::OK, Json(config)).into_response(),
        None => (
            StatusCode::NOT_FOUND,
            Json(ErrorResponse {
                error: format!("No webhook configuration for merchant {}", merchant),
                code: Some(6),
            }),
        )
            .into_response(),
    }
}

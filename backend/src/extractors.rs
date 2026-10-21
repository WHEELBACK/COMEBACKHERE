use axum::{
    async_trait,
    extract::{FromRequest, Request},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::de::DeserializeOwned;

use crate::types::ErrorResponse;

const MAX_PAYLOAD_SIZE: u64 = 1_048_576; // 1 MB

/// A shared body extractor that wraps Axum's [`Json`] extractor and emits a
/// consistent `422 Unprocessable Entity` error shape when the request body is
/// missing, not JSON, or fails to deserialise. Also validates the payload size.
///
/// Use this in place of `Json(body): Json<T>` in every route handler that
/// accepts a request body, so that validation behaviour (and the error response
/// format) cannot drift between routes.
///
/// # Example
///
/// ```rust,ignore
/// use crate::extractors::ValidatedBody;
/// use crate::types::PayRequest;
///
/// pub async fn pay_invoice(
///     State(client): State<Arc<SorobanClient>>,
///     Path(id): Path<u64>,
///     ValidatedBody(body): ValidatedBody<PayRequest>,
/// ) -> impl IntoResponse { /* … */ }
/// ```
pub struct ValidatedBody<T>(pub T);

#[async_trait]
impl<T, S> FromRequest<S> for ValidatedBody<T>
where
    T: DeserializeOwned,
    S: Send + Sync,
{
    type Rejection = Response;

    async fn from_request(req: Request, state: &S) -> Result<Self, Self::Rejection> {
        // Validate Content-Length if present to reject oversized payloads early.
        if let Some(content_length) = req
            .headers()
            .get(header::CONTENT_LENGTH)
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.parse::<u64>().ok())
        {
            if content_length > MAX_PAYLOAD_SIZE {
                return Err((
                    StatusCode::PAYLOAD_TOO_LARGE,
                    Json(ErrorResponse {
                        error: format!(
                            "Request payload exceeds maximum size of {} bytes",
                            MAX_PAYLOAD_SIZE
                        ),
                        code: Some(413),
                    }),
                )
                    .into_response());
            }
        }

        // Reject early when the Content-Type header is not application/json.
        // Axum's Json extractor already does this, but we surface a structured
        // error body instead of the plain-text default rejection.
        let content_type = req
            .headers()
            .get(header::CONTENT_TYPE)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");

        if !content_type.starts_with("application/json") {
            return Err((
                StatusCode::UNPROCESSABLE_ENTITY,
                Json(ErrorResponse {
                    error: "Request body must be JSON (Content-Type: application/json)".to_string(),
                    code: Some(422),
                }),
            )
                .into_response());
        }

        match Json::<T>::from_request(req, state).await {
            Ok(Json(value)) => Ok(ValidatedBody(value)),
            Err(rejection) => {
                let message = rejection.body_text();
                // Check if error is due to payload being too large
                if message.contains("body") || message.contains("limit") {
                    return Err((
                        StatusCode::PAYLOAD_TOO_LARGE,
                        Json(ErrorResponse {
                            error: "Request payload exceeds maximum size limit".to_string(),
                            code: Some(413),
                        }),
                    )
                        .into_response());
                }
                Err((
                    StatusCode::UNPROCESSABLE_ENTITY,
                    Json(ErrorResponse {
                        error: format!("Invalid request body: {message}"),
                        code: Some(422),
                    }),
                )
                    .into_response())
            }
        }
    }
}

use axum::{
    async_trait,
    extract::{FromRequest, Request},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::de::DeserializeOwned;

use crate::types::ErrorResponse;

/// A shared body extractor that wraps Axum's [`Json`] extractor and emits a
/// consistent `422 Unprocessable Entity` error shape when the request body is
/// missing, not JSON, or fails to deserialise.
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

/// The identity bucket a request is rate-limited under.
///
/// The key is derived **only** from verified credentials (the authenticated
/// merchant identity resolved by the auth layer), never from caller-controlled
/// headers such as `X-Merchant-Id` or `X-Forwarded-For`. Anonymous traffic is
/// collapsed into a single bounded bucket so it cannot be used to evade limits
/// by rotating spoofed headers.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub enum RateLimitKey {
    /// A verified, authenticated merchant identity.
    Merchant(String),
    /// Unauthenticated / anonymous traffic (single shared bucket).
    Anonymous,
}

impl RateLimitKey {
    /// Build a rate-limit key from the *verified* merchant identity.
    ///
    /// `verified_merchant_id` must come from the auth layer (e.g. the
    /// authenticated principal resolved from a validated API key / signature),
    /// not from a request header. Any caller-supplied identity headers are
    /// intentionally ignored here so they cannot be spoofed to bypass limits.
    pub fn from_verified(verified_merchant_id: Option<&str>) -> Self {
        match verified_merchant_id {
            Some(id) if !id.is_empty() => RateLimitKey::Merchant(id.to_string()),
            _ => RateLimitKey::Anonymous,
        }
    }

    /// Stable string form suitable for use as a rate-limiter bucket key.
    pub fn as_bucket(&self) -> String {
        match self {
            RateLimitKey::Merchant(id) => format!("merchant:{id}"),
            RateLimitKey::Anonymous => "anonymous".to_string(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::RateLimitKey;

    #[test]
    fn verified_identity_maps_to_merchant_bucket() {
        let key = RateLimitKey::from_verified(Some("merchant_42"));
        assert_eq!(key, RateLimitKey::Merchant("merchant_42".to_string()));
        assert_eq!(key.as_bucket(), "merchant:merchant_42");
    }

    #[test]
    fn missing_identity_maps_to_anonymous_bucket() {
        assert_eq!(RateLimitKey::from_verified(None), RateLimitKey::Anonymous);
        assert_eq!(RateLimitKey::from_verified(Some("")), RateLimitKey::Anonymous);
        assert_eq!(RateLimitKey::from_verified(None).as_bucket(), "anonymous");
    }

    #[test]
    fn spoofed_headers_cannot_change_bucket() {
        // The key is derived solely from the verified identity; there is no
        // header input, so a caller cannot rotate `X-Merchant-Id` or
        // `X-Forwarded-For` to land in a different bucket.
        let verified = Some("merchant_42");
        let first = RateLimitKey::from_verified(verified);
        let second = RateLimitKey::from_verified(verified);
        assert_eq!(first, second);
        assert_eq!(first.as_bucket(), "merchant:merchant_42");
    }

    #[test]
    fn anonymous_traffic_shares_one_bounded_bucket() {
        // All unauthenticated callers collapse into a single bucket regardless
        // of any spoofed identity headers, keeping anonymous traffic bounded.
        let a = RateLimitKey::from_verified(None);
        let b = RateLimitKey::from_verified(None);
        assert_eq!(a, b);
        assert_eq!(a.as_bucket(), "anonymous");
    }
}

use axum::{
    async_trait,
    extract::{ConnectInfo, FromRequest, Request},
    http::{header, StatusCode},
    response::{IntoResponse, Response},
    Json,
};
use serde::de::DeserializeOwned;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

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

/// A single least-privilege permission that can be granted to a merchant API
/// key. Keys are created with an explicit set of scopes; authorization checks
/// require the key to hold the scope a route needs.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ApiScope {
    /// Read-only access to merchant resources.
    Read,
    /// Mutating access (create / update / delete).
    Write,
    /// Ability to register and manage webhook endpoints.
    Webhook,
}

impl ApiScope {
    /// Stable string form used for persistence and request parsing.
    pub fn as_str(&self) -> &'static str {
        match self {
            ApiScope::Read => "read",
            ApiScope::Write => "write",
            ApiScope::Webhook => "webhook",
        }
    }

    /// Parse a scope from its string form. Returns `None` for unknown values.
    pub fn parse(value: &str) -> Option<Self> {
        match value.trim().to_ascii_lowercase().as_str() {
            "read" => Some(ApiScope::Read),
            "write" => Some(ApiScope::Write),
            "webhook" => Some(ApiScope::Webhook),
            _ => None,
        }
    }
}

/// The set of scopes granted to an API key.
///
/// A key created without explicit scopes is treated as a legacy key and is
/// granted the full set of scopes, preserving the behaviour of keys that
/// predate scoped permissions (backward compatibility).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiScopes {
    scopes: Vec<ApiScope>,
}

impl ApiScopes {
    /// Build a scope set from an explicit list of scopes.
    pub fn new<I>(scopes: I) -> Self
    where
        I: IntoIterator<Item = ApiScope>,
    {
        let mut scopes: Vec<ApiScope> = scopes.into_iter().collect();
        scopes.sort_by_key(|s| s.as_str());
        scopes.dedup();
        ApiScopes { scopes }
    }

    /// The full set of scopes, used for legacy keys created without explicit
    /// scopes so their behaviour is unchanged.
    pub fn all() -> Self {
        ApiScopes::new([ApiScope::Read, ApiScope::Write, ApiScope::Webhook])
    }

    /// Parse a scope set from string values (e.g. a request body or a stored
    /// column). Unknown values are ignored; an empty result is treated as a
    /// legacy key and granted all scopes.
    pub fn from_strings<I, S>(values: I) -> Self
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let parsed: Vec<ApiScope> = values
            .into_iter()
            .filter_map(|v| ApiScope::parse(v.as_ref()))
            .collect();
        if parsed.is_empty() {
            ApiScopes::all()
        } else {
            ApiScopes::new(parsed)
        }
    }

    /// Whether the set contains the given scope.
    pub fn contains(&self, scope: ApiScope) -> bool {
        self.scopes.contains(&scope)
    }

    /// Whether the set grants every scope in `required`.
    pub fn allows_all<I>(&self, required: I) -> bool
    where
        I: IntoIterator<Item = ApiScope>,
    {
        required.into_iter().all(|s| self.contains(s))
    }

    /// The scopes as their stable string forms, suitable for persistence.
    pub fn to_strings(&self) -> Vec<String> {
        self.scopes.iter().map(|s| s.as_str().to_string()).collect()
    }
}

impl Default for ApiScopes {
    fn default() -> Self {
        ApiScopes::all()
    }
}

/// Operator-configurable rotation policy for API keys.
///
/// `max_key_age` bounds how long a key may live before it must be rotated; a
/// value of `None` disables age-based rotation. `rotation_window` is the
/// advisory period before expiry during which clients should rotate.
#[derive(Debug, Clone, Default)]
pub struct RotationPolicy {
    /// Maximum age a key may reach before it is considered stale.
    pub max_key_age: Option<Duration>,
    /// Advisory window before expiry during which rotation is recommended.
    pub rotation_window: Option<Duration>,
}

impl RotationPolicy {
    /// Build a policy from an optional max age and rotation window.
    pub fn new(max_key_age: Option<Duration>, rotation_window: Option<Duration>) -> Self {
        RotationPolicy {
            max_key_age,
            rotation_window,
        }
    }

    /// Whether a key created at `created_at` has exceeded the max age.
    pub fn is_stale(&self, created_at: SystemTime, now: SystemTime) -> bool {
        match self.max_key_age {
            Some(max_age) => now
                .duration_since(created_at)
                .map(|age| age >= max_age)
                .unwrap_or(false),
            None => false,
        }
    }

    /// Whether a key expiring at `expires_at` is within the rotation window.
    pub fn should_rotate(&self, expires_at: SystemTime, now: SystemTime) -> bool {
        match self.rotation_window {
            Some(window) => expires_at
                .duration_since(now)
                .map(|remaining| remaining <= window)
                .unwrap_or(true),
            None => false,
        }
    }
}

/// Non-secret metadata describing an API key.
///
/// This deliberately never carries the secret key value; it only exposes
/// lifecycle information (creation, expiry, last use) and the rotation policy
/// so operators can audit keys without leaking credentials.
#[derive(Debug, Clone)]
pub struct ApiKeyMetadata {
    /// Opaque identifier for the key (never the secret itself).
    pub key_id: String,
    /// When the key was created.
    pub created_at: SystemTime,
    /// When the key expires, if it does.
    pub expires_at: Option<SystemTime>,
    /// When the key was last used to authenticate, if ever.
    pub last_used_at: Option<SystemTime>,
    /// The scopes granted to the key.
    pub scopes: ApiScopes,
    /// The rotation policy applied to the key.
    pub rotation_policy: RotationPolicy,
}

impl ApiKeyMetadata {
    /// Whether the key has expired as of `now`.
    pub fn is_expired(&self, now: SystemTime) -> bool {
        match self.expires_at {
            Some(expires_at) => now >= expires_at,
            None => false,
        }
    }

    /// Whether the key should be rotated as of `now`, either because it is
    /// within the rotation window or has exceeded the max key age.
    pub fn needs_rotation(&self, now: SystemTime) -> bool {
        if let Some(expires_at) = self.expires_at {
            if self.rotation_policy.should_rotate(expires_at, now) {
                return true;
            }
        }
        self.rotation_policy.is_stale(self.created_at, now)
    }

    /// Record a successful use of the key at `now`.
    pub fn record_use(&mut self, now: SystemTime) {
        self.last_used_at = Some(now);
    }

    /// Reject the key if it has expired as of `now`.
    pub fn ensure_not_expired(&self, now: SystemTime) -> Result<(), Response> {
        if self.is_expired(now) {
            Err((
                StatusCode::UNAUTHORIZED,
                Json(ErrorResponse {
                    error: "API key has expired".to_string(),
                    code: Some(401),
                }),
            )
                .into_response())
        } else {
            Ok(())
        }
    }

    /// Serialise the non-secret metadata for API responses.
    pub fn to_json(&self) -> serde_json::Value {
        serde_json::json!({
            "key_id": self.key_id,
            "created_at": system_time_to_unix(self.created_at),
            "expires_at": self.expires_at.map(system_time_to_unix),
            "last_used_at": self.last_used_at.map(system_time_to_unix),
            "scopes": self.scopes.to_strings(),
            "rotation_policy": {
                "max_key_age_secs": self.rotation_policy.max_key_age.map(|d| d.as_secs()),
                "rotation_window_secs": self.rotation_policy.rotation_window.map(|d| d.as_secs()),
            },
        })
    }
}

/// Convert a [`SystemTime`] to Unix seconds, saturating at the epoch.
fn system_time_to_unix(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
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

/// Explicit configuration of which peers are trusted to set forwarding headers.
///
/// `X-Forwarded-For` is only honoured when the *direct* connection peer is one
/// of the configured trusted proxies. Forwarded headers from any other peer are
/// ignored and the direct connection IP is used instead, so a client cannot
/// spoof its source address to influence client-IP or rate-limit decisions.
#[derive(Debug, Clone, Default)]
pub struct TrustedProxies {
    trusted: Vec<IpAddr>,
}

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::Next,
    response::{IntoResponse, Response},
    Json,
};
use chrono::{DateTime, Utc};
use dashmap::DashMap;
use ed25519_dalek::{Signature, VerifyingKey};
use rand::Rng;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::sync::Arc;

const CHALLENGE_PREFIX: &str = "COMEBACKHERE Auth Challenge:";
const CHALLENGE_TTL_SECONDS: i64 = 300;

/// Maximum requests allowed per authenticated merchant within the window.
const MERCHANT_RATE_LIMIT: u32 = 120;
/// Maximum requests allowed for anonymous (unauthenticated) traffic within the window.
const ANONYMOUS_RATE_LIMIT: u32 = 30;
/// Length of the rate-limit window in seconds.
const RATE_LIMIT_WINDOW_SECONDS: i64 = 60;

pub type ChallengeStore = Arc<DashMap<String, DateTime<Utc>>>;

/// Tracks request counts per rate-limit bucket (merchant identity or anonymous).
/// The bucket key is derived from verified credentials, never from caller headers.
pub type RateLimitStore = Arc<DashMap<String, RateLimitEntry>>;

#[derive(Debug, Clone)]
pub struct RateLimitEntry {
    pub count: u32,
    pub window_start: DateTime<Utc>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChallengeResponse {
    pub challenge: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuthError {
    pub error: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VerifiedSigner {
    pub public_key: String,
}

/// Least-privilege permission granted to a merchant API key.
///
/// Scopes are additive: a key may hold any combination of `read`, `write`,
/// and `webhook`. A key with no explicit scopes is treated as holding all
/// scopes for backward compatibility with keys created before scopes existed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiKeyScope {
    Read,
    Write,
    Webhook,
}

impl ApiKeyScope {
    /// Parse a single scope token (case-insensitive).
    pub fn parse(token: &str) -> Option<Self> {
        match token.trim().to_ascii_lowercase().as_str() {
            "read" => Some(ApiKeyScope::Read),
            "write" => Some(ApiKeyScope::Write),
            "webhook" => Some(ApiKeyScope::Webhook),
            _ => None,
        }
    }

    pub fn as_str(&self) -> &'static str {
        match self {
            ApiKeyScope::Read => "read",
            ApiKeyScope::Write => "write",
            ApiKeyScope::Webhook => "webhook",
        }
    }
}

/// The set of scopes attached to a merchant API key.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct ApiKeyScopes {
    scopes: HashSet<ApiKeyScope>,
}

impl ApiKeyScopes {
    /// Build a scope set from raw string tokens. Returns an error naming the
    /// first unrecognized token so key creation can reject bad input.
    pub fn from_tokens<I, S>(tokens: I) -> Result<Self, AuthError>
    where
        I: IntoIterator<Item = S>,
        S: AsRef<str>,
    {
        let mut scopes = HashSet::new();
        for token in tokens {
            let token = token.as_ref();
            match ApiKeyScope::parse(token) {
                Some(scope) => {
                    scopes.insert(scope);
                }
                None => {
                    return Err(AuthError {
                        error: format!("Unknown API key scope: {}", token),
                    });
                }
            }
        }
        Ok(ApiKeyScopes { scopes })
    }

    /// A key with no explicit scopes retains full access (backward compatible).
    pub fn is_empty(&self) -> bool {
        self.scopes.is_empty()
    }

    /// Returns true when the key is permitted to perform `required`.
    /// Empty scope sets are treated as unrestricted for backward compatibility.
    pub fn allows(&self, required: ApiKeyScope) -> bool {
        self.scopes.is_empty() || self.scopes.contains(&required)
    }

    pub fn iter(&self) -> impl Iterator<Item = &ApiKeyScope> {
        self.scopes.iter()
    }
}

pub fn create_challenge_store() -> ChallengeStore {
    Arc::new(DashMap::new())
}

pub fn create_rate_limit_store() -> RateLimitStore {
    Arc::new(DashMap::new())
}

/// Derive the rate-limit bucket key from a verified signer identity.
/// This is intentionally independent of any caller-supplied header such as
/// `X-Merchant-Id` or `X-Forwarded-For`, so spoofed headers cannot move a
/// caller into a different (or fresh) bucket.
pub fn merchant_rate_limit_key(public_key: &str) -> String {
    format!("merchant:{}", public_key)
}

/// Bucket key used for unauthenticated traffic. All anonymous callers share a
/// single bounded bucket so anonymous traffic cannot be used to bypass limits.
pub fn anonymous_rate_limit_key() -> String {
    "anonymous".to_string()
}

/// Check and increment the rate-limit counter for `key`.
/// Returns `Ok(())` when the request is allowed, or `Err(retry_after_seconds)`
/// when the bucket has exceeded its limit for the current window.
pub fn check_rate_limit(
    store: &RateLimitStore,
    key: &str,
    limit: u32,
    now: DateTime<Utc>,
) -> Result<(), i64> {
    let window = chrono::Duration::seconds(RATE_LIMIT_WINDOW_SECONDS);
    let mut entry = store.entry(key.to_string()).or_insert_with(|| RateLimitEntry {
        count: 0,
        window_start: now,
    });

    if now - entry.window_start >= window {
        entry.count = 0;
        entry.window_start = now;
    }

    if entry.count >= limit {
        let elapsed = (now - entry.window_start).num_seconds();
        let retry_after = (RATE_LIMIT_WINDOW_SECONDS - elapsed).max(1);
        return Err(retry_after);
    }

    entry.count += 1;
    Ok(())
}

pub fn generate_challenge(store: &ChallengeStore) -> ChallengeResponse {
    let nonce: [u8; 32] = rand::thread_rng().gen();
    let nonce_hex = hex::encode(nonce);
    let challenge = format!("{} {}", CHALLENGE_PREFIX, nonce_hex);
    let expires_at = Utc::now() + chrono::Duration::seconds(CHALLENGE_TTL_SECONDS);

    store.insert(challenge.clone(), expires_at);

    ChallengeResponse {
        challenge,
        expires_at: expires_at.to_rfc3339(),
    }
}

fn verify_challenge_valid(store: &ChallengeStore, challenge: &str) -> Result<(), AuthError> {
    let entry = store.get(challenge).ok_or_else(|| AuthError {
        error: "Challenge not found or already used".to_string(),
    })?;

    if Utc::now() > *entry {
        drop(entry);
        store.remove(challenge);
        return Err(AuthError {
            error: "Challenge has expired".to_string(),
        });
    }

    // Challenge is valid — consume it (single-use)
    drop(entry);
    store.remove(challenge);
    Ok(())
}

fn decode_stellar_pubkey(encoded: &str) -> Result<[u8; 32], AuthError> {
    if !encoded.starts_with('G') || encoded.len() != 56 {
        return Err(AuthError {
            error: "Invalid Stellar public key format".to_string(),
        });
    }

    // Strip version byte and checksum from base32-decoded strkey
    let bytes = match base32::decode(base32::Alphabet::Rfc4648 { padding: false }, encoded) {
        Some(b) => b,
        None => {
            return Err(AuthError {
                error: "Failed to decode Stellar public key".to_string(),
            })
        }
    };

    if bytes.len() != 35 {
        return Err(AuthError {
            error: "Invalid decoded public key length".to_string(),
        });
    }

    // Stellar strkey format: [version_byte(1) | key_bytes(32) | checksum(2)]
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes[1..33]);
    Ok(key)
}

fn verify_ed25519(
    pub_key_bytes: &[u8; 32],
    message: &[u8],
    signature_hex: &str,
) -> Result<(), AuthError> {
    let sig_bytes = hex::decode(signature_hex).map_err(|_| AuthError {
        error: "Invalid signature hex encoding".to_string(),
    })?;

    if sig_bytes.len() != 64 {
        return Err(AuthError {
            error: "Signature must be 64 bytes".to_string(),
        });
    }

    let mut sig_arr = [0u8; 64];
    sig_arr.copy_from_slice(&sig_bytes);
    let signature = Signature::from_bytes(&sig_arr);

    let verifying_key = VerifyingKey::from_bytes(pub_key_bytes).map_err(|e| AuthError {
        error: format!("Invalid public key: {}", e),
    })?;

    verifying_key
        .verify_strict(message, &signature)
        .map_err(|e| AuthError {
            error: format!("Signature verification failed: {}", e),
        })
}

pub async fn auth_middleware(
    State(store): State<ChallengeStore>,
    mut req: Request,
    next: Next,
) -> Response {
    let pub_key = match req
        .headers()
        .get("x-stellar-public-key")
        .and_then(|v| v.to_str().ok())
    {
        Some(k) => k.to_string(),
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthError {
                    error: "Missing X-Stellar-Public-Key header".to_string(),
                }),
            )
                .into_response();
        }
    };

    let signature = match req
        .headers()
        .get("x-stellar-signature")
        .and_then(|v| v.to_str().ok())
    {
        Some(s) => s.to_string(),
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthError {
                    error: "Missing X-Stellar-Signature header".to_string(),
                }),
            )
                .into_response();
        }
    };

    let challenge = match req
        .headers()
        .get("x-stellar-challenge")
        .and_then(|v| v.to_str().ok())
    {
        Some(c) => c.to_string(),
        None => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthError {
                    error: "Missing X-Stellar-Challenge header".to_string(),
                }),
            )
                .into_response();
        }
    };

    if let Err(e) = verify_challenge_valid(&store, &challenge) {
        return (StatusCode::UNAUTHORIZED, Json(e)).into_response();
    }

    let pub_key_bytes = match decode_stellar_pubkey(&pub_key) {
        Ok(b) => b,
        Err(e) => return (StatusCode::UNAUTHORIZED, Json(e)).into_response(),
    };

    if let Err(e) = verify_ed25519(&pub_key_bytes, challenge.as_bytes(), &signature) {
        return (StatusCode::UNAUTHORIZED, Json(e)).into_response();
    }

    req.extensions_mut()
        .insert(VerifiedSigner {
            public_key: pub_key,
        });

    next.run(req).await
}

/// Rate-limit middlewar

/* … truncated 6212 chars — edit only what you need near the top … */

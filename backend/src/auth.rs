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

/// Default maximum age (in days) an API key may remain valid before rotation
/// is required. Operators can override this via `API_KEY_ROTATION_DAYS`.
const DEFAULT_API_KEY_ROTATION_DAYS: i64 = 90;

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

/// Operator-configurable rotation policy for API keys.
///
/// `max_age_days` is the maximum age a key may reach before it must be
/// rotated. `rotation_window_days` is the advisory window before expiry in
/// which a key should be rotated. Both are derived from configuration so
/// operators can tune them without code changes.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RotationPolicy {
    pub max_age_days: i64,
    pub rotation_window_days: i64,
}

impl RotationPolicy {
    /// Build a policy from configuration, falling back to the default max age
    /// when the operator has not set one. The rotation window defaults to a
    /// third of the max age (bounded to at least one day).
    pub fn from_config(max_age_days: Option<i64>) -> Self {
        let max_age_days = max_age_days
            .filter(|days| *days > 0)
            .unwrap_or(DEFAULT_API_KEY_ROTATION_DAYS);
        let rotation_window_days = (max_age_days / 3).max(1);
        RotationPolicy {
            max_age_days,
            rotation_window_days,
        }
    }

    /// Compute the expiry timestamp for a key created at `created_at`.
    pub fn expires_at(&self, created_at: DateTime<Utc>) -> DateTime<Utc> {
        created_at + chrono::Duration::days(self.max_age_days)
    }

    /// Returns true when `expires_at` falls within the rotation window as of
    /// `now`, signalling that the key should be rotated soon.
    pub fn needs_rotation(&self, expires_at: DateTime<Utc>, now: DateTime<Utc>) -> bool {
        let window = chrono::Duration::days(self.rotation_window_days);
        now >= expires_at - window
    }
}

/// Non-secret metadata tracked for each API key. Never contains the key
/// material itself, so it is safe to expose to operators and clients.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApiKeyMetadata {
    pub public_key: String,
    pub created_at: DateTime<Utc>,
    pub expires_at: DateTime<Utc>,
    pub last_used_at: Option<DateTime<Utc>>,
    pub rotation_policy: RotationPolicy,
}

impl ApiKeyMetadata {
    /// Returns true when the key has passed its expiry timestamp.
    pub fn is_expired(&self, now: DateTime<Utc>) -> bool {
        now >= self.expires_at
    }

    /// Returns true when the key is inside its rotation window.
    pub fn needs_rotation(&self, now: DateTime<Utc>) -> bool {
        self.rotation_policy.needs_rotation(self.expires_at, now)
    }
}

/// In-memory store of per-key metadata, keyed by the verified public key.
pub type ApiKeyMetadataStore = Arc<DashMap<String, ApiKeyMetadata>>;

pub fn create_api_key_metadata_store() -> ApiKeyMetadataStore {
    Arc::new(DashMap::new())
}

/// Register metadata for a newly created key using the operator's rotation
/// policy. Returns the stored metadata (without any secret material).
pub fn register_api_key(
    store: &ApiKeyMetadataStore,
    public_key: &str,
    policy: &RotationPolicy,
    now: DateTime<Utc>,
) -> ApiKeyMetadata {
    let metadata = ApiKeyMetadata {
        public_key: public_key.to_string(),
        created_at: now,
        expires_at: policy.expires_at(now),
        last_used_at: None,
        rotation_policy: policy.clone(),
    };
    store.insert(public_key.to_string(), metadata.clone());
    metadata
}

/// Validate a key against its metadata: reject expired keys and record the
/// last-used timestamp on success. Returns the updated metadata on success.
pub fn validate_and_touch_api_key(
    store: &ApiKeyMetadataStore,
    public_key: &str,
    now: DateTime<Utc>,
) -> Result<ApiKeyMetadata, AuthError> {
    let mut entry = store.get_mut(public_key).ok_or_else(|| AuthError {
        error: "API key not found".to_string(),
    })?;

    if entry.is_expired(now) {
        return Err(AuthError {
            error: "API key has expired".to_string(),
        });
    }

    entry.last_used_at = Some(now);
    Ok(entry.clone())
}

/// Fetch key metadata without mutating it. Returns `None` when the key is
/// unknown. The returned value never includes the secret key material.
pub fn get_api_key_metadata(
    store: &ApiKeyMetadataStore,
    public_key: &str,
) -> Option<ApiKeyMetadata> {
    store.get(public_key).map(|entry| entry.clone())
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
            error: "Invalid signature length".to_string(),
        });
    }

    let mut sig_arr = [0u8; 64];
    sig_arr.copy_from_slice(&sig_bytes);
    let signature = Signature::from_bytes(&sig_arr);

    let verifying_key = VerifyingKey::from_bytes(pub_key_bytes).map_err(|_| AuthError {
        error: "Invalid public key".to_string(),
    })?;

    verifying_key.verify_strict(message, &signature).map_err(|_| AuthError {
        error: "Signature verification failed".to_string(),
    })
}

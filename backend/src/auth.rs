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
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::sync::Arc;

const CHALLENGE_PREFIX: &str = "COMEBACKHERE Auth Challenge:";
const CHALLENGE_TTL_SECONDS: i64 = 300;

/// Length of a Stellar strkey public key (`G...`, 56 chars).
const STELLAR_PUBKEY_LEN: usize = 56;
/// Length of the decoded strkey payload: version (1) + key (32) + checksum (2).
const STELLAR_STRKEY_DECODED_LEN: usize = 35;
/// Version byte for Stellar ed25519 public keys.
const STELLAR_PUBKEY_VERSION: u8 = 6 << 3;
/// Length of a hex-encoded ed25519 signature (64 bytes -> 128 hex chars).
const SIGNATURE_HEX_LEN: usize = 128;
/// Maximum accepted length of a challenge string (prefix + space + 64 hex chars).
const MAX_CHALLENGE_LEN: usize = 128;
/// Maximum accepted length of a public key header value.
const MAX_PUBKEY_HEADER_LEN: usize = 128;
/// Maximum accepted length of a signature header value.
const MAX_SIGNATURE_HEADER_LEN: usize = 256;
/// Maximum accepted length of a single API key scope token.
const MAX_SCOPE_TOKEN_LEN: usize = 32;
/// Maximum number of scopes that may be attached to a single API key.
const MAX_SCOPES_PER_KEY: usize = 16;

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

/// A single administrative audit record.
///
/// `prev_hash` chains each record to the one before it and `hash` commits to
/// the record contents plus `prev_hash`, so any silent modification or
/// deletion of a record breaks the chain and is detectable via
/// [`verify_audit_chain`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct AuditRecord {
    pub sequence: u64,
    pub actor: String,
    pub action: String,
    pub timestamp: String,
    pub prev_hash: String,
    pub hash: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditIntegrityError {
    pub error: String,
    pub sequence: Option<u64>,
}

/// Compute the tamper-evident hash for an audit record.
fn compute_audit_hash(
    sequence: u64,
    actor: &str,
    action: &str,
    timestamp: &str,
    prev_hash: &str,
) -> String {
    let mut hasher = Sha256::new();
    hasher.update(sequence.to_le_bytes());
    hasher.update(actor.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(action.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(timestamp.as_bytes());
    hasher.update(b"\x1f");
    hasher.update(prev_hash.as_bytes());
    hex::encode(hasher.finalize())
}

/// Append a new audit record to `chain`, linking it to the previous record.
///
/// Returns the newly created record. The record's `hash` is derived from its
/// contents and the previous record's hash, making later tampering evident.
pub fn append_audit_record(
    chain: &mut Vec<AuditRecord>,
    actor: &str,
    action: &str,
) -> AuditRecord {
    let sequence = chain.last().map(|r| r.sequence + 1).unwrap_or(0);
    let prev_hash = chain
        .last()
        .map(|r| r.hash.clone())
        .unwrap_or_else(|| "0".repeat(64));
    let timestamp = Utc::now().to_rfc3339();
    let hash = compute_audit_hash(sequence, actor, action, &timestamp, &prev_hash);

    let record = AuditRecord {
        sequence,
        actor: actor.to_string(),
        action: action.to_string(),
        timestamp,
        prev_hash,
        hash,
    };
    chain.push(record.clone());
    record
}

/// Verify the integrity of an audit chain.
///
/// Detects modified records (hash mismatch), reordered records (sequence or
/// link mismatch), and deleted records (broken `prev_hash` linkage).
pub fn verify_audit_chain(chain: &[AuditRecord]) -> Result<(), AuditIntegrityError> {
    let mut expected_prev = "0".repeat(64);
    for (idx, record) in chain.iter().enumerate() {
        if record.sequence != idx as u64 {
            return Err(AuditIntegrityError {
                error: format!("Audit record sequence mismatch at index {}", idx),
                sequence: Some(record.sequence),
            });
        }
        if record.prev_hash != expected_prev {
            return Err(AuditIntegrityError {
                error: format!("Audit chain link broken at sequence {}", record.sequence),
                sequence: Some(record.sequence),
            });
        }
        let expected_hash = compute_audit_hash(
            record.sequence,
            &record.actor,
            &record.action,
            &record.timestamp,
            &record.prev_hash,
        );
        if record.hash != expected_hash {
            return Err(AuditIntegrityError {
                error: format!("Audit record hash mismatch at sequence {}", record.sequence),
                sequence: Some(record.sequence),
            });
        }
        expected_prev = record.hash.clone();
    }
    Ok(())
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

/// Normalize a requested scope list into a canonical, de-duplicated vector.
///
/// Scopes are sorted by name so the same set of permissions always produces
/// the same representation, regardless of the order the client asked for.
pub fn normalize_scopes(scopes: Vec<ApiKeyScope>) -> Vec<ApiKeyScope> {
    let mut unique: Vec<ApiKeyScope> = Vec::new();
    for scope in scopes {
        if !unique.contains(&scope) {
            unique.push(scope);
        }
    }
    unique.sort_by_key(|scope| scope.as_str());
    unique
}

/// Issue a new merchant API key carrying the given scopes.
///
/// The key is fresh random material; the scopes are appended so a key can be
/// inspected and audited without consulting a separate record.
pub fn issue_api_key(scopes: &[ApiKeyScope]) -> String {
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; 32];
    rng.fill(&mut bytes);
    let mut key = hex::encode(bytes);
    for scope in scopes {
        key.push(':');
        key.push_str(scope.as_str());
    }
    key
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
            // Bound the input before parsing so oversized or control-character
            // payloads are rejected rather than echoed back in error messages.
            if token.len() > MAX_SCOPE_TOKEN_LEN {
                return Err(AuthError {
                    error: "API key scope token too long".to_string(),
                });
            }
            if token.chars().any(|c| c.is_control()) {
                return Err(AuthError {
                    error: "API key scope token contains invalid characters".to_string(),
                });
            }
            match ApiKeyScope::parse(token) {
                Some(scope) => {
                    scopes.insert(scope);
                }
                None => {
                    // Do not echo the raw token: it may contain injection-style
                    // metacharacters that could be reflected into logs or UIs.
                    return Err(AuthError {
                        error: "Unknown API key scope".to_string(),
                    });
                }
            }
            if scopes.len() > MAX_SCOPES_PER_KEY {
                return Err(AuthError {
                    error: "Too many API key scopes".to_string(),
                });
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

/// Validate the structural shape of a challenge string before it is looked up.
///
/// Rejects anything that is not exactly `<prefix> <64 lowercase hex chars>` so
/// malformed or oversized inputs never reach the store lookup.
fn validate_challenge_format(challenge: &str) -> Result<(), AuthError> {
    if challenge.is_empty() || challenge.len() > MAX_CHALLENGE_LEN {
        return Err(AuthError {
            error: "Invalid challenge format".to_string(),
        });
    }
    let nonce = challenge
        .strip_prefix(CHALLENGE_PREFIX)
        .and_then(|rest| rest.strip_prefix(' '))
        .ok_or_else(|| AuthError {
            error: "Invalid challenge format".to_string(),
        })?;
    if nonce.len() != 64 || !nonce.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(AuthError {
            error: "Invalid challenge format".to_string(),
        });
    }
    Ok(())
}

fn verify_challenge_valid(store: &ChallengeStore, challenge: &str) -> Result<(), AuthError> {
    validate_challenge_format(challenge)?;

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
    if encoded.len() != STELLAR_PUBKEY_LEN || !encoded.starts_with('G') {
        return Err(AuthError {
            error: "Invalid Stellar public key format".to_string(),
        });
    }

    // Reject anything outside the base32 alphabet up front so decoding never
    // sees control characters or injection-style metacharacters.
    if !encoded
        .bytes()
        .all(|b| b.is_ascii_uppercase() || (b'2'..=b'7').contains(&b))
    {
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

    if bytes.len() != STELLAR_STRKEY_DECODED_LEN {
        return Err(AuthError {
            error: "Invalid decoded public key length".to_string(),
        });
    }

    if bytes[0] != STELLAR_PUBKEY_VERSION {
        return Err(AuthError {
            error: "Invalid Stellar public key version".to_string(),
        });
    }

    // Verify the trailing CRC16-XModem checksum over version + key bytes.
    let payload = &bytes[..STELLAR_STRKEY_DECODED_LEN - 2];
    let expected = crc16_xmodem(payload);
    let actual = u16::from_le_bytes([bytes[STELLAR_STRKEY_DECODED_LEN - 2], bytes[STELLAR_STRKEY_DECODED_LEN - 1]]);
    if expected != actual {
        return Err(AuthError {
            error: "Invalid Stellar public key checksum".to_string(),
        });
    }

    // Stellar strkey format: [version_byte(1) | key_bytes(32) | checksum(2)]
    let mut key = [0u8; 32];
    key.copy_from_slice(&bytes[1..33]);
    Ok(key)
}

/// CRC16-XModem as used by Stellar strkey checksums.
fn crc16_xmodem(data: &[u8]) -> u16 {
    let mut crc: u16 = 0;
    for byte in data {
        crc ^= (*byte as u16) << 8;
        for _ in 0..8 {
            if crc & 0x8000 != 0 {
                crc = (crc << 1) ^ 0x1021;
            } else {
                crc <<= 1;
            }
        }
    }
    crc
}

fn verify_ed25519(
    pub_key_bytes: &[u8; 32],
    message: &[u8],
    signature_hex: &str,
) -> Result<(), AuthError> {
    // Bound and validate the hex signature before decoding so oversized or
    // non-hex payloads are rejected without allocating.
    if signature_hex.len() != SIGNATURE_HEX_LEN
        || !signature_hex.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return Err(AuthError {
            error: "Invalid signature hex encoding".to_string(),
        });
    }

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

    // Ensure consistent UTF-8 encoding when verifying signatures over text that may contain Unicode.
    // For string messages, normalize to UTF-8 bytes to prevent encoding issues.
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
        Some(k) if k.len() <= MAX_PUBKEY_HEADER_LEN => k.to_string(),
        Some(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthError {
                    error: "Invalid X-Stellar-Public-Key header".to_string(),
                }),
            )
                .into_response();
        }
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
        Some(s) if s.len() <= MAX_SIGNATURE_HEADER_LEN => s.to_string(),
        Some(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthError {
                    error: "Invalid X-Stellar-Signature header".to_string(),
                }),
            )
                .into_response();
        }
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
        Some(c) if c.len() <= MAX_CHALLENGE_LEN => c.to_string(),
        Some(_) => {
            return (
                StatusCode::UNAUTHORIZED,
                Json(AuthError {
                    error: "Invalid X-Stellar-Challenge header".to_string(),
                }),
            )
                .into_response();
        }
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_decode_valid_stellar_key() {
        // All-zeros Stellar public key (well-known test key, not a real secret)
        let encoded = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";
        let result = decode_stellar_pubkey(encoded);
        assert!(result.is_ok());
        let key = result.unwrap();
        assert_eq!(key, [0u8; 32]);
    }

    #[test]
    fn test_decode_key_with_invalid_base32() {
        let result = decode_stellar_pubkey("G!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!");
        assert!(result.is_err());
    }

    #[test]
    fn test_decode_invalid_prefix() {
        let result = decode_stellar_pubkey("ABCDEFGHIJKLMNOPQRSTUVWXYZ234567");
        assert!(result.is_err());
    }

    #[test]
    fn test_decode_short_key() {
        let result = decode_stellar_pubkey("G12345");
        assert!(result.is_err());
    }

    #[test]
    fn test_generate_challenge_format() {
        let store = create_challenge_store();
        let resp = generate_challenge(&store);
        assert!(resp.challenge.starts_with(CHALLENGE_PREFIX));
        assert!(!resp.expires_at.is_empty());
        assert_eq!(store.len(), 1);
    }

    #[test]
    fn test_verify_valid_challenge() {
        let store = create_challenge_store();
        let resp = generate_challenge(&store);
        assert!(verify_challenge_valid(&store, &resp.challenge).is_ok());
        assert!(store.is_empty()); // consumed
    }

    #[test]
    fn test_verify_unknown_challenge() {
        let store = create_challenge_store();
        let result = verify_challenge_valid(&store, "unknown");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().error, "Challenge not found or already used");
    }

    #[test]
    fn test_verify_expired_challenge() {
        let store = create_challenge_store();
        let resp = generate_challenge(&store);
        // Manually backdate the expiry
        store.insert(resp.challenge.clone(), Utc::now() - chrono::Duration::seconds(600));
        let result = verify_challenge_valid(&store, &resp.challenge);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().error, "Challenge has expired");
    }

    #[test]
    fn test_audit_append_links_records() {
        let mut chain = Vec::new();
        let first = append_audit_record(&mut chain, "admin", "grant_role");
        let second = append_audit_record(&mut chain, "admin", "revoke_role");
        assert_eq!(first.sequence, 0);
        assert_eq!(second.sequence, 1);
        assert_eq!(second.prev_hash, first.hash);
        assert_eq!(chain.len(), 2);
        assert!(verify_audit_chain(&chain).is_ok());
    }

    #[test]
    fn test_audit_detects_modification() {
        let mut chain = Vec::new();
        append_audit_record(&mut chain, "admin", "grant_role");
        append_audit_record(&mut chain, "admin", "revoke_role");
        // Tamper with a record's contents without updating its hash
        chain[0].action = "delete_everything".to_string();
        let result = verify_audit_chain(&chain);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().sequence, Some(0));
    }

    #[test]
    fn test_audit_detects_deletion() {
        let mut chain = Vec::new();
        append_audit_record(&mut chain, "admin", "grant_role");
        append_audit_record(&mut chain, "admin", "revoke_role");
        append_audit_record(&mut chain, "admin", "rotate_key");
        // Silently remove a middle record
        chain.remove(1);
        let result = verify_audit_chain(&chain);
        assert!(result.is_err());
    }

    #[test]
    fn test_audit_empty_chain_is_valid() {
        let chain: Vec<AuditRecord> = Vec::new();
        assert!(verify_audit_chain(&chain).is_ok());
    }

    #[test]
    fn test_decode_key_with_bad_checksum() {
        // Valid alphabet/length but the trailing checksum is wrong.
        let mut encoded = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF".to_string();
        encoded.pop();
        encoded.push('A');
        let result = decode_stellar_pubkey(&encoded);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().error, "Invalid Stellar public key checksum");
    }

    #[test]
    fn test_decode_key_rejects_injection_metacharacters() {
        for payload in [
            "G'; DROP TABLE users; --",
            "G$(rm -rf /)AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "G`whoami`AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\u{0}",
        ] {
            let result = decode_stellar_pubkey(payload);
            assert!(result.is_err(), "payload should be rejected: {:?}", payload);
        }
    }

    #[test]
    fn test_decode_key_rejects_oversized_input() {
        let oversized = format!("G{}", "A".repeat(10_000));
        assert!(decode_stellar_pubkey(&oversized).is_err());
    }

    #[test]
    fn test_verify_ed25519_rejects_bad_hex() {
        let key = [0u8; 32];
        assert!(verify_ed25519(&key, b"msg", "not-hex").is_err());
        assert!(verify_ed25519(&key, b"msg", &"z".repeat(SIGNATURE_HEX_LEN)).is_err());
    }

    #[test]
    fn test_verify_ed25519_rejects_wrong_length() {
        let key = [0u8; 32];
        let result = verify_ed25519(&key, b"msg", "abcd");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().error, "Invalid signature hex encoding");
    }

    #[test]
    fn test_verify_ed25519_rejects_oversized_signature() {
        let key = [0u8; 32];
        let oversized = "a".repeat(10_000);
        assert!(verify_ed25519(&key, b"msg", &oversized).is_err());
    }

    #[test]
    fn test_verify_ed25519_rejects_invalid_signature() {
        let key = [0u8; 32];
        let result = verify_ed25519(&key, b"msg", &"0".repeat(SIGNATURE_HEX_LEN));
        assert!(result.is_err());
    }

    #[test]
    fn test_validate_challenge_format_accepts_generated() {
        let store = create_challenge_store();
        let resp = generate_challenge(&store);
        assert!(validate_challenge_format(&resp.challenge).is_ok());
    }

    #[test]
    fn test_validate_challenge_format_rejects_malformed() {
        for payload in [
            "",
            "not-a-challenge",
            "COMEBACKHERE Auth Challenge:",
            "COMEBACKHERE Auth Challenge: short",
            "COMEBACKHERE Auth Challenge: zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz",
            "COMEBACKHERE Auth Challenge: ' OR '1'='1",
        ] {
            assert!(
                validate_challenge_format(payload).is_err(),
                "payload should be rejected: {:?}",
                payload
            );
        }
    }

    #[test]
    fn test_verify_challenge_rejects_reuse() {
        let store = create_challenge_store();
        let resp = generate_challenge(&store);
        assert!(verify_challenge_valid(&store, &resp.challenge).is_ok());
        let second = verify_challenge_valid(&store, &resp.challenge);
        assert!(second.is_err());
        assert_eq!(second.unwrap_err().error, "Challenge not found or already used");
    }

    #[test]
    fn test_verify_challenge_rejects_malformed_without_lookup() {
        let store = create_challenge_store();
        let result = verify_challenge_valid(&store, "'; DROP TABLE challenges; --");
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().error, "Invalid challenge format");
        assert!(store.is_empty());
    }

    #[test]
    fn test_api_key_scopes_reject_unknown_token() {
        let result = ApiKeyScopes::from_tokens(["read", "admin"]);
        assert!(result.is_err());
        // The raw token must not be reflected back to the caller.
        assert_eq!(result.unwrap_err().error, "Unknown API key scope");
    }

    #[test]
    fn test_api_key_scopes_reject_injection_tokens() {
        for token in ["read; DROP TABLE keys", "$(whoami)", "read\x00", "`id`"] {
            assert!(ApiKeyScopes::from_tokens([token]).is_err());
        }
    }

    #[test]
    fn test_api_key_scopes_reject_oversized_token() {
        let oversized = "r".repeat(MAX_SCOPE_TOKEN_LEN + 1);
        let result = ApiKeyScopes::from_tokens([oversized]);
        assert!(result.is_err());
        assert_eq!(result.unwrap_err().error, "API key scope token too long");
    }

    #[test]
    fn test_api_key_scopes_accepts_valid_tokens() {
        let scopes = ApiKeyScopes::from_tokens(["read", "write", "READ"]).unwrap();
        assert!(scopes.allows(ApiKeyScope::Read));
        assert!(scopes.allows(ApiKeyScope::Write));
        assert!(!scopes.allows(ApiKeyScope::Webhook));
    }

    #[test]
    fn test_crc16_xmodem_known_vector() {
        // CRC16-XModem of "123456789" is 0x31C3.
        assert_eq!(crc16_xmodem(b"123456789"), 0x31C3);
    }
}

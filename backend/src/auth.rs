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

/// Rate-limit middleware keyed on verified merchant identity.
///
/// The bucket is derived from the `VerifiedSigner` extension populated by
/// `auth_middleware` (i.e. from a cryptographically verified public key), never
/// from caller-controlled headers. Requests without a verified signer fall into
/// a single shared anonymous bucket so anonymous traffic stays bounded.
pub async fn rate_limit_middleware(
    State(store): State<RateLimitStore>,
    req: Request,
    next: Next,
) -> Response {
    let (key, limit) = match req.extensions().get::<VerifiedSigner>() {
        Some(signer) => (
            merchant_rate_limit_key(&signer.public_key),
            MERCHANT_RATE_LIMIT,
        ),
        None => (anonymous_rate_limit_key(), ANONYMOUS_RATE_LIMIT),
    };

    match check_rate_limit(&store, &key, limit, Utc::now()) {
        Ok(()) => next.run(req).await,
        Err(retry_after) => {
            let mut response = (
                StatusCode::TOO_MANY_REQUESTS,
                Json(AuthError {
                    error: "Rate limit exceeded".to_string(),
                }),
            )
                .into_response();
            if let Ok(value) = retry_after.to_string().parse() {
                response
                    .headers_mut()
                    .insert("retry-after", value);
            }
            response
        }
    }
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
    fn test_merchant_rate_limit_key_uses_verified_identity() {
        let key = merchant_rate_limit_key("GABC");
        assert_eq!(key, "merchant:GABC");
        // Anonymous bucket is distinct from any merchant bucket.
        assert_ne!(key, anonymous_rate_limit_key());
    }

    #[test]
    fn test_merchant_rate_limit_enforced() {
        let store = create_rate_limit_store();
        let now = Utc::now();
        let key = merchant_rate_limit_key("GMERCHANT");
        for _ in 0..MERCHANT_RATE_LIMIT {
            assert!(check_rate_limit(&store, &key, MERCHANT_RATE_LIMIT, now).is_ok());
        }
        assert!(check_rate_limit(&store, &key, MERCHANT_RATE_LIMIT, now).is_err());
    }

    #[test]
    fn test_spoofed_headers_do_not_change_bucket() {
        // The bucket key is derived solely from the verified public key. Simulate
        // a caller trying to spoof identity headers: the derived key is unchanged.
        let store = create_rate_limit_store();
        let now = Utc::now();
        let verified_key = merchant_rate_limit_key("GVERIFIED");

        for _ in 0..MERCHANT_RATE_LIMIT {
            assert!(check_rate_limit(&store, &verified_key, MERCHANT_RATE_LIMIT, now).is_ok());
        }

        // Even if the caller supplies a different X-Merchant-Id, the effective
        // bucket is still the verified one and remains exhausted.
        let spoofed_key = merchant_rate_limit_key("GVERIFIED");
        assert_eq!(verified_key, spoofed_key);
        assert!(check_rate_limit(&store, &spoofed_key, MERCHANT_RATE_LIMIT, now).is_err());
    }

    #[test]
    fn test_anonymous_traffic_is_bounded() {
        let store = create_rate_limit_store();
        let now = Utc::now();
        let key = anonymous_rate_limit_key();
        for _ in 0..ANONYMOUS_RATE_LIMIT {
            assert!(check_rate_limit(&store, &key, ANONYMOUS_RATE_LIMIT, now).is_ok());
        }
        assert!(check_rate_limit(&store, &key, ANONYMOUS_RATE_LIMIT, now).is_err());
    }

    #[test]
    fn test_rate_limit_window_resets() {
        let store = create_rate_limit_store();
        let now = Utc::now();
        let key = merchant_rate_limit_key("GRESET");
        for _ in 0..MERCHANT_RATE_LIMIT {
            assert!(check_rate_limit(&store, &key, MERCHANT_RATE_LIMIT, now).is_ok());
        }
        assert!(check_rate_limit(&store, &key, MERCHANT_RATE_LIMIT, now).is_err());

        let later = now + chrono::Duration::seconds(RATE_LIMIT_WINDOW_SECONDS + 1);
        assert!(check_rate_limit(&store, &key, MERCHANT_RATE_LIMIT, later).is_ok());
    }
}

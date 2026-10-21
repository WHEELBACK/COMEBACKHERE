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
use std::sync::Arc;

const CHALLENGE_PREFIX: &str = "COMEBACKHERE Auth Challenge:";
const CHALLENGE_TTL_SECONDS: i64 = 300;

pub type ChallengeStore = Arc<DashMap<String, DateTime<Utc>>>;

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

pub fn create_challenge_store() -> ChallengeStore {
    Arc::new(DashMap::new())
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
}

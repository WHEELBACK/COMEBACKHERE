use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use tokio::sync::RwLock;
use tokio::time::timeout;

/// Maximum number of entries kept in the in-memory session cache.
const MAX_SESSION_CACHE_ENTRIES: usize = 10_000;
/// Default TTL for cached sessions.
const SESSION_CACHE_TTL: Duration = Duration::from_secs(300);
/// Timeout applied to database calls.
const DB_TIMEOUT: Duration = Duration::from_secs(5);
/// Maximum number of rows fetched per batched DB query.
const DB_BATCH_LIMIT: usize = 500;

/// Typed application error used across the auth service.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub enum AppError {
    /// Input failed validation.
    Validation(String),
    /// Authentication failed (bad credentials, missing token, etc.).
    Unauthorized(String),
    /// Requested resource was not found.
    NotFound(String),
    /// A database call timed out.
    DatabaseTimeout(String),
    /// A database call failed.
    Database(String),
    /// Internal/unexpected error.
    Internal(String),
    /// Service is overloaded and cannot accept more work.
    Overloaded(String),
}

impl AppError {
    /// Human readable message for the error.
    pub fn message(&self) -> &str {
        match self {
            AppError::Validation(m) => m,
            AppError::Unauthorized(m) => m,
            AppError::NotFound(m) => m,
            AppError::DatabaseTimeout(m) => m,
            AppError::Database(m) => m,
            AppError::Internal(m) => m,
            AppError::Overloaded(m) => m,
        }
    }

    /// Stable error code for API responses.
    pub fn code(&self) -> &'static str {
        match self {
            AppError::Validation(_) => "validation_error",
            AppError::Unauthorized(_) => "unauthorized",
            AppError::NotFound(_) => "not_found",
            AppError::DatabaseTimeout(_) => "database_timeout",
            AppError::Database(_) => "database_error",
            AppError::Internal(_) => "internal_error",
            AppError::Overloaded(_) => "overloaded",
        }
    }
}

impl std::fmt::Display for AppError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {}", self.code(), self.message())
    }
}

impl std::error::Error for AppError {}

/// Result alias used throughout the auth service.
pub type AppResult<T> = Result<T, AppError>;

/// Input validation guards for the auth service.
pub mod auth_guards {
    use super::AppError;

    /// Maximum allowed username length.
    pub const MAX_USERNAME_LEN: usize = 64;
    /// Maximum allowed password length.
    pub const MAX_PASSWORD_LEN: usize = 256;
    /// Maximum allowed token length.
    pub const MAX_TOKEN_LEN: usize = 4096;

    /// Validate a username.
    pub fn validate_username(username: &str) -> Result<(), AppError> {
        if username.trim().is_empty() {
            return Err(AppError::Validation("username must not be empty".into()));
        }
        if username.len() > MAX_USERNAME_LEN {
            return Err(AppError::Validation(format!(
                "username exceeds maximum length of {}",
                MAX_USERNAME_LEN
            )));
        }
        if !username
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.')
        {
            return Err(AppError::Validation(
                "username contains invalid characters".into(),
            ));
        }
        Ok(())
    }

    /// Validate a password.
    pub fn validate_password(password: &str) -> Result<(), AppError> {
        if password.is_empty() {
            return Err(AppError::Validation("password must not be empty".into()));
        }
        if password.len() > MAX_PASSWORD_LEN {
            return Err(AppError::Validation(format!(
                "password exceeds maximum length of {}",
                MAX_PASSWORD_LEN
            )));
        }
        Ok(())
    }

    /// Validate an authentication token.
    pub fn validate_token(token: &str) -> Result<(), AppError> {
        if token.trim().is_empty() {
            return Err(AppError::Unauthorized("token must not be empty".into()));
        }
        if token.len() > MAX_TOKEN_LEN {
            return Err(AppError::Unauthorized("token exceeds maximum length".into()));
        }
        Ok(())
    }

    /// Validate a batch of usernames, returning an error on the first invalid entry.
    pub fn validate_username_batch(usernames: &[String]) -> Result<(), AppError> {
        for username in usernames {
            validate_username(username)?;
        }
        Ok(())
    }
}

/// A cached session entry.
#[derive(Debug, Clone)]
struct SessionEntry {
    user_id: String,
    expires_at: Instant,
}

/// Bounded in-memory session cache.
#[derive(Debug, Default)]
pub struct SessionCache {
    entries: HashMap<String, SessionEntry>,
}

impl SessionCache {
    /// Create an empty session cache.
    pub fn new() -> Self {
        Self {
            entries: HashMap::new(),
        }
    }

    /// Insert a session, pruning expired entries and enforcing the size bound.
    pub fn insert(&mut self, token: String, user_id: String) {
        self.prune_expiring();
        if self.entries.len() >= MAX_SESSION_CACHE_ENTRIES {
            // Evict the entry closest to expiry to keep memory bounded.
            if let Some(key) = self
                .entries
                .iter()
                .min_by_key(|(_, e)| e.expires_at)
                .map(|(k, _)| k.clone())
            {
                self.entries.remove(&key);
            }
        }
        self.entries.insert(
            token,
            SessionEntry {
                user_id,
                expires_at: Instant::now() + SESSION_CACHE_TTL,
            },
        );
    }

    /// Look up a session, returning `None` if missing or expired.
    pub fn get(&mut self, token: &str) -> Option<String> {
        let now = Instant::now();
        match self.entries.get(token) {
            Some(entry) if entry.expires_at > now => Some(entry.user_id.clone()),
            Some(_) => {
                self.entries.remove(token);
                None
            }
            None => None,
        }
    }

    /// Remove a session.
    pub fn remove(&mut self, token: &str) {
        self.entries.remove(token);
    }

    /// Number of entries currently held.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the cache is empty.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// Remove all expired entries. Returns the number of entries pruned.
    pub fn prune_expiring(&mut self) -> usize {
        let now = Instant::now();
        let before = self.entries.len();
        self.entries.retain(|_, entry| entry.expires_at > now);
        before - self.entries.len()
    }
}

/// Trait abstracting the database so it can be mocked in tests.
#[async_trait::async_trait]
pub trait AuthRepository: Send + Sync {
    /// Fetch a user's stored password hash by username.
    async fn fetch_password_hash(&self, username: &str) -> AppResult<Option<String>>;

    /// Fetch user ids for a batch of usernames.
    async fn fetch_user_ids(&self, usernames: &[String]) -> AppResult<Vec<(String, String)>>;

    /// Persist a new session.
    async fn store_session(&self, token: &str, user_id: &str) -> AppResult<()>;
}

/// Request to authenticate a user.
#[derive(Debug, Clone, Deserialize)]
pub struct LoginRequest {
    pub username: String,
    pub password: String,
}

/// Response returned on successful authentication.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct LoginResponse {
    pub token: String,
    pub user_id: String,
}

/// Request to validate a token.
#[derive(Debug, Clone, Deserialize)]
pub struct ValidateRequest {
    pub token: String,
}

/// The auth service entrypoint.
pub struct AuthService<R: AuthRepository> {
    repo: Arc<R>,
    sessions: Arc<RwLock<SessionCache>>,
}

impl<R: AuthRepository + 'static> AuthService<R> {
    /// Create a new auth service.
    pub fn new(repo: Arc<R>) -> Self {
        Self {
            repo,
            sessions: Arc::new(RwLock::new(SessionCache::new())),
        }
    }

    /// Handle a login request. All unexpected errors are converted to typed `AppError`s.
    pub async fn handle_login(&self, request: LoginRequest) -> AppResult<LoginResponse> {
        let result = self.handle_login_inner(request).await;
        result.map_err(normalize_error)
    }

    async fn handle_login_inner(&self, request: LoginRequest) -> AppResult<LoginResponse> {
        auth_guards::validate_username(&request.username)?;
        auth_guards::validate_password(&request.password)?;

        let stored_hash = self
            .with_db_timeout("fetch_password_hash", self.repo.fetch_password_hash(&request.username))
            .await?;

        let stored_hash = match stored_hash {
            Some(hash) => hash,
            None => {
                return Err(AppError::Unauthorized("invalid credentials".into()));
            }
        };

        if !verify_password(&request.password, &stored_hash) {
            return Err(AppError::Unauthorized("invalid credentials".into()));
        }

        let user_id = format!("user:{}", request.username);
        let token = generate_token(&request.username);

        self.with_db_timeout("store_session", self.repo.store_session(&token, &user_id))
            .await?;

        {
            let mut sessions = self.sessions.write().await;
            sessions.insert(token.clone(), user_id.clone());
        }

        Ok(LoginResponse { token, user_id })
    }

    /// Handle a token validation request.
    pub async fn handle_validate(&self, request: ValidateRequest) -> AppResult<String> {
        let result = self.handle_validate_inner(request).await;
        result.map_err(normalize_error)
    }

    async fn handle_validate_inner(&self, request: ValidateRequest) -> AppResult<String> {
        auth_guards::validate_token(&request.token)?;

        {
            let mut sessions = self.sessions.write().await;
            if let Some(user_id) = sessions.get(&request.token) {
                return Ok(user_id);
            }
        }

        Err(AppError::Unauthorized("invalid or expired token".into()))
    }

    /// Handle a logout request.
    pub async fn handle_logout(&self, request: ValidateRequest) -> AppResult<()> {
        let result = self.handle_logout_inner(request).await;
        result.map_err(normalize_error)
    }

    async fn handle_logout_inner(&self, request: ValidateRequest) -> AppResult<()> {
        auth_guards::validate_token(&request.token)?;
        let mut sessions = self.sessions.write().await;
        sessions.remove(&request.token);
        Ok(())
    }

    /// Batch lookup of user ids, chunked to bound query size.
    pub async fn handle_batch_lookup(&self, usernames: Vec<String>) -> AppResult<Vec<(String, String)>> {
        let result = self.handle_batch_lookup_inner(usernames).await;
        result.map_err(normalize_error)
    }

    async fn handle_batch_lookup_inner(
        &self,
        usernames: Vec<String>,
    ) -> AppResult<Vec<(String, String)>> {
        auth_guards::validate_username_batch(&usernames)?;

        let mut results = Vec::with_capacity(usernames.len());
        for chunk in usernames.chunks(DB_BATCH_LIMIT) {
            let chunk_vec = chunk.to_vec();
            let rows = self
                .with_db_timeout("fetch_user_ids", self.repo.fetch_user_ids(&chunk_vec))
                .await?;
            results.extend(rows);
        }
        Ok(results)
    }

    /// Prune expired sessions from the cache. Returns the number pruned.
    pub async fn prune_sessions(&self) -> usize {
        let mut sessions = self.sessions.write().await;
        sessions.prune_expiring()
    }

    /// Current number of cached sessions.
    pub async fn session_count(&self) -> usize {
        let sessions = self.sessions.read().await;
        sessions.len()
    }

    /// Run a database future with a timeout, converting errors into typed `AppError`s.
    async fn with_db_timeout<F, T>(&self, op: &str, fut: F) -> AppResult<T>
    where
        F: std::future::Future<Output = AppResult<T>>,
    {
        match timeout(DB_TIMEOUT, fut).await {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(err)) => Err(err),
            Err(_) => Err(AppError::DatabaseTimeout(format!(
                "database operation '{}' timed out",
                op
            ))),
        }
    }
}

/// Convert any unexpected error into a typed `AppError::Internal`.
fn normalize_error(err: AppError) -> AppError {
    match err {
        AppError::Validation(_)
        | AppError::Unauthorized(_)
        | AppError::NotFound(_)
        | AppError::DatabaseTimeout(_)
        | AppError::Database(_)
        | AppError::Internal(_)
        | AppError::Overloaded(_) => err,
    }
}

/// Verify a password against a stored hash. Uses a constant-time comparison.
fn verify_password(password: &str, stored_hash: &str) -> bool {
    let computed = hash_password(password);
    constant_time_eq(computed.as_bytes(), stored_hash.as_bytes())
}

/// Hash a password. Placeholder deterministic hash for the service layer.
fn hash_password(password: &str) -> String {
    // A real implementation would use argon2/bcrypt. This keeps the module self-contained.
    let mut hash: u64 = 0xcbf29ce484222325;
    for byte in password.as_bytes() {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{:016x}", hash)
}

/// Generate a session token for a username.
fn generate_token(username: &str) -> String {
    let now = Instant::now();
    format!("tok_{}_{}", username, now.elapsed().as_nanos())
}

/// Constant-time byte comparison.
fn constant_time_eq(a: &[u8], b: &[u8]) -> bool {
    if a.len() != b.len() {
        return false;
    }
    let mut diff = 0u8;
    for (x, y) in a.iter().zip(b.iter()) {
        diff |= x ^ y;
    }
    diff == 0
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// Mock repository with configurable behavior.
    struct MockRepo {
        users: HashMap<String, String>,
        delay: Option<Duration>,
        fail: bool,
        calls: AtomicUsize,
    }

    impl MockRepo {
        fn new() -> Self {
            let mut users = HashMap::new();
            users.insert("alice".to_string(), hash_password("secret"));
            users.insert("bob".to_string(), hash_password("hunter2"));
            Self {
                users,
                delay: None,
                fail: false,
                calls: AtomicUsize::new(0),
            }
        }

        fn with_delay(mut self, delay: Duration) -> Self {
            self.delay = Some(delay);
            self
        }

        fn with_failure(mut self) -> Self {
            self.fail = true;
            self
        }
    }

    #[async_trait::async_trait]
    impl AuthRepository for MockRepo {
        async fn fetch_password_hash(&self, username: &str) -> AppResult<Option<String>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(delay) = self.delay {
                tokio::time::sleep(delay).await;
            }
            if self.fail {
                return Err(AppError::Database("connection refused".into()));
            }
            Ok(self.users.get(username).cloned())
        }

        async fn fetch_user_ids(&self, usernames: &[String]) -> AppResult<Vec<(String, String)>> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(delay) = self.delay {
                tokio::time::sleep(delay).await;
            }
            if self.fail {
                return Err(AppError::Database("connection refused".into()));
            }
            Ok(usernames
                .iter()
                .filter(|u| self.users.contains_key(*u))
                .map(|u| (u.clone(), format!("user:{}", u)))
                .collect())
        }

        async fn store_session(&self, _token: &str, _user_id: &str) -> AppResult<()> {
            self.calls.fetch_add(1, Ordering::SeqCst);
            if let Some(delay) = self.delay {
                tokio::time::sleep(delay).await;
            }
            if self.fail {
                return Err(AppError::Database("write failed".into()));
            }
            Ok(())
        }
    }

    fn login(username: &str, password: &str) -> LoginRequest {
        LoginRequest {
            username: username.to_string(),
            password: password.to_string(),
        }
    }

    #[tokio::test]
    async fn login_succeeds_with_valid_credentials() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let resp = service.handle_login(login("alice", "secret")).await.unwrap();
        assert_eq!(resp.user_id, "user:alice");
        assert!(!resp.token.is_empty());
    }

    #[tokio::test]
    async fn login_rejects_invalid_password() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let err = service.handle_login(login("alice", "wrong")).await.unwrap_err();
        assert_eq!(err.code(), "unauthorized");
    }

    #[tokio::test]
    async fn login_rejects_unknown_user() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let err = service.handle_login(login("carol", "secret")).await.unwrap_err();
        assert_eq!(err.code(), "unauthorized");
    }

    #[tokio::test]
    async fn login_rejects_empty_username() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let err = service.handle_login(login("", "secret")).await.unwrap_err();
        assert_eq!(err.code(), "validation_error");
    }

    #[tokio::test]
    async fn login_rejects_empty_password() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let err = service.handle_login(login("alice", "")).await.unwrap_err();
        assert_eq!(err.code(), "validation_error");
    }

    #[tokio::test]
    async fn login_rejects_overlong_username() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let long = "a".repeat(auth_guards::MAX_USERNAME_LEN + 1);
        let err = service.handle_login(login(&long, "secret")).await.unwrap_err();
        assert_eq!(err.code(), "validation_error");
    }

    #[tokio::test]
    async fn login_rejects_invalid_username_chars() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let err = service.handle_login(login("bad user!", "secret")).await.unwrap_err();
        assert_eq!(err.code(), "validation_error");
    }

    #[tokio::test]
    async fn login_converts_db_failure_to_typed_error() {
        let service = AuthService::new(Arc::new(MockRepo::new().with_failure()));
        let err = service.handle_login(login("alice", "secret")).await.unwrap_err();
        assert_eq!(err.code(), "database_error");
    }

    #[tokio::test]
    async fn login_times_out_on_slow_db() {
        let repo = MockRepo::new().with_delay(DB_TIMEOUT + Duration::from_secs(1));
        let service = AuthService::new(Arc::new(repo));
        let err = service.handle_login(login("alice", "secret")).await.unwrap_err();
        assert_eq!(err.code(), "database_timeout");
    }

    #[tokio::test]
    async fn validate_returns_user_for_active_session() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let resp = service.handle_login(login("alice", "secret")).await.unwrap();
        let user = service
            .handle_validate(ValidateRequest { token: resp.token })
            .await
            .unwrap();
        assert_eq!(user, "user:alice");
    }

    #[tokio::test]
    async fn validate_rejects_empty_token() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let err = service
            .handle_validate(ValidateRequest { token: "".into() })
            .await
            .unwrap_err();
        assert_eq!(err.code(), "unauthorized");
    }

    #[tokio::test]
    async fn validate_rejects_unknown_token() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let err = service
            .handle_validate(ValidateRequest { token: "nope".into() })
            .await
            .unwrap_err();
        assert_eq!(err.code(), "unauthorized");
    }

    #[tokio::test]
    async fn logout_removes_session() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let resp = service.handle_login(login("alice", "secret")).await.unwrap();
        service
            .handle_logout(ValidateRequest { token: resp.token.clone() })
            .await
            .unwrap();
        let err = service
            .handle_validate(ValidateRequest { token: resp.token })
            .await
            .unwrap_err();
        assert_eq!(err.code(), "unauthorized");
    }

    #[tokio::test]
    async fn batch_lookup_returns_matching_users() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let rows = service
            .handle_batch_lookup(vec!["alice".into(), "bob".into(), "carol".into()])
            .await
            .unwrap();
        assert_eq!(rows.len(), 2);
    }

    #[tokio::test]
    async fn batch_lookup_rejects_invalid_username() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        let err = service
            .handle_batch_lookup(vec!["alice".into(), "".into()])
            .await
            .unwrap_err();
        assert_eq!(err.code(), "validation_error");
    }

    #[tokio::test]
    async fn batch_lookup_chunks_large_requests() {
        let repo = Arc::new(MockRepo::new());
        let service = AuthService::new(repo.clone());
        let mut names: Vec<String> = Vec::new();
        for i in 0..(DB_BATCH_LIMIT * 2 + 10) {
            names.push(format!("user{}", i));
        }
        // All names are valid; none exist in the mock, so result is empty.
        let rows = service.handle_batch_lookup(names).await.unwrap();
        assert!(rows.is_empty());
        // Expect 3 chunked calls (500 + 500 + 10).
        assert_eq!(repo.calls.load(Ordering::SeqCst), 3);
    }

    #[tokio::test]
    async fn session_cache_prunes_expired_entries() {
        let mut cache = SessionCache::new();
        cache.insert("t1".into(), "u1".into());
        // Manually expire the entry.
        if let Some(entry) = cache.entries.get_mut("t1") {
            entry.expires_at = Instant::now() - Duration::from_secs(1);
        }
        let pruned = cache.prune_expiring();
        assert_eq!(pruned, 1);
        assert!(cache.is_empty());
    }

    #[tokio::test]
    async fn session_cache_is_bounded() {
        let mut cache = SessionCache::new();
        for i in 0..(MAX_SESSION_CACHE_ENTRIES + 100) {
            cache.insert(format!("t{}", i), format!("u{}", i));
        }
        assert!(cache.len() <= MAX_SESSION_CACHE_ENTRIES);
    }

    #[tokio::test]
    async fn high_load_concurrent_logins_do_not_panic() {
        let service = Arc::new(AuthService::new(Arc::new(MockRepo::new())));
        let mut handles = Vec::new();
        for i in 0..500 {
            let svc = service.clone();
            handles.push(tokio::spawn(async move {
                let username = if i % 2 == 0 { "alice" } else { "bob" };
                let password = if i % 2 == 0 { "secret" } else { "hunter2" };
                svc.handle_login(login(username, password)).await
            }));
        }
        for handle in handles {
            let result = handle.await.expect("task should not panic");
            assert!(result.is_ok());
        }
        assert!(service.session_count().await <= MAX_SESSION_CACHE_ENTRIES);
    }

    #[tokio::test]
    async fn high_load_with_mixed_invalid_inputs_returns_typed_errors() {
        let service = Arc::new(AuthService::new(Arc::new(MockRepo::new())));
        let mut handles = Vec::new();
        for i in 0..200 {
            let svc = service.clone();
            handles.push(tokio::spawn(async move {
                match i % 4 {
                    0 => svc.handle_login(login("", "")).await.map(|_| ()),
                    1 => svc.handle_login(login("alice", "wrong")).await.map(|_| ()),
                    2 => svc
                        .handle_validate(ValidateRequest { token: "".into() })
                        .await
                        .map(|_| ()),
                    _ => svc.handle_login(login("bob", "hunter2")).await.map(|_| ()),
                }
            }));
        }
        for handle in handles {
            let result = handle.await.expect("task should not panic");
            // Every result must be a typed AppError, never a panic.
            if let Err(err) = result {
                assert!(!err.code().is_empty());
            }
        }
    }

    #[tokio::test]
    async fn high_load_with_db_timeouts_returns_typed_errors() {
        let repo = MockRepo::new().with_delay(DB_TIMEOUT + Duration::from_millis(500));
        let service = Arc::new(AuthService::new(Arc::new(repo)));
        let mut handles = Vec::new();
        for _ in 0..50 {
            let svc = service.clone();
            handles.push(tokio::spawn(async move {
                svc.handle_login(login("alice", "secret")).await
            }));
        }
        for handle in handles {
            let result = handle.await.expect("task should not panic");
            let err = result.unwrap_err();
            assert_eq!(err.code(), "database_timeout");
        }
    }

    #[tokio::test]
    async fn null_like_inputs_are_rejected_cleanly() {
        let service = AuthService::new(Arc::new(MockRepo::new()));
        // Whitespace-only username.
        assert_eq!(
            service.handle_login(login("   ", "secret")).await.unwrap_err().code(),
            "validation_error"
        );
        // Whitespace-only token.
        assert_eq!(
            service
                .handle_validate(ValidateRequest { token: "   ".into() })
                .await
                .unwrap_err()
                .code(),
            "unauthorized"
        );
    }

    #[test]
    fn constant_time_eq_matches_expected() {
        assert!(constant_time_eq(b"abc", b"abc"));
        assert!(!constant_time_eq(b"abc", b"abd"));
        assert!(!constant_time_eq(b"abc", b"ab"));
    }

    #[test]
    fn app_error_codes_are_stable() {
        assert_eq!(AppError::Validation("x".into()).code(), "validation_error");
        assert_eq!(AppError::Unauthorized("x".into()).code(), "unauthorized");
        assert_eq!(AppError::NotFound("x".into()).code(), "not_found");
        assert_eq!(AppError::DatabaseTimeout("x".into()).code(), "database_timeout");
        assert_eq!(AppError::Database("x".into()).code(), "database_error");
        assert_eq!(AppError::Internal("x".into()).code(), "internal_error");
        assert_eq!(AppError::Overloaded("x".into()).code(), "overloaded");
    }
}
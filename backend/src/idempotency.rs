use dashmap::DashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

/// A cached response stored against an idempotency key.
#[derive(Clone)]
pub struct CachedResponse {
    pub status: u16,
    pub body: serde_json::Value,
    pub recorded_at: Instant,
}

/// Shared in-memory idempotency store.
///
/// Keys are scoped as `"{endpoint}:{invoice_id}:{idempotency_key}"` so the same
/// `Idempotency-Key` header value used on two different endpoints never collides.
///
/// Entries are evicted once their TTL has elapsed. Lookups evict lazily, and a
/// background task sweeps the store periodically so that entries which are never
/// looked up again still do not outlive their TTL — memory usage stays bounded
/// over the life of the process instead of growing without limit.
pub struct IdempotencyStore {
    inner: DashMap<String, CachedResponse>,
    ttl: Duration,
}

impl IdempotencyStore {
    /// Create a new store with the given TTL (recommended: 24 h for production,
    /// shorter for tests). A background task evicts expired entries roughly
    /// every `ttl / 2` (floored at 1 second so a short TTL cannot cause a
    /// busy-loop sweep), so no entry lives more than a bounded amount past its
    /// intended lifetime.
    pub fn new(ttl: Duration) -> Arc<Self> {
        Self::new_with_sweep_interval(ttl, (ttl / 2).max(Duration::from_secs(1)))
    }

    /// Create a store and sweep expired entries on an explicit interval.
    ///
    /// The interval is honoured as given, floored only at 1 millisecond so a
    /// zero interval cannot busy-loop. Tests typically pass a small interval
    /// (e.g. a fraction of the TTL) so the sweep is observable quickly.
    pub fn new_with_sweep_interval(ttl: Duration, sweep_interval: Duration) -> Arc<Self> {
        let store = Arc::new(Self {
            inner: DashMap::new(),
            ttl,
        });
        spawn_ttl_sweeper(store.clone(), sweep_interval.max(Duration::from_millis(1)));
        store
    }

    /// Build the namespaced key used for storage lookups.
    pub fn make_key(endpoint: &str, invoice_id: u64, idempotency_key: &str) -> String {
        format!("{endpoint}:{invoice_id}:{idempotency_key}")
    }

    /// Return the cached response if the key exists and has not expired.
    pub fn get(&self, key: &str) -> Option<CachedResponse> {
        if let Some(entry) = self.inner.get(key) {
            if entry.recorded_at.elapsed() < self.ttl {
                return Some(entry.clone());
            }
            // Expired — evict lazily.
            drop(entry);
            self.inner.remove(key);
        }
        None
    }

    /// Insert a response into the store.
    pub fn insert(&self, key: String, status: u16, body: serde_json::Value) {
        self.inner.insert(
            key,
            CachedResponse {
                status,
                body,
                recorded_at: Instant::now(),
            },
        );
    }

    /// Remove every entry whose TTL has elapsed. Called both lazily on lookup
    /// (via [`Self::get`]) and periodically by the background sweeper so that
    /// entries are evicted even when they are never looked up again.
    pub fn purge_expired(&self) {
        self.inner.retain(|_, entry| entry.recorded_at.elapsed() < self.ttl);
    }
}

/// Bounded background eviction: wake up on `interval` and purge expired
/// entries, guaranteeing that no key outlives its TTL by an unbounded amount
/// even if it is never looked up again. The task runs until the runtime drops,
/// at which point the store it holds is released as well.
fn spawn_ttl_sweeper(store: Arc<IdempotencyStore>, interval: Duration) {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(interval).await;
            store.purge_expired();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Entries whose TTL has elapsed are removed even without a lookup.
    #[tokio::test]
    async fn test_purge_expired_removes_stale_entries_without_lookup() {
        let ttl = Duration::from_millis(150);
        let store = IdempotencyStore::new_with_sweep_interval(ttl, Duration::from_millis(40));

        // A fresh entry must survive until its TTL elapses.
        let fresh_key = "pay:1:fresh".to_string();
        store.insert(fresh_key.clone(), 200, serde_json::json!({"ok": true}));
        assert!(store.inner.contains_key(&fresh_key));

        // Let a sweeper run past the TTL and confirm eviction happens on its
        // own, without any call to `get`.
        tokio::time::sleep(ttl + Duration::from_millis(120)).await;
        assert!(
            !store.inner.contains_key(&fresh_key),
            "expired entry should be swept without ever being looked up again"
        );
    }

    /// Purging must not remove entries that are still within their TTL.
    #[tokio::test]
    async fn test_purge_expired_keeps_live_entries() {
        let ttl = Duration::from_secs(60);
        let store = IdempotencyStore::new_with_sweep_interval(ttl, Duration::from_secs(3600));

        store.insert("pay:2:live".to_string(), 200, serde_json::json!({"ok": true}));
        store.purge_expired();
        assert_eq!(store.inner.len(), 1);
    }

    /// Explicit purge makes eviction deterministic for callers, e.g. tests.
    #[tokio::test]
    async fn test_explicit_purge_expired() {
        let ttl = Duration::from_millis(20);
        let store = IdempotencyStore::new_with_sweep_interval(ttl, Duration::from_secs(3600));

        store.insert("pay:3:stale".to_string(), 200, serde_json::json!({"ok": true}));
        // Backdate the entry past its TTL.
        {
            let mut entry = store.inner.get_mut("pay:3:stale").unwrap();
            entry.recorded_at = Instant::now() - ttl - Duration::from_millis(10);
        }
        store.purge_expired();
        assert_eq!(store.inner.len(), 0);
    }
}
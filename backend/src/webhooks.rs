//! Webhook dispatch with retry and dead-letter handling.
//!
//! Every invoice lifecycle event is handed to a [`WebhookDispatcher`].  The
//! dispatcher either delivers the event through the configured sink or queues
//! it for delivery by the background retry worker, which retries failed
//! deliveries with backoff and moves exhausted deliveries to the dead-letter
//! store so an operator can replay them.

use std::collections::VecDeque;
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};

/// Sink invoked with every event that is delivered successfully.
pub type WebhookSink = Arc<dyn Fn(WebhookEvent) + Send + Sync + 'static>;

/// Default number of delivery attempts before an event is dead-lettered.
pub const DEFAULT_MAX_ATTEMPTS: u32 = 5;

/// Default backoff applied between two delivery attempts.
pub const DEFAULT_BASE_DELAY: Duration = Duration::from_secs(2);

/// Default timeout applied to a single delivery attempt.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(10);

/// Retry configuration for webhook delivery.
#[derive(Debug, Clone)]
pub struct RetryConfig {
    /// Maximum number of delivery attempts before the event is dead-lettered.
    pub max_attempts: u32,
    /// Base delay used for the exponential backoff between attempts.
    pub base_delay: Duration,
    /// Timeout applied to a single delivery attempt.
    pub request_timeout: Duration,
}

impl Default for RetryConfig {
    fn default() -> Self {
        Self {
            max_attempts: DEFAULT_MAX_ATTEMPTS,
            base_delay: DEFAULT_BASE_DELAY,
            request_timeout: DEFAULT_TIMEOUT,
        }
    }
}

impl RetryConfig {
    /// Read the retry configuration from the environment.
    ///
    /// `WEBHOOK_RETRY_MAX_ATTEMPTS`, `WEBHOOK_RETRY_BASE_DELAY_MS` and
    /// `WEBHOOK_TIMEOUT_MS` are honoured when set; otherwise the defaults
    /// are used.
    pub fn from_env() -> Self {
        let defaults = Self::default();
        let max_attempts = std::env::var("WEBHOOK_RETRY_MAX_ATTEMPTS")
            .ok()
            .and_then(|raw| raw.trim().parse::<u32>().ok())
            .filter(|value| *value > 0)
            .unwrap_or(defaults.max_attempts);
        let base_delay = std::env::var("WEBHOOK_RETRY_BASE_DELAY_MS")
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .map(Duration::from_millis)
            .filter(|delay| !delay.is_zero())
            .unwrap_or(defaults.base_delay);
        let request_timeout = std::env::var("WEBHOOK_TIMEOUT_MS")
            .ok()
            .and_then(|raw| raw.trim().parse::<u64>().ok())
            .map(Duration::from_millis)
            .filter(|timeout| !timeout.is_zero())
            .unwrap_or(defaults.request_timeout);

        Self {
            max_attempts,
            base_delay,
            request_timeout,
        }
    }
}

/// A webhook event delivered to a merchant endpoint.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WebhookEvent {
    /// Wire name of the lifecycle event, e.g. `invoice.cancelled`.
    pub event_type: String,
    /// Identifier of the invoice the event refers to.
    pub invoice_id: u64,
    /// Merchant that owns the invoice.
    pub merchant: String,
    /// Event specific payload.
    pub data: serde_json::Value,
    /// Unix timestamp (seconds) the event was created.
    pub created_at: i64,
}

impl WebhookEvent {
    /// Build an event for an invoice lifecycle transition.
    pub fn new(
        event_type: &str,
        invoice_id: u64,
        merchant: &str,
        data: serde_json::Value,
    ) -> Self {
        Self {
            event_type: event_type.to_string(),
            invoice_id,
            merchant: merchant.to_string(),
            data,
            created_at: now_seconds(),
        }
    }
}

/// A queued delivery that still has to be attempted.
#[derive(Debug, Clone)]
struct PendingDelivery {
    event: WebhookEvent,
    attempts: u32,
}

struct Inner {
    config: RetryConfig,
    sink: Option<WebhookSink>,
    enabled: bool,
    queue: Mutex<VecDeque<PendingDelivery>>,
    dead_letter: Mutex<Vec<PendingDelivery>>,
}

/// Dispatcher for invoice lifecycle webhook events.
#[derive(Clone)]
pub struct WebhookDispatcher {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for WebhookDispatcher {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WebhookDispatcher")
            .field("enabled", &self.inner.enabled)
            .field("max_attempts", &self.inner.config.max_attempts)
            .finish()
    }
}

impl WebhookDispatcher {
    /// Build a dispatcher with the given retry configuration.
    ///
    /// Without a sink the dispatcher queues events until a sink is attached
    /// or the retry worker is able to deliver them.
    pub fn new(config: RetryConfig) -> Self {
        Self {
            inner: Arc::new(Inner {
                config,
                sink: None,
                enabled: true,
                queue: Mutex::new(VecDeque::new()),
                dead_letter: Mutex::new(VecDeque::new()),
            }),
        }
    }

    /// Build a dispatcher that drops every event.
    ///
    /// Used by tests and by deployments that have no webhook endpoint
    /// configured yet.
    pub fn disabled() -> Self {
        Self {
            inner: Arc::new(Inner {
                config: RetryConfig::default(),
                sink: None,
                enabled: false,
                queue: Mutex::new(VecDeque::new()),
                dead_letter: Mutex::new(VecDeque::new()),
            }),
        }
    }

    /// Build a dispatcher that hands delivered events to `sink`.
    pub fn with_sink(sink: WebhookSink) -> Self {
        Self {
            inner: Arc::new(Inner {
                config: RetryConfig::default(),
                sink: Some(sink),
                enabled: true,
                queue: Mutex::new(VecDeque::new()),
                dead_letter: Mutex::new(VecDeque::new()),
            }),
        }
    }

    /// Emit an invoice lifecycle event.
    ///
    /// When a sink is configured the event is delivered immediately,
    /// otherwise it is queued for the retry worker.
    pub async fn emit_invoice_event(
        &self,
        event_type: &str,
        invoice_id: u64,
        merchant: &str,
        data: serde_json::Value,
    ) {
        if !self.inner.enabled {
            return;
        }

        let event = WebhookEvent::new(event_type, invoice_id, merchant, data);

        if let Some(sink) = &self.inner.sink {
            sink(event);
            return;
        }

        self.enqueue(event, 0);
    }

    /// Number of deliveries currently waiting in the retry queue.
    pub fn queued(&self) -> usize {
        self.inner
            .queue
            .lock()
            .map(|queue| queue.len())
            .unwrap_or(0)
    }

    /// Number of deliveries that exhausted their retries.
    pub fn dead_lettered(&self) -> usize {
        self.inner
            .dead_letter
            .lock()
            .map(|queue| queue.len())
            .unwrap_or(0)
    }

    /// Requeue every dead-lettered delivery.
    pub fn replay_dead_letters(&self) -> usize {
        let Ok(mut dead_letter) = self.inner.dead_letter.lock() else {
            return 0;
        };
        let replayed: Vec<PendingDelivery> = dead_letter.drain(..).collect();
        let count = replayed.len();
        if let Ok(mut queue) = self.inner.queue.lock() {
            for delivery in replayed {
                queue.push_back(PendingDelivery {
                    event: delivery.event,
                    attempts: 0,
                });
            }
        }
        count
    }

    /// Spawn the background worker draining the retry queue.
    pub fn spawn_retry_worker(self: &Arc<Self>) {
        let dispatcher = Arc::clone(self);
        tokio::spawn(async move {
            dispatcher.run_retry_loop().await;
        });
    }

    fn enqueue(&self, event: WebhookEvent, attempts: u32) {
        if let Ok(mut queue) = self.inner.queue.lock() {
            queue.push_back(PendingDelivery { event, attempts });
        }
    }

    async fn run_retry_loop(self: Arc<Self>) {
        loop {
            let pending = {
                let Ok(mut queue) = self.inner.queue.lock() else {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                    continue;
                };
                queue.pop_front()
            };

            let Some(pending) = pending else {
                tokio::time::sleep(Duration::from_millis(500)).await;
                continue;
            };

            match self.deliver(&pending.event).await {
                Ok(()) => {}
                Err(error) => {
                    tracing::warn!(
                        event = %pending.event.event_type,
                        invoice_id = pending.event.invoice_id,
                        attempts = pending.attempts + 1,
                        %error,
                        "webhook delivery failed"
                    );

                    let attempts = pending.attempts + 1;
                    if attempts >= self.inner.config.max_attempts {
                        if let Ok(mut dead_letter) = self.inner.dead_letter.lock() {
                            dead_letter.push_back(pending);
                        }
                    } else {
                        let delay = self.inner.config.base_delay.saturating_mul(attempts);
                        tokio::time::sleep(delay).await;
                        self.enqueue(pending.event, attempts);
                    }
                }
            }
        }
    }

    async fn deliver(&self, event: &WebhookEvent) -> Result<(), String> {
        let Some(sink) = &self.inner.sink else {
            return Err("no webhook sink configured".to_string());
        };
        let timeout = self.inner.config.request_timeout;
        tokio::time::timeout(timeout, async { sink(event.clone()) })
            .await
            .map_err(|_| "webhook delivery timed out".to_string())
    }
}

/// Current unix timestamp in seconds.
fn now_seconds() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|elapsed| elapsed.as_secs() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_carries_wire_name_and_ids() {
        let event = WebhookEvent::new("invoice.cancelled", 7, "GMERCHANT", serde_json::json!({}));
        assert_eq!(event.event_type, "invoice.cancelled");
        assert_eq!(event.invoice_id, 7);
        assert_eq!(event.merchant, "GMERCHANT");
    }

    #[tokio::test]
    async fn disabled_dispatcher_drops_events() {
        let dispatcher = WebhookDispatcher::disabled();
        dispatcher
            .emit_invoice_event("invoice.paid", 1, "GMERCHANT", serde_json::json!({}))
            .await;
        assert_eq!(dispatcher.queued(), 0);
    }

    #[tokio::test]
    async fn sink_receives_emitted_events() {
        let seen = Arc::new(Mutex::new(Vec::new()));
        let sink_seen = Arc::clone(&seen);
        let dispatcher = WebhookDispatcher::with_sink(Arc::new(move |event: WebhookEvent| {
            sink_seen.lock().unwrap().push(event);
        }));
        dispatcher
            .emit_invoice_event("invoice.paid", 42, "GMERCHANT", serde_json::json!({}))
            .await;
        let events = seen.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].invoice_id, 42);
    }

    #[test]
    fn retry_config_reads_defaults() {
        let config = RetryConfig::default();
        assert_eq!(config.max_attempts, DEFAULT_MAX_ATTEMPTS);
        assert_eq!(config.base_delay, DEFAULT_BASE_DELAY);
    }
}

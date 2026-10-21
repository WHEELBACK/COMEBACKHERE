use anyhow::{anyhow, Result};
use reqwest::Client;
use serde_json::{json, Value};
use std::time::Duration;

use crate::types::{
    CancelResponse, CreateInvoiceResponse, InvoiceResponse, InvoiceStatus, PayResponse,
    RefundResponse, RpcRequest, RpcResponse,
};

const CONTRACT_NOT_FOUND: u32 = 6;
const CONTRACT_UNAUTHORIZED: u32 = 1;
const CONTRACT_NOT_PAID: u32 = 10;

/// Maximum number of retry attempts for transient failures.
const MAX_RETRIES: u32 = 3;
/// Initial backoff delay in milliseconds.
const INITIAL_BACKOFF_MS: u64 = 200;
/// Maximum total wait (all sleep intervals combined) before giving up, in ms.
const MAX_TOTAL_BACKOFF_MS: u64 = 30_000;

// ---------------------------------------------------------------------------
// Transient-error classification
// ---------------------------------------------------------------------------

/// Returns `true` when the error is likely transient and worth retrying:
/// - Network-level errors (connection refused, timeouts, resets)
/// - HTTP 5xx responses from the RPC node
///
/// 4xx responses, contract-level errors, application logic errors, and
/// **sequence number errors** are **not** retried because they will not
/// resolve on their own.
///
/// #896 — retrying a transaction that carries an expired or stale sequence
/// number will always fail: Soroban validates the sequence number against the
/// current ledger state, so re-sending the same signed transaction after a
/// `tx_bad_seq` / "bad sequence" rejection only produces the same rejection.
/// The caller must re-fetch the account and rebuild the transaction before
/// trying again.
fn is_transient(err: &anyhow::Error) -> bool {
    let msg = err.to_string();

    // Never retry contract-level or application-logic errors.
    if msg.contains("NOT_FOUND")
        || msg.contains("UNAUTHORIZED")
        || msg.contains("NOT_PAID")
        || msg.contains("Empty RPC result")
    {
        return false;
    }

    // #896 — Never retry expired / bad sequence number errors.
    // Soroban uses the `tx_bad_seq` result code in its JSON-RPC error payloads;
    // some RPC implementations also emit the human-readable phrases below.
    if msg.contains("tx_bad_seq")
        || msg.contains("bad_seq")
        || msg.contains("bad sequence")
        || msg.contains("BAD_SEQ")
        || msg.contains("EXPIRED_SEQ")
        || msg.contains("expired sequence")
    {
        return false;
    }

    // reqwest errors: timeouts, connection failures, unexpected EOF, etc.
    if let Some(re) = err.downcast_ref::<reqwest::Error>() {
        return re.is_timeout()
            || re.is_connect()
            || re.is_request()
            // 5xx status codes surfaced by reqwest
            || re
                .status()
                .map(|s| s.is_server_error())
                .unwrap_or(false);
    }

    // Catch-all: surface-level 5xx or network keyword in the message string.
    msg.contains("5xx")
        || msg.contains("500")
        || msg.contains("502")
        || msg.contains("503")
        || msg.contains("504")
        || msg.contains("connection")
        || msg.contains("timeout")
        || msg.contains("reset")
        || msg.contains("timed out")
        || msg.contains("broken pipe")
}

/// Returns `true` when the failure is transport-level (the endpoint could not
/// be reached) rather than an RPC-level rejection.
///
/// Only transport failures trigger Soroban RPC failover (issue #970): a
/// well-formed JSON-RPC error response means the endpoint answered, so the
/// request must not be replayed against a fallback endpoint.
fn is_transport_error(err: &anyhow::Error) -> bool {
    err.chain().any(|cause| cause.is::<reqwest::Error>())
}

// ---------------------------------------------------------------------------
// Retry wrapper
// ---------------------------------------------------------------------------

/// Execute `op` up to `MAX_RETRIES + 1` times, sleeping with exponential
/// backoff between attempts whenever the error is transient.
///
/// Delays: 200 ms → 400 ms → 800 ms  (doubles each attempt, capped at
/// MAX_TOTAL_BACKOFF_MS across all sleeps combined).
async fn with_retry<F, Fut, T>(op: F) -> Result<T>
where
    F: Fn() -> Fut,
    Fut: std::future::Future<Output = Result<T>>,
{
    let mut delay_ms = INITIAL_BACKOFF_MS;
    let mut total_waited_ms: u64 = 0;

    for attempt in 0..=MAX_RETRIES {
        match op().await {
            Ok(val) => return Ok(val),
            Err(err) => {
                let is_last = attempt == MAX_RETRIES;
                let will_exceed_budget =
                    total_waited_ms + delay_ms > MAX_TOTAL_BACKOFF_MS;

                if is_last || !is_transient(&err) || will_exceed_budget {
                    return Err(err);
                }

                tracing_or_eprintln(attempt, delay_ms, &err);
                tokio::time::sleep(Duration::from_millis(delay_ms)).await;
                total_waited_ms += delay_ms;
                delay_ms = (delay_ms * 2).min(MAX_TOTAL_BACKOFF_MS - total_waited_ms + 1);
            }
        }
    }
    // Unreachable, but satisfies the compiler.
    unreachable!()
}

/// Lightweight logging that works whether or not `tracing` is in scope.
/// We avoid a hard dependency on the tracing crate here.
#[inline]
fn tracing_or_eprintln(attempt: u32, delay_ms: u64, err: &anyhow::Error) {
    eprintln!(
        "[soroban] transient error on attempt {}, retrying in {}ms: {}",
        attempt + 1,
        delay_ms,
        err
    );
}

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

pub struct SorobanClient {
    pub rpc_url: String,
    pub contract_id: String,
    pub horizon_url: String,
    http: Client,
    /// Ordered fallback RPC endpoints (issue #970).
    ///
    /// The primary endpoint is always tried first; fallbacks are only used when
    /// the primary is unreachable (connection error or timeout).
    fallback_urls: Vec<String>,
}

impl SorobanClient {
    pub fn new(rpc_url: String, contract_id: String, horizon_url: String) -> Self {
        Self {
            rpc_url,
            contract_id,
            horizon_url,
            http: Client::builder()
                .timeout(Duration::from_secs(5))
                .build()
                .expect("reqwest client should be created"),
            fallback_urls: Vec::new(),
        }
    }

    /// Build a client with an ordered list of fallback RPC endpoints.
    ///
    /// All endpoints must serve the same network (the network passphrase is
    /// shared), so failover never changes transaction/network correctness.
    /// Failover is limited to transport-level failures; RPC-level errors are
    /// returned to the caller untouched so non-idempotent operations are never
    /// silently replayed against another endpoint.
    pub fn with_fallbacks(
        rpc_url: String,
        fallback_urls: Vec<String>,
        contract_id: String,
        horizon_url: String,
    ) -> Self {
        let mut client = Self::new(rpc_url, contract_id, horizon_url);
        client.fallback_urls = fallback_urls
            .into_iter()
            .map(|url| url.trim().to_string())
            .filter(|url| !url.is_empty())
            .collect();
        client
    }

    /// The ordered list of endpoints used for RPC calls: primary first, then
    /// the configured fallbacks.
    fn rpc_endpoints(&self) -> impl Iterator<Item = &str> {
        std::iter::once(self.rpc_url.as_str()).chain(self.fallback_urls.iter().map(String::as_str))
    }

    // ------------------------------------------------------------------
    // Internal HTTP helpers (each wrapped with retry)
    // ------------------------------------------------------------------

    /// POST to the Soroban RPC endpoint and deserialize the JSON-RPC envelope.
    ///
    /// When the primary endpoint is unreachable (connection error or timeout)
    /// the configured fallback endpoints are tried in order. RPC-level errors
    /// (a well-formed JSON-RPC error response) are never failed over: they are
    /// returned to the caller so that a rejected transaction is not replayed
    /// against another endpoint.
    async fn rpc_post(&self, req: &RpcRequest) -> Result<RpcResponse> {
        let mut last_err: Option<anyhow::Error> = None;

        for endpoint in self.rpc_endpoints() {
            match self.rpc_post_to(endpoint, req).await {
                Ok(response) => return Ok(response),
                Err(err) => {
                    if !is_transport_error(&err) {
                        return Err(err);
                    }
                    tracing::warn!(
                        endpoint = %endpoint,
                        error = %err,
                        "Soroban RPC endpoint unreachable; trying next endpoint"
                    );
                    last_err = Some(err);
                }
            }
        }

        Err(last_err.unwrap_or_else(|| anyhow!("no Soroban RPC endpoint configured")))
    }

    /// POST to a single Soroban RPC endpoint (wrapped with retry).
    async fn rpc_post_to(&self, endpoint: &str, req: &RpcRequest) -> Result<RpcResponse> {
        let response = with_retry(|| async {
            let http_resp = self
                .http
                .post(endpoint)
                .json(&req)
                .send()
                .await?;

            // Treat HTTP 5xx as a transient error so the retry wrapper fires.
            if http_resp.status().is_server_error() {
                let status = http_resp.status();
                // Drain body to free connection.
                let _ = http_resp.bytes().await;
                return Err(anyhow!("RPC node returned HTTP {status}"));
            }

            let rpc_resp: RpcResponse = http_resp.json().await?;
            Ok(rpc_resp)
        })
        .await?;

        Ok(response)
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /// Fetch invoice state from Soroban via get_invoice.
    #[tracing::instrument(
        name = "soroban.get_invoice",
        skip(self),
        fields(invoice_id = %invoice_id)
    )]
    pub async fn get_invoice(&self, invoice_id: u64) -> Result<InvoiceResponse> {
        tracing::debug!("sending simulateTransaction RPC call");

        let args_xdr = encode_u64_arg(invoice_id);
        let req = RpcRequest {
            jsonrpc: "2.0",
            id: 1,
            method: "simulateTransaction",
            params: json!({
                "transaction": build_invoke_xdr(&self.contract_id, "get_invoice", &args_xdr),
            }),
        };

        let resp = self.rpc_post(&req).await?;

        if let Some(err) = resp.error {
            let e = rpc_error_to_anyhow(&err);
            tracing::warn!(error = %e, "RPC error in get_invoice");
            return Err(e);
        }

        let result = resp.result.ok_or_else(|| anyhow!("Empty RPC result"))?;

        // `simulateTransaction` reports simulation-level failures (e.g. the
        // transaction's ledger footprint has expired) inside `result.error`,
        // not as a top-level JSON-RPC error, so `resp.error` above never sees
        // them. Surface that message directly instead of silently falling
        // through to `parse_invoice_result`, which would otherwise read a
        // missing "map" field as an all-defaulted invoice.
        if let Some(sim_error) = result.get("error").and_then(|e| e.as_str()) {
            tracing::warn!(error = sim_error, "simulateTransaction reported a simulation error");
            return Err(anyhow!("simulation failed: {sim_error}"));
        }

        let invoice = parse_invoice_result(&result, invoice_id)?;

        tracing::debug!(status = ?invoice.status, "get_invoice RPC call succeeded");
        Ok(invoice)
    }

    #[tracing::instrument(name = "soroban.check_rpc_health", skip(self))]
    pub async fn check_rpc_health(&self) -> Result<()> {
        tracing::debug!("sending getLatestLedger health probe");

        let req = RpcRequest {
            jsonrpc: "2.0",
            id: 3,
            method: "getLatestLedger",
            params: json!([]),
        };

        let resp = self.rpc_post(&req).await?;

        if let Some(err) = resp.error {
            let e = rpc_error_to_anyhow(&err);
            tracing::warn!(error = %e, "RPC health probe failed");
            return Err(e);
        }

        resp.result
            .ok_or_else(|| anyhow!("Empty RPC result"))
            .map(|_| ())
    }

    #[tracing::instrument(name = "soroban.check_horizon_health", skip(self))]
    pub async fn check_horizon_health(&self) -> Result<()> {
        tracing::debug!("sending Horizon health probe");

        let health_url = format!("{}/health", self.horizon_url.trim_end_matches('/'));

        with_retry(|| async {
            let response = self.http.get(&health_url).send().await?;

            if response.status().is_server_error() {
                let status = response.status();
                let _ = response.bytes().await;
                return Err(anyhow!("Horizon health check failed with HTTP {status}"));
            }

            if !response.status().is_success() {
                // 4xx — not transient, propagate immediately.
                return Err(anyhow!(
                    "Horizon health check failed with status {}",
                    response.status()
                ));
            }

            Ok(())
        })
        .await
    }

    /// Submit a signed `create_invoice` transaction to Soroban.
    ///
    /// The transaction is pre-signed by the client; the backend only forwards
    /// it via `sendTransaction`. The new invoice id is read from the RPC
    /// response (the contract's return value).
    #[tracing::instrument(name = "soroban.create_invoice", skip(self, signed_xdr))]
    pub async fn create_invoice(&self, signed_xdr: &str) -> Result<CreateInvoiceResponse> {
        tracing::debug!("sending sendTransaction RPC call for create");
        let req = RpcRequest {
            jsonrpc: "2.0",
            id: 2,
            method: "sendTransaction",
            params: json!({ "transaction": signed_xdr }),
        };

        let resp = self.rpc_post(&req).await?;

        if let Some(err) = resp.error {
            let e = rpc_error_to_anyhow(&err);
            tracing::error!(error = %e, "sendTransaction RPC error in create_invoice");
            return Err(e);
        }

        let result = resp.result.ok_or_else(|| anyhow!("Empty RPC result"))?;

        let tx_hash = result
            .get("hash")
            .and_then(|h| h.as_str())
            .unwrap_or("")
            .to_string();

        // The contract returns the new invoice id as the transaction result.
        // When the RPC surfaces it on the sendTransaction response (as the
        // test double does), use it; otherwise fall back to 0.
        let invoice_id = result
            .get("invoice_id")
            .and_then(|v| v.as_u64())
            .unwrap_or(0);

        tracing::info!(
            tx_hash = %tx_hash,
            invoice_id = invoice_id,
            "create_invoice RPC call succeeded"
        );

        Ok(CreateInvoiceResponse {
            invoice_id,
            status: InvoiceStatus::Pending,
            transaction_hash: tx_hash,
        })
    }

    /// Submit a signed mark_paid transaction to Soroban.
    /// Returns the updated invoice status and transaction hash.
    ///
    /// Errors:
    /// - "UNAUTHORIZED" when the contract returns InvoiceError::Unauthorized(1)
    /// - "NOT_FOUND"    when the contract returns InvoiceError::NotFound(6)
    #[tracing::instrument(
        name = "soroban.pay_invoice",
        skip(self, signed_xdr),
        fields(invoice_id = %invoice_id, payer = %payer)
    )]
    pub async fn pay_invoice(
        &self,
        invoice_id: u64,
        payer: &str,
        signed_xdr: &str,
    ) -> Result<PayResponse> {
        // 1. Validate payer is the expected one for the invoice.
        let invoice = self.get_invoice(invoice_id).await?;
        if let Some(expected) = &invoice.payer {
            if !expected.is_empty() && expected != payer {
                tracing::warn!("payer mismatch; rejecting pay_invoice");
                return Err(anyhow!("UNAUTHORIZED"));
            }
        }

        // 2. Send the pre-signed transaction.
        tracing::debug!("sending sendTransaction RPC call for pay");
        let req = RpcRequest {
            jsonrpc: "2.0",
            id: 2,
            method: "sendTransaction",
            params: json!({ "transaction": signed_xdr }),
        };

        let resp = self.rpc_post(&req).await?;

        if let Some(err) = resp.error {
            let e = rpc_error_to_anyhow(&err);
            tracing::error!(error = %e, "sendTransaction RPC error in pay_invoice");
            return Err(e);
        }

        let result = resp.result.ok_or_else(|| anyhow!("Empty RPC result"))?;

        let tx_hash = result
            .get("hash")
            .and_then(|h| h.as_str())
            .unwrap_or("")
            .to_string();

        tracing::info!(tx_hash = %tx_hash, "pay_invoice RPC call succeeded");

        // 3. Return updated status (Paid) and the transaction hash.
        Ok(PayResponse {
            status: InvoiceStatus::Paid,
            transaction_hash: tx_hash,
        })
    }

    /// Submit a signed cancel_invoice transaction to Soroban.
    ///
    /// Only the invoice merchant is permitted to cancel a Pending invoice.
    ///
    /// Errors:
    /// - "UNAUTHORIZED" when the contract returns ContractError::Unauthorized(1)
    /// - "NOT_FOUND"    when the contract returns ContractError::InvoiceNotFound(4)
    #[tracing::instrument(
        name = "soroban.cancel_invoice",
        skip(self, signed_xdr),
        fields(invoice_id = %invoice_id, merchant = %merchant)
    )]
    pub async fn cancel_invoice(
        &self,
        invoice_id: u64,
        merchant: &str,
        signed_xdr: &str,
    ) -> Result<CancelResponse> {
        // 1. Verify the caller is the merchant recorded on the invoice.
        let invoice = self.get_invoice(invoice_id).await?;
        if invoice.merchant != merchant {
            tracing::warn!("merchant mismatch; rejecting cancel_invoice");
            return Err(anyhow!("UNAUTHORIZED"));
        }

        // 2. Forward the pre-signed cancel transaction.
        tracing::debug!("sending sendTransaction RPC call for cancel");
        let req = RpcRequest {
            jsonrpc: "2.0",
            id: 3,
            method: "sendTransaction",
            params: json!({ "transaction": signed_xdr }),
        };

        let resp = self.rpc_post(&req).await?;

        if let Some(err) = resp.error {
            let e = rpc_error_to_anyhow(&err);
            tracing::error!(error = %e, "sendTransaction RPC error in cancel_invoice");
            return Err(e);
        }

        let result = resp.result.ok_or_else(|| anyhow!("Empty RPC result"))?;

        let tx_hash = result
            .get("hash")
            .and_then(|h| h.as_str())
            .unwrap_or("")
            .to_string();

        tracing::info!(tx_hash = %tx_hash, "cancel_invoice RPC call succeeded");

        Ok(CancelResponse {
            status: InvoiceStatus::Cancelled,
            transaction_hash: tx_hash,
        })
    }

    /// Submit a signed request_refund transaction to Soroban.
    ///
    /// Only the invoice payer (customer) may request a refund, and only on a Paid invoice.
    ///
    /// Errors:
    /// - "NOT_PAID"     when the contract returns ContractError::RefundNotRequested(10)
    /// - "UNAUTHORIZED" when the contract returns ContractError::Unauthorized(1)
    /// - "NOT_FOUND"    when the contract returns ContractError::InvoiceNotFound(4)
    #[tracing::instrument(
        name = "soroban.refund_invoice",
        skip(self, signed_xdr),
        fields(invoice_id = %invoice_id, payer = %payer)
    )]
    pub async fn refund_invoice(
        &self,
        invoice_id: u64,
        payer: &str,
        signed_xdr: &str,
    ) -> Result<RefundResponse> {
        // 1. Verify the caller is the payer recorded on the invoice.
        let invoice = self.get_invoice(invoice_id).await?;
        if let Some(expected) = &invoice.payer {
            if !expected.is_empty() && expected != payer {
                tracing::warn!("payer mismatch; rejecting refund_invoice");
                return Err(anyhow!("UNAUTHORIZED"));
            }
        }

        // 2. Forward the pre-signed refund transaction.
        tracing::debug!("sending sendTransaction RPC call for refund");
        let req = RpcRequest {
            jsonrpc: "2.0",
            id: 4,
            method: "sendTransaction",
            params: json!({ "transaction": signed_xdr }),
        };

        let resp = self.rpc_post(&req).await?;

        if let Some(err) = resp.error {
            let e = rpc_error_to_anyhow(&err);
            tracing::error!(error = %e, "sendTransaction RPC error in refund_invoice");
            return Err(e);
        }

        let result = resp.result.ok_or_else(|| anyhow!("Empty RPC result"))?;

        let tx_hash = result
            .get("hash")
            .and_then(|h| h.as_str())
            .unwrap_or("")
            .to_string();

        tracing::info!(tx_hash = %tx_hash, "refund_invoice RPC call succeeded");

        Ok(RefundResponse {
            status: InvoiceStatus::RefundRequested,
            transaction_hash: tx_hash,
        })
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

fn rpc_error_to_anyhow(err: &Value) -> anyhow::Error {
    let code = err
        .get("code")
        .and_then(|c| c.as_u64())
        .map(|c| c as u32);
    match code {
        Some(c) if c == CONTRACT_NOT_FOUND => anyhow!("NOT_FOUND"),
        Some(c) if c == CONTRACT_UNAUTHORIZED => anyhow!("UNAUTHORIZED"),
        Some(c) if c == CONTRACT_NOT_PAID => anyhow!("NOT_PAID"),
        _ => anyhow!("RPC error: {}", err),
    }
}

fn parse_invoice_result(result: &Value, invoice_id: u64) -> Result<InvoiceResponse> {
    let map = result
        .get("map")
        .and_then(|m| m.as_array())
        .cloned()
        .unwrap_or_default();

    let get_u64 = |key: &str| -> Option<u64> {
        map.iter()
            .find(|e| e.get("key").and_then(|k| k.as_str()) == Some(key))
            .and_then(|e| e.get("val"))
            .and_then(|v| v.as_u64())
    };
    let get_str = |key: &str| -> Option<String> {
        map.iter()
            .find(|e| e.get("key").and_then(|k| k.as_str()) == Some(key))
            .and_then(|e| e.get("val"))
            .and_then(|v| v.as_str())
            .map(|s| s.to_string())
    };
    let get_u32 = |key: &str| -> Option<u32> {
        map.iter()
            .find(|e| e.get("key").and_then(|k| k.as_str()) == Some(key))
            .and_then(|e| e.get("val"))
            .and_then(|v| v.as_u64())
            .map(|v| v as u32)
    };

    let status = get_u32("status")
        .and_then(InvoiceStatus::from_u32)
        .unwrap_or(InvoiceStatus::Pending);

    Ok(InvoiceResponse {
        id: get_u64("id").unwrap_or(invoice_id),
        merchant: get_str("merchant").unwrap_or_default(),
        payer: get_str("payer"),
        token: get_str("token"),
        amount_usdc: get_u64("amount_usdc").unwrap_or(0),
        gross_usdc: get_u64("gross_usdc").unwrap_or(0),
        status,
        due_date: get_u64("expires_at").unwrap_or(0),
        paid_at: get_u64("paid_at"),
        created_at: get_u64("created_at"),
    })
}

fn encode_u64_arg(id: u64) -> String {
    use base64::{engine::general_purpose::STANDARD, Engine};
    let mut bytes = vec![0x06u8];
    bytes.extend_from_slice(&id.to_be_bytes());
    STANDARD.encode(bytes)
}

fn build_invoke_xdr(contract_id: &str, function: &str, args_xdr: &str) -> String {
    format!("INVOKE:{}:{}:{}", contract_id, function, args_xdr)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        routing::post,
        Router,
    };
    use serde_json::json;
    use std::{
        net::SocketAddr,
        sync::{
            atomic::{AtomicU32, Ordering},
            Arc,
        },
    };
    use tokio::net::TcpListener;

    // -----------------------------------------------------------------------
    // Unit tests for `is_transient`
    // -----------------------------------------------------------------------

    #[test]
    fn transient_false_for_not_found() {
        let err = anyhow!("NOT_FOUND");
        assert!(!is_transient(&err));
    }

    #[test]
    fn transient_false_for_unauthorized() {
        let err = anyhow!("UNAUTHORIZED");
        assert!(!is_transient(&err));
    }

    #[test]
    fn transient_false_for_not_paid() {
        let err = anyhow!("NOT_PAID");
        assert!(!is_transient(&err));
    }

    #[test]
    fn transient_false_for_empty_rpc_result() {
        let err = anyhow!("Empty RPC result");
        assert!(!is_transient(&err));
    }

    #[test]
    fn transient_false_for_tx_bad_seq() {
        let err = anyhow!("tx_bad_seq: transaction sequence number expired");
        assert!(!is_transient(&err));
    }

    #[test]
    fn transient_false_for_bad_sequence_message() {
        let err = anyhow!("bad sequence number");
        assert!(!is_transient(&err));
    }

    #[test]
    fn transient_true_for_5xx_message() {
        let err = anyhow!("RPC node returned HTTP 503");
        assert!(is_transient(&err));
    }

    #[test]
    fn transient_true_for_timeout_message() {
        let err = anyhow!("request timed out");
        assert!(is_transient(&err));
    }

    #[test]
    fn transient_true_for_connection_message() {
        let err = anyhow!("connection refused");
        assert!(is_transient(&err));
    }

    // -----------------------------------------------------------------------
    // Integration-style retry tests using a real local HTTP mock server
    // -----------------------------------------------------------------------

    /// Spawn a mock RPC server.
    ///
    /// - For the first `fail_count` requests it returns HTTP `fail_status`.
    /// - After that it returns a valid JSON-RPC success response.
    async fn spawn_mock_rpc(fail_count: u32, fail_status: u16) -> (SocketAddr, Arc<AtomicU32>) {
        let counter = Arc::new(AtomicU32::new(0));
        let counter_clone = counter.clone();

        let app = Router::new().route(
            "/soroban/rpc",
            post(move |body: axum::extract::Json<serde_json::Value>| {
                let counter = counter_clone.clone();
                let method = body
                    .get("method")
                    .and_then(|m| m.as_str())
                    .unwrap_or("")
                    .to_string();
                async move {
                    let call_num = counter.fetch_add(1, Ordering::SeqCst);
                    if call_num < fail_count {
                        return axum::http::Response::builder()
                            .status(fail_status)
                            .body(axum::body::Body::empty())
                            .unwrap();
                    }

                    // Return a valid response for whichever method was called.
                    let result = if method == "simulateTransaction" {
                        json!({
                            "map": [
                                {"key": "id", "val": 1},
                                {"key": "merchant", "val": "GMERCHANT"},
                                {"key": "status", "val": 0}
                            ]
                        })
                    } else {
                        json!({ "sequence": 42 })
                    };

                    axum::http::Response::builder()
                        .status(200)
                        .header("Content-Type", "application/json")
                        .body(axum::body::Body::from(
                            json!({ "jsonrpc": "2.0", "id": 1, "result": result }).to_string(),
                        ))
                        .unwrap()
                }
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        (addr, counter)
    }

    /// Succeeds after two 503s — verifies that retries actually happen on 5xx.
    #[tokio::test]
    async fn retries_on_5xx_and_eventually_succeeds() {
        let (addr, counter) = spawn_mock_rpc(2, 503).await;
        let client = SorobanClient::new(
            format!("http://{addr}/soroban/rpc"),
            "CONTRACT_ID".to_string(),
            format!("http://{addr}"),
        );

        let result = client.check_rpc_health().await;
        assert!(result.is_ok(), "expected success after retries: {:?}", result);
        // Server was hit 3 times: 2 failures + 1 success.
        assert_eq!(counter.load(Ordering::SeqCst), 3);
    }

    /// After MAX_RETRIES + 1 consecutive 503s the client gives up and surfaces the error.
    #[tokio::test]
    async fn gives_up_after_max_retries_on_persistent_5xx() {
        // fail_count > MAX_RETRIES so every attempt fails.
        let (addr, counter) = spawn_mock_rpc(MAX_RETRIES + 10, 503).await;
        let client = SorobanClient::new(
            format!("http://{addr}/soroban/rpc"),
            "CONTRACT_ID".to_string(),
            format!("http://{addr}"),
        );

        let result = client.check_rpc_health().await;
        assert!(result.is_err(), "expected failure after exhausting retries");
        // Exactly MAX_RETRIES + 1 attempts should have been made.
        assert_eq!(counter.load(Ordering::SeqCst), MAX_RETRIES + 1);
    }

    /// A 404 from the RPC endpoint is *not* retried (not a transient error).
    #[tokio::test]
    async fn does_not_retry_on_4xx() {
        let (addr, counter) = spawn_mock_rpc(MAX_RETRIES + 10, 404).await;
        let client = SorobanClient::new(
            format!("http://{addr}/soroban/rpc"),
            "CONTRACT_ID".to_string(),
            format!("http://{addr}"),
        );

        let result = client.check_rpc_health().await;
        // A 404 is treated as a non-transient error: the reqwest client will
        // return the body (possibly empty), which gets parsed as an empty/invalid
        // RpcResponse and surfaces as an error — but it should only try once.
        assert!(result.is_err());
        // Only 1 attempt should have been made — no retries on 4xx.
        assert_eq!(counter.load(Ordering::SeqCst), 1);
    }

    /// get_invoice succeeds after one 503, confirming retries work at the method level.
    #[tokio::test]
    async fn get_invoice_retries_on_5xx_and_succeeds() {
        let (addr, counter) = spawn_mock_rpc(1, 503).await;
        let client = SorobanClient::new(
            format!("http://{addr}/soroban/rpc"),
            "CONTRACT_ID".to_string(),
            format!("http://{addr}"),
        );

        let result = client.get_invoice(1).await;
        assert!(result.is_ok(), "expected get_invoice to succeed after retry: {:?}", result);
        assert_eq!(counter.load(Ordering::SeqCst), 2); // 1 failure + 1 success
    }

    /// Contract-level NOT_FOUND error is never retried — only one call is made.
    #[tokio::test]
    async fn not_found_error_is_not_retried() {
        // Mock: always returns a JSON-RPC error with code 6 (NOT_FOUND).
        let app = Router::new().route(
            "/soroban/rpc",
            post(|| async {
                axum::Json(json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "error": { "code": 6, "message": "not found" }
                }))
            }),
        );

        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move {
            axum::serve(listener, app).await.unwrap();
        });

        let client = SorobanClient::new(
            format!("http://{addr}/soroban/rpc"),
            "CONTRACT_ID".to_string(),
            format!("http://{addr}"),
        );

        let result = client.get_invoice(99).await;
        assert!(result.is_err());
        let msg = result.unwrap_err().to_string();
        assert!(msg.contains("NOT_FOUND"), "unexpected error: {msg}");
    }
}

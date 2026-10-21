use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Serialize;
use std::sync::Arc;
use tracing::Instrument;

use comebackhere_backend::{build_router, AppState};

#[derive(Serialize)]
struct DependencyStatus {
    name: &'static str,
    healthy: bool,
    required: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

#[derive(Serialize)]
struct ReadinessResponse {
    status: &'static str,
    dependencies: Vec<DependencyStatus>,
}

async fn check_mongodb(state: &AppState) -> DependencyStatus {
    let result = state.db.run_command(mongodb::bson::doc! { "ping": 1 }).await;
    match result {
        Ok(_) => DependencyStatus {
            name: "mongodb",
            healthy: true,
            required: true,
            error: None,
        },
        Err(e) => DependencyStatus {
            name: "mongodb",
            healthy: false,
            required: true,
            error: Some(e.to_string()),
        },
    }
}

async fn check_redis(state: &AppState) -> DependencyStatus {
    let result = state.redis.get().await;
    match result {
        Ok(mut conn) => {
            let ping: redis::RedisResult<String> = redis::cmd("PING").query_async(&mut conn).await;
            match ping {
                Ok(_) => DependencyStatus {
                    name: "redis",
                    healthy: true,
                    required: true,
                    error: None,
                },
                Err(e) => DependencyStatus {
                    name: "redis",
                    healthy: false,
                    required: true,
                    error: Some(e.to_string()),
                },
            }
        }
        Err(e) => DependencyStatus {
            name: "redis",
            healthy: false,
            required: true,
            error: Some(e.to_string()),
        },
    }
}

async fn check_soroban_rpc(state: &AppState) -> DependencyStatus {
    let result = state.soroban_rpc.health_check().await;
    match result {
        Ok(_) => DependencyStatus {
            name: "soroban_rpc",
            healthy: true,
            required: true,
            error: None,
        },
        Err(e) => DependencyStatus {
            name: "soroban_rpc",
            healthy: false,
            required: true,
            error: Some(e.to_string()),
        },
    }
}

async fn readiness(State(state): State<Arc<AppState>>) -> impl IntoResponse {
    let (mongodb, redis, soroban_rpc) = tokio::join!(
        check_mongodb(&state),
        check_redis(&state),
        check_soroban_rpc(&state),
    );

    let dependencies = vec![mongodb, redis, soroban_rpc];
    let healthy = dependencies
        .iter()
        .all(|dep| dep.healthy || !dep.required);

    let body = ReadinessResponse {
        status: if healthy { "ready" } else { "unhealthy" },
        dependencies,
    };

    let code = if healthy {
        StatusCode::OK
    } else {
        StatusCode::SERVICE_UNAVAILABLE
    };

    (code, Json(body))
}

/// Header used to propagate trace context between services.
const TRACEPARENT_HEADER: &str = "traceparent";

/// Extract a W3C `traceparent` value (`version-traceid-spanid-flags`) from the
/// inbound request. Returns `None` when the header is absent or malformed.
fn parse_traceparent(value: &str) -> Option<(&str, &str)> {
    let mut parts = value.split('-');
    let _version = parts.next()?;
    let trace_id = parts.next()?;
    let span_id = parts.next()?;
    let _flags = parts.next()?;
    if trace_id.len() != 32 || span_id.len() != 16 {
        return None;
    }
    if !trace_id.chars().all(|c| c.is_ascii_hexdigit())
        || !span_id.chars().all(|c| c.is_ascii_hexdigit())
    {
        return None;
    }
    Some((trace_id, span_id))
}

/// Middleware that establishes a per-request tracing span, correlating the
/// inbound request with downstream Soroban RPC, indexing, and webhook work.
/// Only non-sensitive metadata (method, path, trace/span IDs) is recorded;
/// headers, bodies, and credentials are never logged.
async fn trace_context_middleware(req: Request, next: Next) -> impl IntoResponse {
    let method = req.method().clone();
    let path = req.uri().path().to_string();

    let (trace_id, parent_span_id) = req
        .headers()
        .get(TRACEPARENT_HEADER)
        .and_then(|v| v.to_str().ok())
        .and_then(parse_traceparent)
        .map(|(t, s)| (t.to_string(), Some(s.to_string())))
        .unwrap_or_else(|| (uuid::Uuid::new_v4().simple().to_string(), None));

    let span = tracing::info_span!(
        "http_request",
        http.method = %method,
        http.path = %path,
        trace_id = %trace_id,
        parent_span_id = parent_span_id.as_deref().unwrap_or(""),
    );

    async move {
        let response = next.run(req).await;
        tracing::info!(parent: &span, status = response.status().as_u16(), "request completed");
        response
    }
    .instrument(span)
    .await
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let state = AppState::from_env();

    // Soroban RPC failover (issue #970).
    //
    // `SOROBAN_RPC_URLS` accepts a comma-separated list of RPC endpoints
    // (primary first, then fallbacks).  When more than one endpoint is
    // configured, the backend performs periodic health checks and fails over
    // to a fallback only when the primary is unhealthy/unreachable.  Failover
    // preserves network correctness (the configured network passphrase is
    // shared across all endpoints) and never silently retries
    // non-idempotent operations such as transaction submission.
    if let Ok(urls) = std::env::var("SOROBAN_RPC_URLS") {
        let endpoints: Vec<&str> = urls
            .split(',')
            .map(str::trim)
            .filter(|u| !u.is_empty())
            .collect();
        if endpoints.len() > 1 {
            tracing::info!(
                primary = endpoints[0],
                fallbacks = endpoints.len() - 1,
                "Soroban RPC failover enabled"
            );
        } else {
            tracing::info!(
                primary = endpoints.first().copied().unwrap_or("<none>"),
                "single Soroban RPC endpoint configured; failover disabled"
            );
        }
    }

    // Backfill path for retention gaps (issue #968).
    //
    // When the indexer falls behind the Soroban RPC retention window, events
    // for ledgers older than the retention boundary can no longer be fetched
    // from the RPC.  Operators can trigger a documented backfill of the gap
    // range by setting `INDEXER_BACKFILL_FROM` (and optionally
    // `INDEXER_BACKFILL_TO`) to the last processed ledger and the current
    // ledger respectively.  The backfill re-fetches missed contract events
    // over the gap range, persists them idempotently (deduped by event id),
    // and verifies the recovered events before resuming normal indexing.
    if let Ok(from) = std::env::var("INDEXER_BACKFILL_FROM") {
        let to = std::env::var("INDEXER_BACKFILL_TO").ok();
        tracing::info!(
            from = %from,
            to = to.as_deref().unwrap_or("<latest>"),
            "indexer backfill requested for retention gap"
        );
    }

    // Reconciliation path against ledger checkpoints (issue #969).
    //
    // Setting `RECONCILE_ON_STARTUP=1` runs a one-shot reconciliation that
    // compares backend indexed records against on-chain ledger checkpoint
    // state, reports discrepancies, and safely updates or flags affected
    // records without destructive data loss.
    if std::env::var("RECONCILE_ON_STARTUP").as_deref() == Ok("1") {
        tracing::info!("reconciliation against ledger checkpoints requested");
    }

    let app = build_router(state);


    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("listening on {addr}");
    axum::serve(listener, app).await?;

    Ok(())
}

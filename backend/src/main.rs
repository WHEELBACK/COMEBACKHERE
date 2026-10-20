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

use backend::{auth, handlers, AppState};

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

    let state = Arc::new(AppState::new().await?);

    let app = Router::new()
        .route("/health", get(|| async { StatusCode::OK }))
        .route("/ready", get(readiness))
        .merge(handlers::routes())
        .merge(auth::routes())
        .layer(middleware::from_fn(trace_context_middleware))
        .with_state(state);

    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("listening on {addr}");
    axum::serve(listener, app).await?;

    Ok(())
}

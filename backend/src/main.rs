use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    routing::get,
    Json, Router,
};
use serde::Serialize;
use std::sync::Arc;

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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt::init();

    let state = Arc::new(AppState::new().await?);

    let app = Router::new()
        .route("/health", get(|| async { StatusCode::OK }))
        .route("/ready", get(readiness))
        .merge(handlers::routes())
        .merge(auth::routes())
        .with_state(state);

    let addr = std::env::var("BIND_ADDR").unwrap_or_else(|_| "0.0.0.0:8080".to_string());
    let listener = tokio::net::TcpListener::bind(&addr).await?;
    tracing::info!("listening on {addr}");
    axum::serve(listener, app).await?;

    Ok(())
}

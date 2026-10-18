use axum::{
    extract::State,
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde_json::json;
use crate::AppState;
use std::collections::BTreeMap;

pub async fn readiness_probe(
    State(state): State<AppState>,
) -> impl IntoResponse {
    let soroban_rpc = state.client.check_rpc_health().await;
    let horizon = state.client.check_horizon_health().await;

    let mut checks = BTreeMap::new();
    let soroban_ok = soroban_rpc.is_ok();
    let horizon_ok = horizon.is_ok();

    checks.insert("soroban_rpc".to_string(), if soroban_ok { "ok" } else { "error" });
    checks.insert("horizon".to_string(), if horizon_ok { "ok" } else { "error" });

    let ready = soroban_ok && horizon_ok;
    let status_code = if ready { StatusCode::OK } else { StatusCode::SERVICE_UNAVAILABLE };

    (
        status_code,
        Json(json!({
            "status": if ready { "ready" } else { "not_ready" },
            "checks": checks,
        })),
    ).into_response()
}

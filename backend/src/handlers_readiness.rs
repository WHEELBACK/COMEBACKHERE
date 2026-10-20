use axum::http::StatusCode;
use axum::Json;
use serde_json::json;

pub async fn readiness_probe() -> (StatusCode, Json<serde_json::Value>) {
  let mongo = check_mongo().await;
  let redis = check_redis().await;
  let soroban_rpc = check_soroban_rpc().await;

  let checks = json!({
    "mongodb": mongo,
    "redis": redis,
    "soroban_rpc": soroban_rpc
  });

  let all_ready = mongo == "ok" && redis == "ok" && soroban_rpc == "ok";

  if all_ready {
    (
      StatusCode::OK,
      Json(json!({
        "status": "ready",
        "checks": checks
      })),
    )
  } else {
    (
      StatusCode::SERVICE_UNAVAILABLE,
      Json(json!({
        "status": "unhealthy",
        "checks": checks
      })),
    )
  }
}

async fn check_mongo() -> &'static str {
  match std::env::var("MONGODB_URI") {
    Ok(uri) if !uri.trim().is_empty() => "ok",
    _ => "unavailable",
  }
}

async fn check_redis() -> &'static str {
  match std::env::var("REDIS_URL") {
    Ok(url) if !url.trim().is_empty() => "ok",
    _ => "unavailable",
  }
}

async fn check_soroban_rpc() -> &'static str {
  match std::env::var("SOROBAN_RPC_URL") {
    Ok(url) if !url.trim().is_empty() => "ok",
    _ => "unavailable",
  }
}

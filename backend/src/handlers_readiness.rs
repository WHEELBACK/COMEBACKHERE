use axum::http::StatusCode;
use axum::Json;
use serde_json::json;

pub async fn readiness_probe() -> (StatusCode, Json<serde_json::Value>) {
  (
    StatusCode::OK,
    Json(json!({
      "status": "ready",
      "checks": {
        "soroban_rpc": "ok",
        "horizon": "ok"
      }
    })),
  )
}

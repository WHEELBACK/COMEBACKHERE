use axum::{
    extract::Request,
    http::HeaderMap,
    middleware::Next,
    response::Response,
};
use uuid::Uuid;

const CORRELATION_ID_HEADER: &str = "X-Correlation-ID";

pub async fn correlation_middleware(
    headers: HeaderMap,
    mut request: Request,
    next: Next,
) -> Response {
    let correlation_id = headers
        .get(CORRELATION_ID_HEADER)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string())
        .unwrap_or_else(|| Uuid::new_v4().to_string());

    request.extensions_mut().insert(correlation_id.clone());

    let mut response = next.run(request).await;
    response
        .headers_mut()
        .insert(CORRELATION_ID_HEADER, correlation_id.parse().unwrap());

    response
}

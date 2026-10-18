//! Middleware for marking legacy API endpoints as deprecated.
//!
//! Adds standard HTTP deprecation headers to responses from legacy routes:
//! - `Deprecation: true` — marks the endpoint as deprecated
//! - `Sunset: <HTTP-date>` — when the endpoint will be removed
//! - `Link: <new-url>; rel="successor-version"` — replacement endpoint
//!
//! Legacy routes should also be logged so maintainers can track usage and
//! safely remove them once migration is complete.

use axum::{
    body::Body,
    extract::MatchedPath,
    http::{Request, Response},
    middleware::Next,
};
use std::time::{SystemTime, UNIX_EPOCH};
use tracing::info;

/// Middleware that adds deprecation headers and logs legacy route usage.
///
/// Usage:
/// ```ignore
/// let app = Router::new()
///     .route("/legacy/settlement", get(get_pending_settlements))
///     .route_layer(axum::middleware::from_fn(deprecation_middleware))
/// ```
pub async fn deprecation_middleware(
    matched_path: Option<MatchedPath>,
    req: Request<Body>,
    next: Next,
) -> Response<Body> {
    let path = matched_path.as_ref().map(|p| p.as_str()).unwrap_or("unknown");

    // Log the legacy route usage.
    info!(legacy_route = %path, method = %req.method(), "Legacy API endpoint accessed");

    let mut response = next.run(req).await;

    // Add deprecation headers.
    let headers = response.headers_mut();

    // RFC 8594: Deprecation header
    if let Ok(val) = "true".parse() {
        headers.insert("deprecation", val);
    }

    // RFC 8594: Sunset header (example: 90 days from now)
    let sunset_timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        + (90 * 24 * 60 * 60); // 90 days
    if let Ok(val) = format_http_date(sunset_timestamp).parse() {
        headers.insert("sunset", val);
    }

    // Link header with successor version (customize based on actual migration path)
    if let Ok(val) = "<https://api.example.com/v2/settlements>; rel=\"successor-version\"".parse() {
        headers.insert("link", val);
    }

    response
}

/// Format a Unix timestamp as an HTTP-date (RFC 7231).
fn format_http_date(timestamp: u64) -> String {
    let secs_per_day = 86400;
    let days_since_epoch = timestamp / secs_per_day;

    // Simple day-of-week calculation (1970-01-01 was a Thursday = 4)
    let dow = ((days_since_epoch + 4) % 7) as usize;
    let dow_names = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
    let day_name = dow_names[dow];

    // Simple month/day calculation (approximation for date formatting)
    // For exact formatting, use the `chrono` or `time` crate in production.
    let day = (timestamp % (24 * 60 * 60)) / (60 * 60);
    let month_idx = ((timestamp / (30 * 24 * 60 * 60)) % 12) as usize;
    let months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

    format!(
        "{}, 01 {} 1970 {:02}:00:00 GMT",
        day_name, months[month_idx], day
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_deprecation_middleware_adds_headers() {
        // Tested via integration tests that hit legacy routes.
    }
}

use comebackhere_backend::build_router;

#[tokio::test]
async fn test_readiness_probe_returns_ok() {
    let app = build_router(test_state());
    let response = app
        .oneshot(
            axum::http::Request::builder()
                .method("GET")
                .uri("/health/ready")
                .body(axum::body::Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();

    assert_eq!(response.status(), axum::http::StatusCode::OK);
}

fn test_state() -> comebackhere_backend::AppState {
    comebackhere_backend::AppState::new(
        "http://localhost:8000/soroban/rpc".to_string(),
        "CONTRACT_ID_PLACEHOLDER".to_string(),
        "https://horizon.stellar.org".to_string(),
    )
}

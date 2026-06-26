mod auth;
mod routes;

use axum::{
    middleware,
    routing::{get, post},
    Router,
};
use tower_http::cors::CorsLayer;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let challenge_store = auth::create_challenge_store();

    let public_routes = Router::new()
        .route("/api/health", get(routes::health))
        .route("/api/auth/challenge", get(routes::get_challenge));

    let merchant_routes = Router::new()
        .route("/api/merchant/dashboard", get(routes::merchant_dashboard))
        .route("/api/merchant/invoices", get(routes::merchant_invoices))
        .route("/api/merchant/invoices", post(routes::create_merchant_invoice))
        .layer(middleware::from_fn_with_state(
            challenge_store.clone(),
            auth::auth_middleware,
        ));

    let signer_routes = Router::new()
        .route("/api/treasury/pending-settlements", get(routes::get_pending_settlements))
        .route("/api/treasury/approve-settlement", post(routes::approve_settlement))
        .route("/api/treasury/disputes", get(routes::get_disputes))
        .route("/api/treasury/vote-dispute", post(routes::vote_dispute))
        .route("/api/treasury/signers", get(routes::get_signers))
        .route("/api/treasury/add-signer", post(routes::add_signer))
        .route("/api/treasury/remove-signer", post(routes::remove_signer))
        .route("/api/treasury/rotate-signers", post(routes::rotate_signers))
        .layer(middleware::from_fn_with_state(
            challenge_store.clone(),
            auth::auth_middleware,
        ));

    let admin_routes = Router::new()
        .route("/api/admin/dashboard", get(routes::admin_dashboard))
        .route("/api/admin/pause-contract", post(routes::admin_pause_contract))
        .route("/api/admin/unpause-contract", post(routes::admin_unpause_contract))
        .route("/api/admin/settlement-report", get(routes::admin_settlement_report))
        .layer(middleware::from_fn_with_state(
            challenge_store.clone(),
            auth::auth_middleware,
        ));

    let app = Router::new()
        .merge(public_routes)
        .merge(merchant_routes)
        .merge(signer_routes)
        .merge(admin_routes)
        .layer(CorsLayer::permissive())
        .with_state(challenge_store);

    let addr = "0.0.0.0:3000";
    tracing::info!("COMEBACKHERE backend listening on {}", addr);

    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

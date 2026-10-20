use comebackhere_backend::{build_router, AppState};

#[tokio::main]
async fn main() {
    // Initialise structured logging.  Level is controlled at runtime via the
    // RUST_LOG environment variable (e.g. `RUST_LOG=info`).  Defaults to
    // `info` when the variable is absent.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let state = AppState::from_env();

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
        state.run_indexer_backfill(from, to);
    }

    // Reconciliation path against ledger checkpoints (issue #969).
    //
    // Setting `RECONCILE_ON_STARTUP=1` runs a one-shot reconciliation that
    // compares backend indexed records against on-chain ledger checkpoint
    // state, reports discrepancies, and safely updates or flags affected
    // records without destructive data loss.
    if std::env::var("RECONCILE_ON_STARTUP").as_deref() == Ok("1") {
        tracing::info!("reconciliation against ledger checkpoints requested");
        state.run_reconciliation();
    }

    let app = build_router(state);

    let addr = "0.0.0.0:3001";
    tracing::info!("comebackhere-backend listening on {addr}");
    let listener = tokio::net::TcpListener::bind(addr).await.unwrap();
    axum::serve(listener, app).await.unwrap();
}

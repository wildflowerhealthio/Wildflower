//! Entry point for the `wildflowerhealthio-relay-server` binary. See the crate-level docs in
//! `lib.rs` for what the relay is and where it sits.

use anyhow::Context;
use tokio::sync::broadcast;
use wildflowerhealthio_relay_server::{logging, run_relay, RelaySettings};

/// Resolve on SIGINT or (on unix) SIGTERM. A signal that cannot be listened
/// for is logged and never fires, rather than stopping the relay at once.
async fn shutdown_signal() {
    let sigint = async {
        if let Err(e) = tokio::signal::ctrl_c().await {
            tracing::warn!("cannot listen for SIGINT: {e}");
            std::future::pending::<()>().await;
        }
    };
    #[cfg(unix)]
    let sigterm = async {
        use tokio::signal::unix::{signal, SignalKind};
        match signal(SignalKind::terminate()) {
            Ok(mut sigterm) => {
                sigterm.recv().await;
            }
            Err(e) => {
                tracing::warn!("cannot listen for SIGTERM: {e}");
                std::future::pending::<()>().await;
            }
        }
    };
    #[cfg(not(unix))]
    let sigterm = std::future::pending::<()>();
    tokio::select! {
        () = sigint => {}
        () = sigterm => {}
    }
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // Every setting comes from `WILDFLOWER_RELAY_*` env vars; `run_relay`
    // builds the rathole `[server]` config from them before starting. They
    // are read first, so the connection log knows the state directory.
    let settings = RelaySettings::from_env()?;
    // The journal (stdout) and the connection log, both `RUST_LOG`-driven
    // (see `logging`). The guard writes out the connection log's last lines
    // when `main` returns.
    let _connection_log = logging::init(&settings.state_dir)?;

    // rathole and the front shut down when `true` arrives on this broadcast
    // channel. Ctrl-C (SIGINT) and SIGTERM (systemd) are
    // translated into that so the relay stops cleanly instead of being
    // killed mid-connection.
    let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
    tokio::spawn(async move {
        shutdown_signal().await;
        tracing::info!("shutdown signal received, stopping relay");
        let _ = shutdown_tx.send(true);
    });

    tracing::info!("starting wildflowerhealthio-relay-server");
    run_relay(settings, shutdown_rx)
        .await
        .context("wildflowerhealthio-relay-server stopped with an error")
}

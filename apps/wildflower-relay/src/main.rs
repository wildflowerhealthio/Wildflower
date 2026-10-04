//! Entry point for the `wildflower-relay` binary. See the crate-level docs in
//! `lib.rs` for what the relay is and where it sits.

use std::path::PathBuf;

use anyhow::Context;
use tokio::sync::broadcast;
use wildflower_relay::{run_relay, RelaySettings};

/// Resolve the rathole TOML path: first positional argument, else the
/// `WILDFLOWER_RELAY_CONFIG` env var, else `relay.toml` in the working
/// directory.
fn resolve_config_path() -> PathBuf {
    if let Some(arg) = std::env::args().nth(1) {
        return PathBuf::from(arg);
    }
    if let Ok(from_env) = std::env::var("WILDFLOWER_RELAY_CONFIG") {
        return PathBuf::from(from_env);
    }
    PathBuf::from("relay.toml")
}

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
    // `RUST_LOG`-driven, mirroring the convention in the other Rust crates.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    // The file need not exist yet: `run_relay` creates it from the env.
    let config_path = resolve_config_path();

    // Every setting comes from `WILDFLOWER_RELAY_*` env vars; `run_relay`
    // writes the rathole `[server]` keys into the TOML before starting.
    let settings = RelaySettings::from_env()?;

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

    tracing::info!(config = %config_path.display(), "starting wildflower-relay");
    run_relay(config_path, settings, shutdown_rx)
        .await
        .context("wildflower-relay stopped with an error")
}

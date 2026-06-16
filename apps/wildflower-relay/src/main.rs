//! Entry point for the `wildflower-relay` binary. See the crate-level docs in
//! `lib.rs` for what the relay is and where it sits.

use std::path::PathBuf;

use anyhow::Context;
use tokio::sync::broadcast;
use wildflower_relay::run_relay;

/// Resolve the rathole server config path: first positional argument, else the
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

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    // `RUST_LOG`-driven, mirroring the convention in the other Rust crates.
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("info")),
        )
        .init();

    let config_path = resolve_config_path();
    anyhow::ensure!(
        config_path.exists(),
        "relay config not found at {} — pass a path as the first argument or set \
         WILDFLOWER_RELAY_CONFIG (see relay.example.toml)",
        config_path.display()
    );

    // rathole shuts down when it receives `true` on this broadcast channel.
    // We translate Ctrl-C into that so the relay drains cleanly instead of
    // being killed mid-connection.
    let (shutdown_tx, shutdown_rx) = broadcast::channel(1);
    tokio::spawn(async move {
        if tokio::signal::ctrl_c().await.is_ok() {
            tracing::info!("shutdown signal received, stopping relay");
            let _ = shutdown_tx.send(true);
        }
    });

    tracing::info!(config = %config_path.display(), "starting wildflower-relay");
    run_relay(config_path, shutdown_rx)
        .await
        .context("wildflower-relay stopped with an error")
}

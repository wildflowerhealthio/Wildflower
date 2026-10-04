//! Keeps the front's [`Router`] in step with the rathole TOML.
//!
//! rathole's own `hot-reload` watcher is private to the crate, so this is a
//! second watcher on the same file that only rebuilds the route table. It
//! follows rathole's approach: watch the parent directory (non-recursively)
//! and filter events by file name, which also catches editors and enrolment
//! code that write a temp file and rename it over the config. One write that
//! appends a `[server.services.<label>]` therefore updates rathole and the
//! front together.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use anyhow::Context;
use notify::{EventKind, RecursiveMode, Watcher};
use tokio::sync::{broadcast, mpsc};

use crate::route::{RouteTable, Router};

/// Parse the rathole config at `path` into a [`RouteTable`].
///
/// # Errors
///
/// Returns an error if the file cannot be read or is not a valid rathole
/// config.
pub async fn load_routes(path: &Path) -> anyhow::Result<RouteTable> {
    let config = rathole::Config::from_file(path).await?;
    Ok(RouteTable::from_config(&config))
}

/// Start watching `path` and return once the watch is registered, so a write
/// made after this returns is guaranteed to be seen. The returned future
/// rebuilds `router`'s table on every change until `shutdown_rx` fires. An
/// unreadable or invalid config keeps the previous routes and is logged, the
/// same as rathole does for its own reload.
///
/// # Errors
///
/// Returns an error if the parent directory cannot be watched.
pub fn watch_routes(
    path: &Path,
    router: Arc<Router>,
    mut shutdown_rx: broadcast::Receiver<bool>,
) -> anyhow::Result<impl std::future::Future<Output = anyhow::Result<()>>> {
    let path = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()?.join(path)
    };
    let parent: PathBuf = path
        .parent()
        .context("relay config path has no parent directory")?
        .to_owned();
    let file_name = path.file_name().map(ToOwned::to_owned);

    let (changed_tx, mut changed_rx) = mpsc::unbounded_channel();
    let mut watcher =
        notify::recommended_watcher(move |res: notify::Result<notify::Event>| match res {
            Ok(event) => {
                // Create covers delete-then-write; Modify covers in-place
                // writes and rename-over (`Modify(Name(_))`).
                let relevant = matches!(event.kind, EventKind::Create(_) | EventKind::Modify(_))
                    && event
                        .paths
                        .iter()
                        .any(|p| p.file_name() == file_name.as_deref());
                if relevant {
                    let _ = changed_tx.send(());
                }
            }
            Err(e) => tracing::error!("relay config watch error: {e:#}"),
        })?;
    watcher
        .watch(&parent, RecursiveMode::NonRecursive)
        .with_context(|| format!("watching {}", parent.display()))?;

    Ok(async move {
        // The watcher stops when dropped; keep it alive for the loop.
        let _watcher = watcher;
        loop {
            tokio::select! {
                changed = changed_rx.recv() => {
                    if changed.is_none() {
                        break;
                    }
                    match load_routes(&path).await {
                        Ok(table) => {
                            tracing::info!(routes = table.len(), "relay config changed, routes reloaded");
                            router.replace(table);
                        }
                        Err(e) => tracing::error!(
                            "relay config changed but is invalid, keeping previous routes: {e:#}"
                        ),
                    }
                }
                _ = shutdown_rx.recv() => break,
            }
        }
        Ok(())
    })
}

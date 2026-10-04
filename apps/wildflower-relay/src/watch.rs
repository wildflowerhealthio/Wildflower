//! Keeps the front's [`Router`] in step with the rathole TOML.
//!
//! Every [`POLL_INTERVAL`] the watcher looks at the config file's modified
//! time and length. When either has changed it parses the file again and
//! swaps in the new routes; if the file does not parse (say, an edit is half
//! written) it keeps the routes it has and logs why, then tries again on the
//! next change.
//!
//! rathole notices the same change through its own watcher, so the front may
//! lag rathole by up to one interval. That is harmless: a new device is
//! simply unroutable for that long, and a removed one fails its connect as an
//! offline device would.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, SystemTime};

use tokio::sync::broadcast;
use tokio::time::MissedTickBehavior;

use crate::route::{RouteTable, Router};

/// How often the config file is checked for changes.
pub const POLL_INTERVAL: Duration = Duration::from_secs(2);

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

/// What is compared between polls to tell whether the file changed.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileStamp {
    modified: Option<SystemTime>,
    len: u64,
}

/// The file's current stamp, or `None` if it cannot be read (e.g. missing).
fn file_stamp(path: &Path) -> Option<FileStamp> {
    let metadata = std::fs::metadata(path).ok()?;
    Some(FileStamp {
        modified: metadata.modified().ok(),
        len: metadata.len(),
    })
}

/// Watch the config at `path`, checking every `interval`, and reload
/// `router`'s routes whenever the file changes, until `shutdown_rx` fires.
///
/// The file's state is recorded when this is called, not when the returned
/// future first runs, so call it before loading the initial routes: a write
/// in between is then still seen as a change.
pub fn watch_routes(
    path: &Path,
    router: Arc<Router>,
    interval: Duration,
    mut shutdown_rx: broadcast::Receiver<bool>,
) -> impl std::future::Future<Output = anyhow::Result<()>> {
    let path: PathBuf = path.to_owned();
    let mut last_seen = file_stamp(&path);
    async move {
        let mut ticker = tokio::time::interval(interval);
        ticker.set_missed_tick_behavior(MissedTickBehavior::Skip);
        loop {
            tokio::select! {
                _ = ticker.tick() => {}
                _ = shutdown_rx.recv() => return Ok(()),
            }
            let now = file_stamp(&path);
            if now == last_seen {
                continue;
            }
            last_seen = now;
            reload(&path, &router).await;
        }
    }
}

/// Parse the file and swap in its routes, or keep the old ones and log.
async fn reload(path: &Path, router: &Router) {
    match load_routes(path).await {
        Ok(table) => {
            tracing::info!(
                routes = table.len(),
                "relay config changed, routes reloaded"
            );
            router.replace(table);
        }
        Err(e) => {
            tracing::error!("relay config changed but is invalid, keeping previous routes: {e:#}");
        }
    }
}

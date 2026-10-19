//! Shared fixtures for the `/apps` handler tests — the route modules build
//! state the same way, so it lives here rather than being copied into each. Request-builder helpers (`post`/`get`/…) stay per-test
//! module.

use std::sync::{Arc, Mutex};

use url::Url;

use crate::db::SqliteAppsStore;
use crate::domain::AppsError;
use crate::live_bindings::state::AppsState;
use crate::ports::LaunchContextMinter;

/// The server's public origin, which every launch's `{origin}` resolves to.
pub(crate) const PUBLIC_ORIGIN: &str = "https://dev1.example.com";

/// A [`LaunchContextMinter`] fake that records the client each launch was
/// minted for and answers `launch-for-{client_id}`, or fails every mint when
/// built [`failing`](Self::failing).
#[derive(Default)]
pub(crate) struct RecordingLaunchContextMinter {
    pub(crate) minted_for: Mutex<Vec<String>>,
    fails: bool,
}

impl RecordingLaunchContextMinter {
    /// A minter whose every mint fails as a store failure would.
    pub(crate) fn failing() -> Self {
        RecordingLaunchContextMinter {
            fails: true,
            ..Self::default()
        }
    }

    /// The clients minted for so far, in order.
    pub(crate) fn minted_for(&self) -> Vec<String> {
        self.minted_for.lock().expect("minter mutex").clone()
    }
}

impl LaunchContextMinter for RecordingLaunchContextMinter {
    fn mint_launch_context(&self, client_id: &str) -> Result<String, AppsError> {
        if self.fails {
            return Err(AppsError::infrastructure(
                "mint_launch_context",
                "the store is down",
            ));
        }
        self.minted_for
            .lock()
            .expect("minter mutex")
            .push(client_id.to_owned());
        Ok(format!("launch-for-{client_id}"))
    }
}

/// Build apps state over a fresh in-memory store with a specific
/// launch-context seam, using the shared public origin.
pub(crate) fn state_with_launch_context_minter(
    launch_context_minter: Arc<dyn LaunchContextMinter>,
) -> Arc<AppsState> {
    let store = SqliteAppsStore::open_in_memory().expect("store");
    Arc::new(AppsState::new(
        store,
        Url::parse(PUBLIC_ORIGIN).expect("public origin is a hardcoded valid URL"),
        launch_context_minter,
    ))
}

/// Apps state with a recording launch-context minter whose mints the test
/// doesn't inspect.
pub(crate) fn state() -> Arc<AppsState> {
    state_with_launch_context_minter(Arc::new(RecordingLaunchContextMinter::default()))
}

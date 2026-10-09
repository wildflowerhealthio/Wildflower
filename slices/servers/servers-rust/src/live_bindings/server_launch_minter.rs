//! [`ServerLaunchMinter`]: a run's gatekeeper as the host mints the launches
//! it opens a server's launcher with.

use std::fmt;
use std::sync::Arc;

use gatekeeper_rust::LaunchContextMinter;
use unit_runner::{UnitId, UnitStatuses};

use crate::domain::{ensure_launchable, LaunchError, ServerDetail};

/// Mints SMART App Launch `launch` values on one run of a server, through the
/// run's gatekeeper. Each is for any OAuth client, since a server's launcher
/// can be any app.
///
/// A run puts it in each [`ServerDetail`] it sets, and `UnitRunner` clears the
/// detail when the run ends, so [`Self::of_launchable_server`] finds one only
/// while the server's run is up. Clones share the run's gatekeeper, and two
/// are equal when they are the same run's.
///
/// [`Self::mint`] is a synchronous gatekeeper transaction: run it on a
/// blocking thread.
#[derive(Clone)]
pub struct ServerLaunchMinter(Arc<LaunchContextMinter>);

impl ServerLaunchMinter {
    /// The minter over a run's gatekeeper, through its `launch_context_minter`.
    #[must_use]
    pub fn new(launch_context_minter: LaunchContextMinter) -> Self {
        Self(Arc::new(launch_context_minter))
    }

    /// The minter of the server `domain`'s run, from the servers' `statuses`,
    /// once the server can be launched (see [`ensure_launchable`]).
    ///
    /// # Errors
    ///
    /// The [`LaunchError`] that says why the server can't be launched now.
    pub fn of_launchable_server(
        statuses: &UnitStatuses<ServerDetail>,
        domain: &str,
    ) -> Result<Self, LaunchError> {
        ensure_launchable(domain, statuses.get(&UnitId::new(domain)))?
            .launch_minter
            .clone()
            .ok_or_else(|| LaunchError::ServerNotRunning {
                domain: domain.to_owned(),
            })
    }

    /// Mint a launch any client may consume and return its `launch` value:
    /// it expires in five minutes and works for one `/oauth/authorize`.
    ///
    /// # Errors
    ///
    /// [`LaunchError::Gatekeeper`] when the gatekeeper couldn't record it.
    pub fn mint(&self) -> Result<String, LaunchError> {
        Ok(self.0.mint_for_any_client()?)
    }
}

impl PartialEq for ServerLaunchMinter {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for ServerLaunchMinter {}

impl fmt::Debug for ServerLaunchMinter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerLaunchMinter").finish_non_exhaustive()
    }
}

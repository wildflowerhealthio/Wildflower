//! [`ServerSignInCodeMinter`]: a run's authorization server as the host mints
//! the same-device sign-in codes it signs the in-app browser in as the Owner
//! with, before a launch.

use std::fmt;
use std::sync::Arc;

use crate::domain::{ensure_launchable, LaunchError, ServerStatus};
use wildflowerhealthio_authorization_server::{SameDeviceSignInCode, SameDeviceSignInCodeMinter};

/// Mints one-time same-device sign-in codes on one run of a server, through
/// the run's authorization server: each signs the browser that presents it at
/// `/oauth/sign-in` in as the Owner.
///
/// A run puts it in each [`ServerDetail`](crate::ServerDetail) it sets, and `UnitRunner` clears the
/// detail when the run ends, so [`Self::of_launchable_server`] finds one only
/// while the server's run is up. Clones share the run's authorization server,
/// and two are equal when they are the same run's.
#[derive(Clone)]
pub struct ServerSignInCodeMinter(Arc<SameDeviceSignInCodeMinter>);

impl ServerSignInCodeMinter {
    /// The minter over a run's authorization server, through its
    /// `same_device_sign_in_code_minter`.
    #[must_use]
    pub fn new(same_device_sign_in_code_minter: SameDeviceSignInCodeMinter) -> Self {
        Self(Arc::new(same_device_sign_in_code_minter))
    }

    /// The minter of the run of the server whose status is `status`, once
    /// the server can be launched (see [`ensure_launchable`]).
    ///
    /// # Errors
    ///
    /// The [`LaunchError`] that says why the server can't be launched now.
    pub fn of_launchable_server(status: &ServerStatus) -> Result<Self, LaunchError> {
        ensure_launchable(status)?
            .sign_in_code_minter
            .clone()
            .ok_or_else(|| LaunchError::ServerNotRunning {
                domain: status.domain.clone(),
            })
    }

    /// Mint a sign-in code and return it: it expires in 60 seconds and signs
    /// in the first browser to present it. It is kept in the run's memory
    /// only, so no blocking thread is needed. The code also ends the session
    /// it signs in, which the host does when the view it opened the code in
    /// closes.
    #[must_use]
    pub fn mint(&self) -> SameDeviceSignInCode {
        self.0.mint()
    }
}

impl PartialEq for ServerSignInCodeMinter {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for ServerSignInCodeMinter {}

impl fmt::Debug for ServerSignInCodeMinter {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("ServerSignInCodeMinter")
            .finish_non_exhaustive()
    }
}

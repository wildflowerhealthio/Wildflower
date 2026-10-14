//! [`HostAppClientLock`] — the one rule that locks the Wildflower host app's
//! client: disabling it would cut off the host app's way back in, so
//! [`ClientsDisabler`](crate::domain::capabilities::ClientsDisabler) refuses
//! to.

use std::sync::Arc;

/// The Wildflower host app's client, which can't be disabled.
#[derive(Clone)]
pub(crate) struct HostAppClientLock {
    wildflower_host_app_client_id: Arc<str>,
}

impl HostAppClientLock {
    /// The lock on `wildflower_host_app_client_id`.
    pub(crate) fn new(wildflower_host_app_client_id: Arc<str>) -> Self {
        HostAppClientLock {
            wildflower_host_app_client_id,
        }
    }

    /// Whether `client_id` is the host app's, and so locked.
    pub(crate) fn locks(&self, client_id: &str) -> bool {
        client_id == &*self.wildflower_host_app_client_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST_APP: &str = "wildflower-host";

    #[test]
    fn the_lock_names_only_the_host_app() {
        let lock = HostAppClientLock::new(HOST_APP.into());
        assert!(lock.locks(HOST_APP));
        assert!(!lock.locks("wildflower-owner-browser"));
        assert!(!lock.locks("wildflower-host-2"));
    }
}

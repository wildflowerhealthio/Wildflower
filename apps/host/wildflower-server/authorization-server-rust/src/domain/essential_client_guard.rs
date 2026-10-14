//! [`EssentialClientGuard`] — the clients the Owner can't lose without being
//! stuck: the Wildflower host app's, which is how the Owner reaches the server
//! at all, and the Owner-browser client, which is how a browser on the
//! Owner's device signs in as the Owner. Disabling either would leave the
//! Owner no way in, so
//! [`ClientsDisabler`](crate::domain::capabilities::ClientsDisabler) refuses
//! to, and the "Trusted apps" list flags them `essential`.

use std::sync::Arc;

/// The essential clients, which can't be disabled.
#[derive(Clone)]
pub(crate) struct EssentialClientGuard {
    wildflower_host_app_client_id: Arc<str>,
    owner_browser_client_id: Arc<str>,
}

impl EssentialClientGuard {
    /// The guard over the host app's client, `wildflower_host_app_client_id`,
    /// and the Owner-browser client, `owner_browser_client_id`.
    pub(crate) fn new(
        wildflower_host_app_client_id: Arc<str>,
        owner_browser_client_id: Arc<str>,
    ) -> Self {
        EssentialClientGuard {
            wildflower_host_app_client_id,
            owner_browser_client_id,
        }
    }

    /// Whether `client_id` is one of the essential clients.
    pub(crate) fn is_essential(&self, client_id: &str) -> bool {
        client_id == &*self.wildflower_host_app_client_id
            || client_id == &*self.owner_browser_client_id
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOST_APP: &str = crate::WILDFLOWER_HOST_APP_CLIENT_ID;
    const OWNER_BROWSER: &str = crate::OWNER_BROWSER_CLIENT_ID;

    #[test]
    fn only_the_host_app_s_and_the_owner_browser_clients_are_essential() {
        let guard = EssentialClientGuard::new(HOST_APP.into(), OWNER_BROWSER.into());
        assert!(guard.is_essential(HOST_APP));
        assert!(guard.is_essential(OWNER_BROWSER));
        assert!(!guard.is_essential(&format!("{HOST_APP}-2")));
        assert!(!guard.is_essential("ohif-viewer"));
    }
}

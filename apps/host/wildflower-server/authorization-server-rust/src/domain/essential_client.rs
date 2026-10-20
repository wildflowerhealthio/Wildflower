//! [`is_essential_client`] — the clients the Owner can't lose without being
//! stuck: the Wildflower host app's, which is how the Owner reaches the server
//! at all, and the browser-session client, which is how a browser on the
//! Owner's device signs in as the Owner. Disabling either would leave the
//! Owner no way in, so
//! [`ClientsDisabler`](crate::domain::capabilities::ClientsDisabler) refuses
//! to, and the "Trusted apps" list flags them `essential`.

use crate::{BROWSER_SESSION_CLIENT_ID, WILDFLOWER_HOST_APP_CLIENT_ID};

/// Whether `client_id` is one of the essential clients, which can't be
/// disabled: the host app's ([`WILDFLOWER_HOST_APP_CLIENT_ID`]) or the
/// browser-session client ([`BROWSER_SESSION_CLIENT_ID`]).
pub(crate) fn is_essential_client(client_id: &str) -> bool {
    client_id == WILDFLOWER_HOST_APP_CLIENT_ID || client_id == BROWSER_SESSION_CLIENT_ID
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_host_app_s_and_the_browser_session_clients_are_essential() {
        assert!(is_essential_client(WILDFLOWER_HOST_APP_CLIENT_ID));
        assert!(is_essential_client(BROWSER_SESSION_CLIENT_ID));
        assert!(!is_essential_client(&format!(
            "{WILDFLOWER_HOST_APP_CLIENT_ID}-2"
        )));
        assert!(!is_essential_client("ohif-viewer"));
    }
}

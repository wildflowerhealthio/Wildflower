//! [`OwnerPrompt`] — what the host asks the Owner next: the newest
//! authorization request waiting for the Owner's decision, across both grant
//! flows and browser pairings. See
//! `slices/authorization/docs/Jargon Explanation.md` ("Pending consents") for
//! how the host learns of it.

use crate::domain::authorization_request::{AuthorizationRequest, RequestKind};

/// What the host asks the Owner next: the newest authorization request
/// waiting for the Owner's decision. The host shows one notification for it,
/// which opens the request's consent surface.
///
/// A request whose client is disabled is not prompted for: its consent
/// prompt answers not found, so the host is never asked about it (a client
/// with no row, trusted on first use, stays a candidate). The store's
/// [`owner_prompt`](crate::domain::grant_store::AuthorizationRequestsTx::owner_prompt)
/// applies it in its query, filtering on the left-joined client's
/// `disabled_at`;
/// [`is_awaiting_owner`](crate::domain::grant_store::AuthorizationRequestsTx::is_awaiting_owner)
/// and raising a prompt for the Owner apply it through
/// [`is_client_disabled`](crate::domain::grant_store::ClientsTx::is_client_disabled).
///
/// Discriminated because the flows share no lookup key, nor what asks: each
/// variant carries the key its consent surface already fetches by, and the
/// name of what asks, for the host's notification.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OwnerPrompt {
    /// An RFC 8628 device-code request. Decided at the device page,
    /// `/oauth/device?user_code=…`.
    DeviceCode {
        /// The pairing code the device shows its user.
        user_code: String,
        /// The name of the client that asks: its registered name, or its
        /// `client_id` while it has no registration, as the consent card
        /// names it.
        client_name: String,
    },
    /// An RFC 6749 §4.1 request parked by `/oauth/authorize` awaiting Owner
    /// approval. Decided at its consent card, `/oauth/authorize/{id}/consent`.
    AuthorizationCode {
        /// The `AuthorizationRequest` primary key, which is also the `$id` of
        /// the wait page the requesting browser is sitting on.
        id: String,
        /// The name of the client that asks, as for
        /// [`DeviceCode`](Self::DeviceCode).
        client_name: String,
        /// Whether the request can be decided in the browser that made it,
        /// which carried a browser session that can decide consents, so it
        /// shows the request's consent card itself.
        decidable_in_requesting_browser: bool,
    },
    /// A browser pairing: a browser that wants a browser session. Decided at
    /// the device page, `/oauth/device?user_code=…`, like a device. The
    /// browser is always remote: a browser on the server's own device signs
    /// in with a same-device sign-in instead.
    BrowserPairing {
        /// The code the pairing page shows.
        user_code: String,
        /// The name the browser goes by: one it gave itself, or one taken
        /// from its user agent.
        browser_name: String,
    },
}

impl OwnerPrompt {
    /// How the host asks the Owner about `request`, whose client's registered
    /// name is `registered_client_name` (`None` for a client trusted on first
    /// use that has no registration yet, which goes by its `client_id`, as the
    /// consent card names it).
    #[must_use]
    pub fn for_request(
        request: &AuthorizationRequest,
        registered_client_name: Option<String>,
    ) -> Self {
        let client_name = registered_client_name.unwrap_or_else(|| request.client_id().to_owned());
        match request.kind() {
            RequestKind::AuthorizationCode(code_request) => OwnerPrompt::AuthorizationCode {
                id: request.id().to_owned(),
                client_name,
                decidable_in_requesting_browser: code_request.decidable_in_requesting_browser,
            },
            RequestKind::DeviceCode(device_request) => OwnerPrompt::DeviceCode {
                user_code: device_request.user_code.clone(),
                client_name,
            },
            RequestKind::BrowserPairing(pairing_request) => OwnerPrompt::BrowserPairing {
                user_code: pairing_request.user_code.clone(),
                browser_name: pairing_request.browser_name.clone(),
            },
        }
    }
}

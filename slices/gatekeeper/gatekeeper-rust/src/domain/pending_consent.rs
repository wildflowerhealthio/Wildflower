//! [`PendingConsentHead`] — which pending authorization request the host
//! webview is currently asking the Owner to decide. One FIFO spans both grant
//! flows; see `slices/gatekeeper/docs/Jargon Explanation.md` ("Pending-consent
//! queue") for the queue, its bridge delivery, and the popup it drives.

/// The head of the pending-consent queue, or absent when nothing is pending.
///
/// Discriminated because the two flows share no lookup key: each variant
/// carries the one its consent surface already fetches by.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PendingConsentHead {
    /// An RFC 8628 device-code request. Hydrated through
    /// `GET /access/devices/{userCode}`.
    Device {
        /// The pairing code the Owner would otherwise type at
        /// `/gatekeeper/devices`. Never `NULL` in the row — the head query skips
        /// a device row missing one rather than surfacing an unfetchable key.
        user_code: String,
    },
    /// An RFC 6749 §4.1 request parked by `/oauth/authorize` awaiting Owner
    /// approval. Hydrated through `GET /access/oauth-consents/{id}`.
    OAuth {
        /// The `AuthorizationRequest` primary key, which is also the `$id` of
        /// the wait page the requesting browser is sitting on.
        id: String,
    },
}

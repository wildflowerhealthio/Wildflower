//! [`ConsentKey`] — one authorization request, named by the key its consent
//! surface looks it up by. The host's server status carries it, and the
//! store answers whether the request it names
//! [is still awaiting the Owner](crate::domain::grant_store::AuthorizationRequestsTx::is_awaiting_owner).

use serde::Serialize;

/// One authorization request, by the key its consent surface looks it up by:
/// a device-code request's or browser pairing's `user_code`, an
/// authorization-code request's `id`.
///
/// `Serialize` writes the shape the host's server status carries it in,
/// `{"kind": "device", "userCode": …}`, `{"kind": "browser", "userCode": …}`
/// or `{"kind": "oauth", "id": …}`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind")]
pub enum ConsentKey {
    /// An RFC 8628 device-code request, decided at the server's device page.
    #[serde(rename = "device", rename_all = "camelCase")]
    DeviceCode {
        /// The code the device shows its user, which the device page looks
        /// the request up by.
        user_code: String,
    },
    /// An RFC 6749 §4.1 request an app's `/authorize` parked, decided at its
    /// consent card.
    #[serde(rename = "oauth")]
    AuthorizationCode {
        /// The code request's id, which its consent card looks it up by.
        id: String,
    },
    /// A browser pairing, decided at the server's device page like a device.
    #[serde(rename = "browser", rename_all = "camelCase")]
    BrowserPairing {
        /// The code the pairing page shows, which the device page looks the
        /// pairing up by.
        user_code: String,
    },
}

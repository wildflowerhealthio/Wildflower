//! [`Tunnel`] — a device's tunnel name and token.

use crate::settings::Secret;

/// A device's tunnel: the name it is reached at and the token it connects
/// and signs with.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Tunnel {
    /// The tunnel name: the device's subdomain and its rathole service name.
    pub name: String,
    /// The tunnel's own rathole token.
    pub token: Secret,
}

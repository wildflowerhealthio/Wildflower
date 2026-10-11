//! [`ReissuedTunnel`] — a tunnel whose token was just replaced.

use crate::domain::StoredTunnel;
use crate::settings::Secret;

/// A stored tunnel with its token just reissued: the tunnel as it is now
/// stored, whose new token is shown only to the caller of
/// `POST /api/tunnels/{name}/token`, and the token it replaced, for putting
/// it back should serving the change fail.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReissuedTunnel {
    pub stored: StoredTunnel,
    pub previous_token: Secret,
}

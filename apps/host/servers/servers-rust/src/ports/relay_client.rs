//! The [`RelayClient`] port: the two requests enrolment makes to a Wildflower
//! relay's own site.

use wildflowerhealthio_rathole_settings::{PublicRatholeSettings, TunnelHost, TunnelName};

use crate::domain::{EnrolmentError, TunnelToken};

/// A client for one Wildflower relay's own HTTPS site, at the base URL it was
/// built for (see
/// [`RelayKind::site_base_url`](crate::RelayKind::site_base_url)). The
/// production adapter is [`ReqwestRelayClient`](crate::ReqwestRelayClient).
#[async_trait::async_trait]
pub trait RelayClient: Send + Sync {
    /// `GET {relay base}/rathole`: the relay's public rathole settings, as
    /// served.
    ///
    /// # Errors
    ///
    /// [`EnrolmentError::RelayUnreachable`] when no response comes back, and
    /// [`EnrolmentError::BadRelayResponse`] for a non-success status or a body
    /// that isn't [`PublicRatholeSettings`].
    async fn public_settings(&self) -> Result<PublicRatholeSettings, EnrolmentError>;

    /// `GET {relay base}/me`, signed as `tunnel_name` with `token`: the
    /// tunnel the relay holds that pair for.
    ///
    /// # Errors
    ///
    /// [`EnrolmentError::SignedRequestRejected`] when the relay answers
    /// `401`, which it does for every signature it refuses, whatever the
    /// reason;
    /// [`EnrolmentError::RelayUnreachable`] when no response comes back, and
    /// [`EnrolmentError::BadRelayResponse`] for any other non-success status
    /// or a body that isn't a [`TunnelHost`].
    async fn tunnel_host(
        &self,
        tunnel_name: &TunnelName,
        token: &TunnelToken,
    ) -> Result<TunnelHost, EnrolmentError>;
}

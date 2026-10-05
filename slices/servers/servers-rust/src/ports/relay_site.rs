//! The [`RelaySite`] port: the two requests enrolment makes to a relay's own
//! site.

use rathole_settings_rust::{PublicRatholeSettings, TunnelName};
use serde::Deserialize;
use url::Url;

use crate::domain::{EnrolmentError, TunnelToken};

/// A relay's own HTTPS site, at its base URL (see
/// [`Relay::base_url`](crate::Relay::base_url)). The production adapter is
/// [`ReqwestRelaySite`](crate::ReqwestRelaySite).
///
/// `#[async_trait]` so the base can hold it as an `Arc<dyn RelaySite>`.
#[async_trait::async_trait]
pub trait RelaySite: Send + Sync {
    /// `GET {relay_base}/rathole`: the relay's public rathole settings, as
    /// served.
    ///
    /// # Errors
    ///
    /// [`EnrolmentError::RelayUnreachable`] when no response comes back, and
    /// [`EnrolmentError::BadRelayResponse`] for a non-success status or a body
    /// that isn't [`PublicRatholeSettings`].
    async fn fetch_public_settings(
        &self,
        relay_base: &Url,
    ) -> Result<PublicRatholeSettings, EnrolmentError>;

    /// `GET {relay_base}/me`, signed as `tunnel_name` with `token`: the tunnel
    /// the relay holds that pair for.
    ///
    /// # Errors
    ///
    /// [`EnrolmentError::CredentialsRejected`] when the relay answers `401`,
    /// [`EnrolmentError::RelayUnreachable`] when no response comes back, and
    /// [`EnrolmentError::BadRelayResponse`] for any other non-success status
    /// or a body that isn't a [`TunnelHost`].
    async fn fetch_tunnel_host(
        &self,
        relay_base: &Url,
        tunnel_name: &TunnelName,
        token: &TunnelToken,
    ) -> Result<TunnelHost, EnrolmentError>;
}

/// What the relay's `GET /me` returns: the tunnel that signed, and the
/// hostname visitors reach it at.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
pub struct TunnelHost {
    pub tunnel_name: String,
    /// `<tunnel name>.<domain>`.
    pub public_host: String,
}

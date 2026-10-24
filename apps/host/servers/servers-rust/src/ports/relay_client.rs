//! The [`RelayClient`] port: the requests enrolment makes to a Wildflower
//! relay's own site.

use wildflowerhealthio_rathole_settings::{
    ClaimRequest, ClaimedTunnel, PublicRatholeSettings, TunnelHost, TunnelName,
};

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

    /// `POST {relay base}/claim` with `request`: redeems the claim code,
    /// once, for the tunnel it names, or, with details, for a new tunnel for
    /// their email, named as they ask or by the relay; with its token and
    /// the relay's public settings.
    ///
    /// # Errors
    ///
    /// For a request without details, [`EnrolmentError::ClaimCodeRejected`]
    /// when the relay answers `422`, which it does for every code it won't
    /// redeem, and [`EnrolmentError::ClaimCodeNeedsDetails`] for `409`, a
    /// code that names no tunnel, which it leaves unspent; for one with
    /// details, [`EnrolmentError::ClaimRefused`], with the relay's reason,
    /// for `422`, `409` or `503`, a code it won't redeem or an email or name
    /// it refuses; [`EnrolmentError::ClaimRateLimited`] for `429`;
    /// [`EnrolmentError::ClaimCodesNotOffered`] for `404`, a relay site
    /// without `POST /claim`;
    /// [`EnrolmentError::RelayUnreachable`] when no response comes back, and
    /// [`EnrolmentError::BadRelayResponse`] for any other non-success status
    /// or a body that isn't a [`ClaimedTunnel`].
    async fn claim(&self, request: &ClaimRequest) -> Result<ClaimedTunnel, EnrolmentError>;
}

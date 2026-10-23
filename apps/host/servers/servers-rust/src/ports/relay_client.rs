//! The [`RelayClient`] port: the requests enrolment makes to a Wildflower
//! relay's own site.

use wildflowerhealthio_rathole_settings::{
    AccessRequest, ClaimedTunnel, PublicRatholeSettings, TunnelHost, TunnelName,
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

    /// `POST {relay base}/claim` with `{"code": code}`: redeems the claim
    /// code, once, for the tunnel it was issued for, its token and the
    /// relay's public settings.
    ///
    /// # Errors
    ///
    /// [`EnrolmentError::ClaimCodeRejected`] when the relay answers `422`,
    /// which it does for every code it won't redeem;
    /// [`EnrolmentError::AccessCodeNeedsDetails`] for `409`, an access code,
    /// which it leaves unspent;
    /// [`EnrolmentError::ClaimRateLimited`] for `429`;
    /// [`EnrolmentError::ClaimCodesNotOffered`] for `404`, a relay site
    /// without `POST /claim`;
    /// [`EnrolmentError::RelayUnreachable`] when no response comes back, and
    /// [`EnrolmentError::BadRelayResponse`] for any other non-success status
    /// or a body that isn't a [`ClaimedTunnel`].
    async fn claim(&self, code: &str) -> Result<ClaimedTunnel, EnrolmentError>;

    /// `POST {relay base}/access` with `request`: redeems the access code,
    /// once, for a new tunnel for the email, named as requested or by the
    /// relay, its token and the relay's public settings.
    ///
    /// # Errors
    ///
    /// [`EnrolmentError::AccessRefused`], with the relay's reason, when it
    /// answers `422`, `409` or `503`: for a code it won't redeem, or an
    /// email or name it refuses;
    /// [`EnrolmentError::ClaimRateLimited`] for `429`;
    /// [`EnrolmentError::ClaimCodesNotOffered`] for `404`, a relay site
    /// without `POST /access`;
    /// [`EnrolmentError::RelayUnreachable`] when no response comes back, and
    /// [`EnrolmentError::BadRelayResponse`] for any other non-success status
    /// or a body that isn't a [`ClaimedTunnel`].
    async fn access(&self, request: &AccessRequest) -> Result<ClaimedTunnel, EnrolmentError>;
}

//! Read models the Owner UI renders — the data shapes the `GET` consent
//! handlers return, produced by the [`ConsentReader`](crate::http::capabilities::ConsentReader)
//! capability. A separate home from [`crate::http::capabilities`] so the
//! capability modules stay purely capability-shaped (gate + delegation), and a
//! new view never has to masquerade as a capability.

use crate::domain::authorization_request::AuthorizationRequest;

/// A consent prompt loaded for the Owner UI to render — the data a `GET`
/// authorization-code consent handler needs, with the client's display name
/// already resolved.
pub(crate) struct OAuthConsentView {
    pub(crate) request: AuthorizationRequest,
    pub(crate) redirect_uri: url::Url,
    pub(crate) client_name: String,
}

/// A device-code consent prompt loaded for the Owner UI — adds the client's
/// full `allowed_scopes` (the expansion envelope the approver may grant up to).
pub(crate) struct DeviceConsentView {
    pub(crate) request: AuthorizationRequest,
    pub(crate) client_name: String,
    pub(crate) allowed_scopes: Vec<String>,
}

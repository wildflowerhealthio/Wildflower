//! Wire shapes shared by the two Owner consent surfaces —
//! `/oauth-consents/{id}` (authorization-code flow) and `/devices/{userCode}`
//! (device-code flow, RFC 8628). The two flows differ in how they load a
//! pending request and in what an approval mints, but they agree on the JSON
//! the Owner UI posts ([`ApproveBody`]) and reads back ([`ConsentResult`]).
//! Keeping the shapes in one place stops the two route trees from drifting.

use serde::{Deserialize, Serialize};

/// Body posted by the Owner UI to approve a consent prompt: the scopes the
/// Owner ticked, plus an optional patient context to bind to the grant. The
/// device flow sends no `patient` today, so it deserializes to `None`; the
/// field is shared in anticipation of device-flow patient selection.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ApproveBody {
    pub(crate) approved_scopes: Vec<String>,
    pub(crate) patient: Option<String>,
    /// An optional adjusted device name (device flow only — the settings approver
    /// renaming the device before approving). `None` on the code-flow path and
    /// when the approver didn't change it; `COALESCE`d server-side so the stored
    /// name is preserved.
    #[serde(default)]
    pub(crate) device_name: Option<String>,
}

/// Result the Owner UI sees after approving or denying a consent prompt.
///
/// A code-flow approval carries the client callback URL (`code` + `state`
/// appended to the client's `redirect_uri`) so the approving surface can
/// complete the flow directly when the approver *is* the requesting client —
/// no separate poll of `/oauth/authorize/{id}` needed. Device-flow approvals
/// have no client `redirect_uri`, so `redirect` is `None` and (thanks to
/// `skip_serializing_if`) omitted from the wire entirely.
#[derive(Debug, Serialize)]
#[serde(tag = "status", rename_all = "lowercase")]
pub(crate) enum ConsentResult {
    Approved {
        #[serde(skip_serializing_if = "Option::is_none")]
        redirect: Option<String>,
    },
    Denied,
}

//! The `/cloud-apps` root resource — cloud apps as their own REST resource, off
//! `/apps` (which keeps only the uniform list + the unified launch/delete). One
//! file per operation: `get` (`GET /cloud-apps/{id}`), `create`
//! (`POST /cloud-apps`), `update` (`PUT /cloud-apps/{id}`), all returning the
//! [`CloudAppDetail`](crate::http::wire_representations::CloudAppDetail) shape. A JSON create body —
//! no multipart, no `requiresTunnel`-as-text hack. A path given an id that isn't a
//! cloud app is a `404` (the kind mismatch can't be expressed).

pub(crate) mod create;
pub(crate) mod get;
pub(crate) mod update;

use serde::Deserialize;
use utoipa::ToSchema;

/// The JSON body shared by `POST /cloud-apps` (create) and `PUT /cloud-apps/{id}`
/// (content replace): a cloud app's editable content. `url` is read as a raw string
/// so a bad value yields the structured `400 InvalidUrl` rather than a generic
/// deserialize error. Matches the TS `CloudAppBodySchema`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloudAppBody {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) subtitle: Option<String>,
    /// The launch URL template (`{origin}` / `{launch}` tokens), validated to
    /// `400 InvalidUrl` through the write-side [`AppUrl`](crate::domain::AppUrl)
    /// filter.
    pub(crate) url: String,
    pub(crate) requires_tunnel: bool,
}

//! The `/apps` URL-segment routes, one file per operation: `list_all` (`GET /apps`
//! — the registry), `create` (`POST /apps`), `get_by_id` (`GET /apps/{id}`),
//! `update_by_id` (`PUT /apps/{id}`), `delete_by_id` (`DELETE /apps/{id}`), and
//! `launch` (`POST /apps/{id}`). Each file exposes a `#[utoipa::path]`-annotated
//! handler; the route table in [`crate::http::routes`] wires them into the one
//! router.

pub(crate) mod create;
pub(crate) mod delete_by_id;
pub(crate) mod get_by_id;
pub(crate) mod launch;
pub(crate) mod list_all;
pub(crate) mod update_by_id;

use serde::Deserialize;
use utoipa::ToSchema;

/// The JSON body shared by `POST /apps` (create) and `PUT /apps/{id}` (content
/// replace): an app's editable content. `url` is read as a raw string so a bad
/// value yields the structured `400 InvalidUrl` rather than a generic deserialize
/// error. Matches the TS `AppBodySchema`.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct AppBody {
    pub(crate) name: String,
    #[serde(default)]
    pub(crate) subtitle: Option<String>,
    /// The launch URL template (`{origin}` / `{launch}` tokens), validated to
    /// `400 InvalidUrl` through the write-side [`AppUrl`](crate::domain::AppUrl)
    /// filter.
    pub(crate) url: String,
    pub(crate) requires_tunnel: bool,
}

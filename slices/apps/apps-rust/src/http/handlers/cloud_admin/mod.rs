//! The cloud-app mutate route handlers — `create` (`POST /apps`), `update`
//! (`PATCH /apps/{id}`), and `delete` (`DELETE /apps/{id}`). Each exposes a
//! `#[utoipa::path]`-annotated handler; only **cloud** apps are editable here
//! (system / self-hosted ids return `409 AppNotEditable`).
//! [`crate::http::handlers::openapi_router`] collects them into the single
//! `/apps` router.

pub(crate) mod create;
pub(crate) mod delete;
pub(crate) mod update;

use crate::domain::{AppEntry, Provenance};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppsState;

/// The shared editability preamble for the cloud-only mutate handlers
/// (`update`, `delete`): resolve `id` to the cloud [`AppEntry`] it edits, or the
/// matching error — `404 AppNotFound` (unknown id), `409 AppNotEditable`
/// (a system / self-hosted row), or a logged `500` (a cloud parent whose child
/// row is missing — an invariant violation). Keeping "cloud is the editable kind"
/// in one place means a fourth cloud-only endpoint — or a change to which
/// provenances are editable — is a one-line edit here, not a per-handler one.
pub(crate) fn find_editable_cloud_app(
    state: &AppsState,
    id: &str,
) -> Result<AppEntry, HandlerError> {
    let parent = state
        .store
        .find_app(id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .ok_or_else(|| HandlerError::NotFound { id: id.to_owned() })?;
    if parent.provenance != Provenance::Cloud {
        return Err(HandlerError::NotEditable { id: id.to_owned() });
    }
    state
        .store
        .find_cloud_app(id)
        .map_err(|e| HandlerError::internal("find_cloud_app lookup failed", e))?
        .ok_or_else(|| HandlerError::internal("cloud parent has no child row", format!("id={id}")))
}

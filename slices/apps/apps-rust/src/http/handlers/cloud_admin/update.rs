//! `PATCH /apps/{id}` — partial update of a **cloud** app's *content*. Any subset
//! of `name` / `subtitle` / `url` / `requiresTunnel` is honoured; a present `url`
//! is re-parsed. Only cloud apps are editable here: a system / self-hosted id that
//! exists returns `409 AppNotEditable`, an unknown id `404`.
//!
//! `enabled` is **not** edited here — homescreen curation (order + enabled, any
//! provenance) lives on `PUT /home-screen`, the single writer of those fields.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::{AppEntry, AppUrl};
use crate::http::handlers::cloud_admin::find_editable_cloud_app;
use crate::http::response_templates::{
    AppNotEditableBody, AppNotFoundBody, HandlerError, InvalidFieldBody,
};
use crate::http::state::AppsState;

/// PATCH body — all fields optional. Matches `UpdateAppBodySchema`. The
/// `subtitle` tri-state is on [`SubtitlePatch`]. No `enabled`: that's homescreen
/// curation, owned by `PUT /home-screen`.
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateAppBody {
    name: Option<String>,
    url: Option<String>,
    requires_tunnel: Option<bool>,
    #[serde(default, deserialize_with = "deser_present_optional")]
    #[schema(value_type = Option<String>)]
    subtitle: SubtitlePatch,
}

/// Tri-state subtitle patch:
///
///   * `Unchanged` — the key was absent from the body; keep what's stored.
///   * `Set(Some)` — explicit non-empty value; replace.
///   * `Set(None)` — explicit `null` *or* the empty string `""`; clear the
///     subtitle.
///
/// A plain `Option<Option<String>>` would collapse "absent" and "null" into the
/// same `None`, leaving no way to clear the subtitle without touching other
/// fields. Empty collapses into the clear case so it never persists as
/// `Some("")` — the read schemas decode `subtitle` as a non-empty string, so a
/// stored `""` would serialize as `"subtitle": ""` and break the catalogue decode.
#[derive(Debug, Default)]
enum SubtitlePatch {
    #[default]
    Unchanged,
    Set(Option<String>),
}

/// Deserializer that distinguishes "key present but null" from "key absent":
/// `Option::deserialize` returns `None` for null, and the parent's
/// `#[serde(default)]` supplies `Unchanged` for an absent key. Present values
/// project to [`SubtitlePatch::Set`], with an empty string normalized to the
/// clear case so `""` and explicit `null` both clear.
fn deser_present_optional<'de, D>(d: D) -> Result<SubtitlePatch, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(d)
        .map(|subtitle| SubtitlePatch::Set(subtitle.filter(|s| !s.is_empty())))
}

/// `PATCH /apps/{id}` — partial update of a cloud app. Owner-gated by the host.
#[utoipa::path(
    patch,
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    request_body = UpdateAppBody,
    responses(
        (status = 200, description = "The updated cloud app", body = AppEntry),
        (status = 400, description = "Empty name (`InvalidName`) or bad url (`InvalidUrl`)", body = InvalidFieldBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 409, description = "The app exists but is not a cloud app (system / self-hosted apps are not editable)", body = AppNotEditableBody),
    ),
)]
pub(crate) async fn handle_update_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateAppBody>,
) -> Result<Json<AppEntry>, HandlerError> {
    // Resolve existence + editability before validating the patch fields (via the
    // shared cloud-editability seam): a PATCH to an unknown id is a 404, and to a
    // non-cloud id a 409, regardless of whether its body also carries a bad
    // name/url — the missing/not-editable signal isn't masked by a 400. The
    // returned cloud entry is the patch base.
    let mut existing = find_editable_cloud_app(&state, &id)?;

    if let Some(name) = body.name.as_deref() {
        if name.is_empty() {
            return Err(HandlerError::InvalidName {
                message: "name must not be empty".to_owned(),
            });
        }
    }
    let new_url = match body.url.as_deref() {
        Some(url) => Some(
            url.parse::<AppUrl>()
                .map_err(|e| HandlerError::InvalidUrl {
                    message: e.to_string(),
                })?,
        ),
        None => None,
    };

    if let Some(name) = body.name {
        existing.name = name;
    }
    if let Some(url) = new_url {
        existing.url = url;
    }
    if let Some(requires_tunnel) = body.requires_tunnel {
        existing.requires_tunnel = requires_tunnel;
    }
    if let SubtitlePatch::Set(subtitle) = body.subtitle {
        existing.subtitle = subtitle;
    }

    let replaced = state
        .store
        .replace_cloud_app(&existing)
        .map_err(|e| HandlerError::internal("replace_cloud_app failed", e))?;
    if !replaced {
        // We just confirmed a cloud row under the same connection; it can't
        // have vanished. Surface as a logged 500 rather than papering over with
        // a stale value.
        return Err(HandlerError::internal(
            "row vanished between find_cloud_app and replace_cloud_app",
            format!("id={id}"),
        ));
    }
    Ok(Json(existing))
}

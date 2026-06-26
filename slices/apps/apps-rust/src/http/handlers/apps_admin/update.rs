//! `PATCH /apps/{id}` — partial update. Any subset of `enabled` / `name` /
//! `subtitle` / `url` / `requiresTunnel` is honoured; a present `url` is
//! re-parsed. Works on any row — every app is equally editable.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::{AppEntry, AppUrl};
use crate::http::response_templates::{AppNotFoundBody, HandlerError, InvalidFieldBody};
use crate::http::state::AppsState;

/// PATCH body — all fields optional. Matches `UpdateAppBodySchema`. A
/// `subtitle` of explicit `null` *or* the empty string `""` clears the
/// subtitle; a missing key leaves it alone — see [`SubtitlePatch`].
#[derive(Debug, Default, Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateAppBody {
    enabled: Option<bool>,
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

/// `PATCH /apps/{id}` — partial update of any row. Owner-gated by the consumer.
#[utoipa::path(
    patch,
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    request_body = UpdateAppBody,
    responses(
        (status = 200, description = "The updated app", body = AppEntry),
        (status = 400, description = "Empty name (`InvalidName`) or bad url (`InvalidUrl`)", body = InvalidFieldBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_update_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
    Json(body): Json<UpdateAppBody>,
) -> Result<Json<AppEntry>, HandlerError> {
    // Resolve existence before validating the patch fields: a PATCH to an
    // unknown id is a 404 regardless of whether its body also carries a bad
    // name/url, so the missing-resource signal isn't masked by a 400.
    let mut existing = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;

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

    if let Some(enabled) = body.enabled {
        existing.enabled = enabled;
    }
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
        .replace_app(&existing)
        .map_err(|e| HandlerError::internal("replace_app failed", e))?;
    if !replaced {
        // We just read the row under the same connection lock; it can't
        // have vanished. Surface as a logged 500 rather than papering
        // over with a stale value.
        return Err(HandlerError::internal(
            "row vanished between find_app and replace_app",
            format!("id={id}"),
        ));
    }
    Ok(Json(existing))
}

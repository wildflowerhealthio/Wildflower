//! `PATCH /apps/{id}` — partial update. Any subset of `enabled` / `name` /
//! `subtitle` / `url` / `requiresTunnel` is honoured; a present `url` is
//! re-validated. Works on any row regardless of `kind` — bundled and
//! custom apps are equally editable.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::routing::{patch, MethodRouter};
use axum::Json;
use serde::Deserialize;

use crate::domain::{validate_app_url, AppEntry};
use crate::http::response_templates::HandlerError;
use crate::http::state::AppsState;

/// PATCH body — all fields optional. Matches `UpdateAppBodySchema`. A
/// `subtitle` of `Some(None)` (explicit null on the wire) clears the
/// subtitle; a missing key leaves it alone — see [`SubtitlePatch`].
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UpdateAppBody {
    enabled: Option<bool>,
    name: Option<String>,
    url: Option<String>,
    requires_tunnel: Option<bool>,
    #[serde(default, deserialize_with = "deser_present_optional")]
    subtitle: SubtitlePatch,
}

/// Tri-state subtitle patch:
///
///   * `Unchanged` — the key was absent from the body; keep what's stored.
///   * `Set(Some)` — explicit non-null value; replace.
///   * `Set(None)` — explicit `null`; clear the subtitle.
///
/// Without this, a plain `Option<Option<String>>` would collapse "absent"
/// and "null" into the same `None`, and we'd have no way to ask the
/// handler "clear the subtitle without touching anything else."
#[derive(Debug, Default)]
enum SubtitlePatch {
    #[default]
    Unchanged,
    Set(Option<String>),
}

/// Deserializer that distinguishes "key present but null" from "key
/// absent". `Option::deserialize` returns `None` for null; without the
/// `#[serde(default)]` on the parent, an absent key would error. We
/// always read the body through `Option<Option<T>>`-shaped wrapper and
/// project to [`SubtitlePatch`] — `Some(value)` means the key was
/// present.
fn deser_present_optional<'de, D>(d: D) -> Result<SubtitlePatch, D::Error>
where
    D: serde::Deserializer<'de>,
{
    Option::<String>::deserialize(d).map(SubtitlePatch::Set)
}

pub(super) fn route() -> MethodRouter<Arc<AppsState>> {
    patch(handle_update_app)
}

async fn handle_update_app(
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
    if let Some(url) = body.url.as_deref() {
        validate_app_url(url).map_err(|e| HandlerError::InvalidUrl {
            message: e.to_string(),
        })?;
    }

    if let Some(enabled) = body.enabled {
        existing.enabled = enabled;
    }
    if let Some(name) = body.name {
        existing.name = name;
    }
    if let Some(url) = body.url {
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

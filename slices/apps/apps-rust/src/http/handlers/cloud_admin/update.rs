//! `PUT /apps/{id}` — replace an editable app's *content*.
//!
//! The body is a **`provenance`-discriminated union** ([`AppContentBody`]) whose
//! arm must match the stored app's kind:
//!
//!   * **cloud** — `name` / `subtitle` / `url` / `requiresTunnel` (a full
//!     replace; the `url` is re-parsed through the write-side filter).
//!   * **self-hosted** — `launchPath`, the SMART launch path (see
//!     [`SelfHostedAppRow::launch_path`]); an absent / empty value clears it back to
//!     root-serving. Seeded (migration) rows are protected.
//!
//! The response is the refreshed catalogue [`AppListEntry`] (the same
//! `provenance` union `GET /apps` returns), read back after the write so it can't
//! drift from the projection.
//!
//! An unknown id is `404`; a system app, a seeded self-hosted app, or a
//! body whose arm doesn't match the stored provenance is `409 AppNotEditable`; a
//! bad name / url / launch path is `400`.
//!
//! `enabled` is **not** replaced here — homescreen curation (order + enabled, any
//! provenance) lives on `PUT /home-screen`, the single writer of those fields; a
//! content replace preserves the stored `enabled`.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::{App, AppListEntry, AppUrl, CloudAppRow, Provenance};
use crate::http::response_templates::{
    AppNotEditableBody, AppNotFoundBody, HandlerError, InvalidFieldBody,
};
use crate::http::state::AppsState;

/// `PUT /apps/{id}` body — a `provenance`-discriminated union matching the TS
/// `AppContentBodySchema`. Only the editable kinds have an arm (system apps are
/// never editable). `url` is read as a raw string so a bad value yields the
/// structured `400 InvalidUrl` rather than a generic deserialize error.
#[derive(Debug, Deserialize, ToSchema)]
#[serde(tag = "provenance", rename_all = "kebab-case")]
pub(crate) enum AppContentBody {
    /// Full replace of a cloud app's content.
    #[serde(rename_all = "camelCase")]
    Cloud {
        name: String,
        #[serde(default)]
        subtitle: Option<String>,
        url: String,
        requires_tunnel: bool,
    },
    /// Replace a self-hosted app's launch path (absent / empty → root-served).
    #[serde(rename_all = "camelCase")]
    SelfHosted {
        #[serde(default)]
        launch_path: Option<String>,
    },
}

/// `PUT /apps/{id}` — replace an editable app's content. Owner-gated by the host.
#[utoipa::path(
    put,
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    request_body = AppContentBody,
    responses(
        (status = 200, description = "The updated app (the provenance-tagged catalogue entry)", body = AppListEntry),
        (status = 400, description = "Empty name (`InvalidName`) or bad url/launch path (`InvalidUrl`)", body = InvalidFieldBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
        (status = 409, description = "Not editable: a system app, a seeded self-hosted app, or a body whose provenance doesn't match the stored app", body = AppNotEditableBody),
    ),
)]
pub(crate) async fn handle_replace_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
    Json(body): Json<AppContentBody>,
) -> Result<Json<AppListEntry>, HandlerError> {
    // Resolve existence before validating any field: a PUT to an unknown id is a
    // 404 regardless of the body. Then require the body's arm to match the stored
    // kind (a mismatch — or a system app — is `409`, not a silent no-op).
    let parent = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;

    match (parent.provenance, body) {
        (
            Provenance::Cloud,
            AppContentBody::Cloud {
                name,
                subtitle,
                url,
                requires_tunnel,
            },
        ) => {
            replace_cloud_content(&state, &id, name, subtitle, url, requires_tunnel)?;
        }
        (Provenance::SelfHosted, AppContentBody::SelfHosted { launch_path }) => {
            replace_self_hosted_content(&state, &parent, launch_path)?;
        }
        // A system app, or a body targeting the wrong kind for this id.
        _ => return Err(HandlerError::NotEditable { id }),
    }

    // Read back the exact `GET /apps` projection so the response reflects the
    // stored state (correct variant, computed `smart` / `removable`).
    let entry = state
        .store
        .find_app_entry(&id)
        .map_err(|e| HandlerError::internal("find_app_entry after replace failed", e))?
        .ok_or_else(|| {
            HandlerError::internal(
                "app vanished between replace and read-back",
                format!("id={id}"),
            )
        })?;
    Ok(Json(entry))
}

/// Full-replace a cloud app's content (`enabled` preserved — it isn't edited
/// here). Validates the name is non-empty and the url parses through the
/// write-side [`AppUrl`] filter.
fn replace_cloud_content(
    state: &AppsState,
    id: &str,
    name: String,
    subtitle: Option<String>,
    url: String,
    requires_tunnel: bool,
) -> Result<(), HandlerError> {
    if name.is_empty() {
        return Err(HandlerError::InvalidName {
            message: "name must not be empty".to_owned(),
        });
    }
    let url = url
        .parse::<AppUrl>()
        .map_err(|e| HandlerError::InvalidUrl {
            message: e.to_string(),
        })?;
    // Preserve `enabled` (homescreen-owned) by reading it back onto the replace.
    let existing = state
        .store
        .find_cloud_app(id)
        .map_err(|e| HandlerError::internal("find_cloud_app lookup failed", e))?
        .ok_or_else(|| {
            HandlerError::internal("cloud parent has no child row", format!("id={id}"))
        })?;
    let replaced = state
        .store
        .replace_cloud_app(&CloudAppRow {
            id: id.to_owned(),
            enabled: existing.enabled,
            name,
            // Empty `""` clears the subtitle.
            subtitle: subtitle.filter(|s| !s.is_empty()),
            url,
            requires_tunnel,
        })
        .map_err(|e| HandlerError::internal("replace_cloud_app failed", e))?;
    if !replaced {
        return Err(HandlerError::internal(
            "cloud row vanished between find and replace",
            format!("id={id}"),
        ));
    }
    Ok(())
}

/// Replace a self-hosted app's launch path. A seeded (migration) row is protected
/// (`409 AppNotEditable`, same as delete); a non-empty path must be
/// origin-relative.
fn replace_self_hosted_content(
    state: &AppsState,
    parent: &App,
    launch_path: Option<String>,
) -> Result<(), HandlerError> {
    let child = state
        .store
        .find_self_hosted_app(&parent.id)
        .map_err(|e| HandlerError::internal("find_self_hosted_app lookup failed", e))?
        .ok_or_else(|| {
            HandlerError::internal(
                "self-hosted parent has no child row",
                format!("id={}", parent.id),
            )
        })?;
    if child.seeded {
        return Err(HandlerError::NotEditable {
            id: parent.id.clone(),
        });
    }
    let launch_path = validate_launch_path(launch_path)?;
    let updated = state
        .store
        .update_self_hosted_launch_path(&parent.id, launch_path.as_deref())
        .map_err(|e| HandlerError::internal("update_self_hosted_launch_path failed", e))?;
    if !updated {
        return Err(HandlerError::internal(
            "self-hosted row vanished between find and update",
            format!("id={}", parent.id),
        ));
    }
    Ok(())
}

/// Validate a `launchPath` value. A cleared value (`None` / empty) passes through
/// as `None`. A non-empty path must be origin-relative — start with a single `/`
/// (not `//`, a protocol-relative authority) — so it hangs safely off the app's
/// own origin at launch; anything else is a `400 InvalidUrl`.
fn validate_launch_path(value: Option<String>) -> Result<Option<String>, HandlerError> {
    match value.filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(path) if path.starts_with('/') && !path.starts_with("//") => Ok(Some(path)),
        Some(_) => Err(HandlerError::InvalidUrl {
            message: "launch path must be an origin-relative /path".to_owned(),
        }),
    }
}

//! `PUT /apps/{id}` — replace an editable app's *content*.
//!
//! The body is a **`provenance`-discriminated union** ([`AppContentBody`]) whose
//! arm must match the stored app's kind:
//!
//!   * **cloud** — `name` / `subtitle` / `url` / `requiresTunnel` (a full
//!     replace; the `url` is re-parsed through the write-side filter).
//!   * **self-hosted** — `launchPath`, the SMART launch path (see
//!     [`SelfHostedApp::launch_path`](crate::domain::SelfHostedApp::launch_path));
//!     an absent / empty value clears it back to root-serving. Seeded
//!     (migration) rows are protected.
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

use crate::domain::{AppKind, AppListEntry, AppUrl, CloudContent};
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
    // kind (a mismatch — or a system app — is `409`, not a silent no-op). The
    // whole `App` is in hand, so the seeded check reads straight off its payload;
    // each store replace hands back the updated `App` read inside its own
    // transaction, and projecting it is exactly the `GET /apps` shape.
    let app = state
        .store
        .find_app(&id)
        .map_err(|e| HandlerError::internal("find_app lookup failed", e))?
        .ok_or_else(|| HandlerError::NotFound { id: id.clone() })?;

    let updated = match (&app.kind, body) {
        (
            AppKind::Cloud(_),
            AppContentBody::Cloud {
                name,
                subtitle,
                url,
                requires_tunnel,
            },
        ) => {
            let content = validate_cloud_content(name, subtitle, url, requires_tunnel)?;
            state
                .store
                .replace_cloud_content(&id, &content)
                .map_err(|e| HandlerError::internal("replace_cloud_content failed", e))?
        }
        (AppKind::SelfHosted(child), AppContentBody::SelfHosted { launch_path }) => {
            if child.seeded {
                // A migration-seeded app (patient-browser) is read-only, same
                // 409 as delete.
                return Err(HandlerError::NotEditable { id });
            }
            let launch_path = validate_launch_path(launch_path)?;
            state
                .store
                .replace_self_hosted_launch_path(&id, launch_path.as_deref())
                .map_err(|e| HandlerError::internal("replace_self_hosted_launch_path failed", e))?
        }
        // A system app, or a body targeting the wrong kind for this id.
        _ => return Err(HandlerError::NotEditable { id }),
    };
    let updated = updated.ok_or_else(|| {
        HandlerError::internal("app vanished between find and replace", format!("id={id}"))
    })?;
    Ok(Json(AppListEntry::from(&updated)))
}

/// Validate a cloud replace body into the store's [`CloudContent`] spec: the
/// name must be non-empty and the url must parse through the write-side
/// [`AppUrl`] filter. `enabled` has no place here — homescreen curation owns
/// it, and the store's content replace never writes that column.
fn validate_cloud_content(
    name: String,
    subtitle: Option<String>,
    url: String,
    requires_tunnel: bool,
) -> Result<CloudContent, HandlerError> {
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
    Ok(CloudContent {
        name,
        // Empty `""` clears the subtitle.
        subtitle: subtitle.filter(|s| !s.is_empty()),
        url,
        requires_tunnel,
    })
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

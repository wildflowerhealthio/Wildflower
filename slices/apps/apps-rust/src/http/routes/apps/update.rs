//! `PUT /apps/{id}` — replace an editable app's *content*. The body is a
//! **`provenance`-discriminated union** ([`AppContentBody`]) whose arm must match
//! the stored app's kind:
//!
//!   * **cloud** — full replace of `name` / `subtitle` / `url` / `requiresTunnel`
//!     (the `url` is re-parsed through the write-side filter);
//!   * **self-hosted** — `launchPath`; an absent / empty value clears it back to
//!     root-serving.
//!
//! An unknown id is `404`; a system app, a seeded self-hosted app, or a body arm
//! that doesn't match the stored kind is `409 AppNotEditable`; a bad name / url /
//! launch path is `400`. `enabled` is **not** content — `PUT /home-screen` owns
//! it. The response is the refreshed [`AppListEntry`], read back in-txn. See
//! `docs/Apps/Explanation.md` §"Editing app content".

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::db::CloudContent;
use crate::domain::{App, AppError, AppListEntry, AppUrl};
use crate::http::errors::{AppNotEditableBody, AppNotFoundBody, InvalidFieldBody};
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
    tag = "Catalogue",
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
) -> Result<Json<AppListEntry>, AppError> {
    // Resolve existence before validating any field: a PUT to an unknown id is a
    // 404 regardless of the body. Then require the body's arm to match the stored
    // kind (a mismatch — or a system app — is `409`, not a silent no-op); the
    // whole `App` is in hand, so the seeded check reads straight off its record.
    let app = state
        .store
        .find_app(&id)?
        .ok_or_else(|| AppError::NotFound { id: id.clone() })?;

    let updated = match (&app, body) {
        (
            App::Cloud { .. },
            AppContentBody::Cloud {
                name,
                subtitle,
                url,
                requires_tunnel,
            },
        ) => {
            let content = validate_cloud_content(name, subtitle, url, requires_tunnel)?;
            state.store.replace_cloud_content(&id, &content)?
        }
        (App::SelfHosted { app: child, .. }, AppContentBody::SelfHosted { launch_path }) => {
            if child.seeded {
                // A migration-seeded app (patient-browser) is read-only, same
                // 409 as delete.
                return Err(AppError::NotEditable { id });
            }
            let launch_path = validate_launch_path(launch_path)?;
            state
                .store
                .replace_self_hosted_launch_path(&id, launch_path.as_deref())?
        }
        // A system app, or a body targeting the wrong kind for this id.
        _ => return Err(AppError::NotEditable { id }),
    };
    let updated = updated.ok_or_else(|| {
        AppError::backend("app vanished between find and replace", format!("id={id}"))
    })?;
    Ok(Json(AppListEntry::from(&updated)))
}

/// Validate a cloud replace body into the store's [`CloudContent`] spec: the name
/// must be non-empty and the url must parse through the write-side [`AppUrl`]
/// filter. `enabled` has no place here — homescreen curation owns it.
fn validate_cloud_content(
    name: String,
    subtitle: Option<String>,
    url: String,
    requires_tunnel: bool,
) -> Result<CloudContent, AppError> {
    if name.is_empty() {
        return Err(AppError::InvalidName {
            message: "name must not be empty".to_owned(),
        });
    }
    let url = url.parse::<AppUrl>().map_err(|e| AppError::InvalidUrl {
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
fn validate_launch_path(value: Option<String>) -> Result<Option<String>, AppError> {
    match value.filter(|s| !s.is_empty()) {
        None => Ok(None),
        Some(path) if path.starts_with('/') && !path.starts_with("//") => Ok(Some(path)),
        Some(_) => Err(AppError::InvalidUrl {
            message: "launch path must be an origin-relative /path".to_owned(),
        }),
    }
}

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

use crate::domain::actions::{self, ContentUpdate};
use crate::domain::{AppError, AppListEntry};
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
    // The wire union is decoded here; the domain action holds the semantics —
    // existence (404), editability / kind-match (409), and field validation (400),
    // in that order (see `crate::domain::actions::replace_app_content`).
    let update = match body {
        AppContentBody::Cloud {
            name,
            subtitle,
            url,
            requires_tunnel,
        } => ContentUpdate::Cloud {
            name,
            subtitle,
            url,
            requires_tunnel,
        },
        AppContentBody::SelfHosted { launch_path } => ContentUpdate::SelfHosted { launch_path },
    };
    let updated = actions::replace_app_content(&state.store, &id, update)?;
    Ok(Json(AppListEntry::from(&updated)))
}

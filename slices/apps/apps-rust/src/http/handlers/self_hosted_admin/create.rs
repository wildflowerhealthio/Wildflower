//! `POST /self-hosted-apps` — install an uploaded self-hosted app bundle.
//!
//! The body is the raw `application/zip` (no multipart), the app name rides the
//! `?name=` query param. The flow, in order, is careful to never leave a
//! half-installed app behind:
//!
//! 1. slug the name (empty → `400 InvalidName`);
//! 2. extract the zip into a private staging dir under the apps root, on a
//!    blocking thread (bad zip → `400 InvalidZip`, disk error → `500`; staging
//!    is removed on any failure);
//! 3. insert the DB row (allocating a unique slug + a free port); a slug clash
//!    past the retry budget → `400 InvalidName`;
//! 4. atomically rename staging into `<apps_dir>/<slug>` — on failure, roll the
//!    row back so no registry entry points at absent files;
//! 5. `start` the listener. A bind failure here is tolerated (logged, not
//!    surfaced): the row is committed and the app comes up on the next restart,
//!    so we never fail the request *after* the DB commit.
//!
//! Returns the new [`AppListEntry`] so the editor can render the tile without a
//! re-list.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use utoipa::IntoParams;

use crate::domain::{AppKind, AppListEntry, NewSelfHostedUpload};
use crate::http::response_templates::{HandlerError, InvalidFieldBody};
use crate::http::state::AppsState;
use crate::id::mint_app_id;
use crate::install::{self, extract_zip_bundle, infer_launch_path, slugify};

/// Query params for the upload route — just the human app name, slugged into the
/// id/subdomain server-side.
#[derive(Debug, Deserialize, IntoParams)]
#[into_params(parameter_in = Query)]
pub(crate) struct CreateSelfHostedAppParams {
    /// Human app name; also the source of the slugged id/subdomain.
    name: String,
}

/// `POST /self-hosted-apps` — install an uploaded zip bundle. Owner-gated by the
/// host; the body limit is raised to 64 MiB for just this route.
#[utoipa::path(
    post,
    path = "/self-hosted-apps",
    params(CreateSelfHostedAppParams),
    request_body(
        content = Vec<u8>,
        content_type = "application/zip",
        description = "The app's static files as a zip archive",
    ),
    responses(
        (status = 200, description = "The installed self-hosted app", body = AppListEntry),
        (status = 400, description = "Empty/unusable name (`InvalidName`) or a bad bundle (`InvalidZip`)", body = InvalidFieldBody),
    ),
)]
pub(crate) async fn handle_create_self_hosted_app(
    State(state): State<Arc<AppsState>>,
    Query(params): Query<CreateSelfHostedAppParams>,
    body: Bytes,
) -> Result<Json<AppListEntry>, HandlerError> {
    let slug = slugify(&params.name).ok_or_else(|| HandlerError::InvalidName {
        message: "name must contain at least one letter or digit".to_owned(),
    })?;

    let apps_dir = state.self_hosted.apps_dir().to_path_buf();
    // A private, collision-free staging dir; a fresh mint per upload so two
    // concurrent installs can't stage into the same path.
    let staging = apps_dir.join(".staging").join(mint_app_id());

    // Extract off the async runtime — zip inflate + disk writes are blocking.
    // The same blocking task infers the launch path from the extracted (and
    // hoisted) tree, so the `launch.html` probe rides the same off-runtime hop.
    let bytes = body.to_vec();
    let staging_for_extract = staging.clone();
    let extract = tokio::task::spawn_blocking(move || {
        extract_zip_bundle(&bytes, &staging_for_extract)
            .map(|()| infer_launch_path(&staging_for_extract))
    })
    .await;
    let launch_path = match extract {
        Ok(Ok(path)) => path,
        Ok(Err(error)) => {
            remove_staging(&staging);
            return Err(map_install_error(error));
        }
        Err(join_error) => {
            remove_staging(&staging);
            return Err(HandlerError::internal(
                "zip extraction task failed",
                join_error,
            ));
        }
    };

    // The host's own loopback port is reserved so an upload never binds over it.
    let upload = NewSelfHostedUpload {
        name: params.name.clone(),
        subtitle: None,
        base_slug: slug,
        reserved_ports: state.loopback_base_url.port().into_iter().collect(),
        launch_path,
    };
    let app = match state.store.insert_self_hosted_app(&upload) {
        Ok(Some(app)) => app,
        Ok(None) => {
            remove_staging(&staging);
            return Err(HandlerError::InvalidName {
                message: "could not allocate a unique id for this name".to_owned(),
            });
        }
        Err(error) => {
            remove_staging(&staging);
            return Err(HandlerError::internal(
                "insert_self_hosted_app failed",
                error,
            ));
        }
    };
    // The insert just built this app as self-hosted; anything else is a store
    // bug surfaced as a logged 500, never a panic.
    let AppKind::SelfHosted(child) = &app.kind else {
        return Err(HandlerError::internal(
            "insert_self_hosted_app returned a non-self-hosted app",
            app.id,
        ));
    };

    // Move the staged files into their serving location. On failure, roll the
    // row back so the registry never lists an app whose files aren't present.
    let dest = apps_dir.join(&child.content_folder);
    if let Err(error) = std::fs::rename(&staging, &dest) {
        if let Err(rollback) = state.store.delete_app(&app.id) {
            tracing::error!(%rollback, app = %app.id, "failed to roll back a self-hosted row after a rename failure");
        }
        remove_staging(&staging);
        return Err(HandlerError::internal(
            "failed to move the staged app into place",
            error,
        ));
    }

    // Bring it online now — but a bind failure here must NOT fail the request:
    // the row is committed and the files are in place, so the app comes up on
    // the next restart regardless.
    if let Err(error) = state.self_hosted.start(&app.id, child).await {
        tracing::warn!(%error, app = %app.id, "installed self-hosted app failed to start; it will come up on restart");
    }

    // The returned `App` was read back inside the insert's own transaction, so
    // projecting it is exactly the `GET /apps` shape (the self-hosted variant,
    // with the install-inferred `launchPath`).
    Ok(Json(AppListEntry::from(&app)))
}

/// Map an extraction failure to the wire error: a disk-write failure is our
/// fault (`500`), every other variant is a bad upload (`400 InvalidZip`).
fn map_install_error(error: install::InstallError) -> HandlerError {
    match error {
        install::InstallError::Io(io_error) => {
            HandlerError::internal("zip extraction io error", io_error)
        }
        other => HandlerError::InvalidZip {
            message: other.to_string(),
        },
    }
}

/// Best-effort removal of a staging directory after a failed install. A cleanup
/// failure is logged, not surfaced — the request already has its real error.
fn remove_staging(staging: &std::path::Path) {
    if let Err(error) = std::fs::remove_dir_all(staging) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %staging.display(), "failed to clean up an install staging dir");
        }
    }
}

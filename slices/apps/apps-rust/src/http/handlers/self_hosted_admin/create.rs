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
//! 3. rename staging into `<apps_dir>/<mint>` — the mint id that becomes the
//!    row's `content_folder`. Fresh per upload, so the rename target can't be
//!    a leftover dir from a failed delete, and a crash after this point leaks
//!    only an unreferenced folder, never a row without files;
//! 4. insert the DB row (allocating a unique slug + the lowest free port); a
//!    slug clash past the retry budget → `400 InvalidName`, port-space
//!    exhaustion → `500` (a server fault, not a name problem) — either way the
//!    moved folder is removed again;
//! 5. `start` the listener. A bind failure is tolerated inside `start` (the
//!    row is committed and the files are in place, so the app comes up on the
//!    next restart); a poisoned-lock failure — the proxy registration didn't
//!    happen and won't self-heal — surfaces as a `500`.
//!
//! Returns the new [`AppListEntry`] so the editor can render the tile without a
//! re-list.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Query, State};
use axum::Json;
use serde::Deserialize;
use utoipa::IntoParams;

use crate::domain::{AppKind, AppListEntry, NewSelfHostedUpload, UploadInsertError};
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
    // A fresh mint per upload names BOTH the private staging dir and the final
    // serving folder (the row's `content_folder`). Because the mint is unique
    // per install, the final folder can never collide with a leftover from a
    // failed delete — and the files can move into place *before* the row is
    // committed, so a committed row always points at present files.
    let folder = mint_app_id();
    let staging = apps_dir.join(".staging").join(&folder);

    // Extract off the async runtime — zip inflate + disk writes are blocking.
    // The same blocking task infers the launch path from the extracted (and
    // hoisted) tree, so the `launch.html` probe rides the same off-runtime hop.
    // `Bytes` already owns the buffer and is Send — move it, don't copy it (a
    // `to_vec` would momentarily double a max-size 64 MiB upload).
    let bytes = body;
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

    // Move the extracted files into their serving location BEFORE the DB
    // insert — the mint-named destination is fresh, so the rename can't hit a
    // non-empty dir (`ENOTEMPTY`), and no committed row can ever point at
    // absent files. A crash right after this leaks only an unreferenced
    // folder (no row → never served), not a broken registry entry.
    let dest = apps_dir.join(&folder);
    if let Err(error) = std::fs::rename(&staging, &dest) {
        remove_staging(&staging);
        return Err(HandlerError::internal(
            "failed to move the staged app into place",
            error,
        ));
    }

    // The host's own loopback port is reserved so an upload never binds over it.
    let upload = NewSelfHostedUpload {
        name: params.name.clone(),
        subtitle: None,
        base_slug: slug,
        content_folder: folder,
        reserved_ports: state.loopback_base_url.port().into_iter().collect(),
        launch_path,
    };
    let app = match state.store.insert_self_hosted_app(&upload) {
        Ok(Ok(app)) => app,
        Ok(Err(UploadInsertError::SlugSpaceExhausted)) => {
            remove_staging(&dest);
            return Err(HandlerError::InvalidName {
                message: "could not allocate a unique id for this name".to_owned(),
            });
        }
        Ok(Err(UploadInsertError::PortSpaceExhausted)) => {
            remove_staging(&dest);
            // A server resource fault, not a name problem — retrying with a
            // different name can't help, so it must not read as a 400.
            return Err(HandlerError::internal(
                "no free loopback port for a new self-hosted app",
                "port space exhausted",
            ));
        }
        Err(error) => {
            remove_staging(&dest);
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

    // Bring it online now. `start` swallows bind failures internally (the row
    // is committed and the files are in place, so the app comes up on the next
    // restart) — the only error it propagates is a poisoned shared lock, where
    // the reverse-proxy registration did NOT happen and won't self-heal on
    // restart. That is a real fault: surface it rather than report success.
    if let Err(error) = state.self_hosted.start(&app.id, child).await {
        return Err(HandlerError::internal(
            "installed self-hosted app failed to register",
            error,
        ));
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

/// Best-effort removal of a failed install's directory (the staging dir, or
/// the already-moved serving folder when the DB insert is what failed). A
/// cleanup failure is logged, not surfaced — the request already has its real
/// error.
fn remove_staging(dir: &std::path::Path) {
    if let Err(error) = std::fs::remove_dir_all(dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %dir.display(), "failed to clean up a failed install's directory");
        }
    }
}

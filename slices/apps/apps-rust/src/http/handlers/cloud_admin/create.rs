//! `POST /apps` — register a new app, cloud or self-hosted. The body is
//! `multipart/form-data` discriminated on `provenance` (mirroring the
//! `PUT /apps/{id}` replace union):
//!
//!   * **cloud** — `name`, `url` (parsed through the write-side [`AppUrl`] filter
//!     so an open redirect never lands in the row), `requiresTunnel` (the text
//!     `"true"` / `"false"`), optional `subtitle`;
//!   * **self-hosted** — `name`, optional `subtitle`, and the uploaded `bundle`
//!     (a zip). Runs the staged install (extract → move → insert → start) — see
//!     `docs/Apps/Store and Install Explanation.md` §"The self-hosted upload
//!     pipeline".
//!
//! Form fields cross the wire as text and the file rides its own part, so the
//! handler reads the [`Multipart`] parts by hand ([`CreateAppMultipart`]
//! documents the shape for OpenAPI). Both arms return the new catalogue
//! [`AppListEntry`], read back in-txn, so the editor renders the tile without a
//! re-list.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Multipart, State};
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::db::{CloudContent, NewCloudApp, NewSelfHostedUpload, UploadInsertError};
use crate::domain::{AppKind, AppListEntry, AppUrl};
use crate::http::response_templates::{HandlerError, InvalidFieldBody};
use crate::http::state::AppsState;
use crate::id::mint_app_id;
use crate::install::{self, extract_zip_bundle, infer_launch_path, slugify};

/// Documents the `multipart/form-data` body for OpenAPI. The handler reads the
/// parts manually via [`Multipart`], so this is never deserialized directly (the
/// `Deserialize` derive only carries the `serde` rename to the generated schema).
/// Fields cross the wire as text — `requiresTunnel` is `"true"` / `"false"` —
/// and `bundle` is the uploaded file. `provenance` and `name` are always
/// present; the rest are kind-specific, so they're optional here and the handler
/// requires the right ones per `provenance`. Mirrors the TS `CreateAppBodySchema`.
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct CreateAppMultipart {
    /// `"cloud"` or `"self-hosted"`.
    provenance: String,
    name: String,
    subtitle: Option<String>,
    /// Cloud only: the launch URL template.
    url: Option<String>,
    /// Cloud only: `"true"` / `"false"`.
    requires_tunnel: Option<String>,
    /// Self-hosted only: the app's static files as a zip.
    #[schema(format = Binary)]
    bundle: Option<String>,
}

/// `POST /apps` — create a cloud or self-hosted app. Owner-gated by the host; the
/// body limit is raised for the upload arm (see the router wiring).
#[utoipa::path(
    post,
    tag = "Catalogue",
    path = "/apps",
    request_body(content = CreateAppMultipart, content_type = "multipart/form-data"),
    responses(
        (status = 200, description = "The created app (the provenance-tagged catalogue entry)", body = AppListEntry),
        (status = 400, description = "Empty/unusable name (`InvalidName`), bad url (`InvalidUrl`), or a bad bundle (`InvalidZip`)", body = InvalidFieldBody),
    ),
)]
pub(crate) async fn handle_create_app(
    State(state): State<Arc<AppsState>>,
    mut multipart: Multipart,
) -> Result<Json<AppListEntry>, HandlerError> {
    let mut provenance: Option<String> = None;
    let mut name: Option<String> = None;
    let mut subtitle: Option<String> = None;
    let mut url: Option<String> = None;
    let mut requires_tunnel: Option<String> = None;
    let mut bundle: Option<Bytes> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| HandlerError::internal("failed to read multipart body", e))?
    {
        // `name()` borrows `field`; own it before `text()`/`bytes()` consumes it.
        let field_name = field.name().map(str::to_owned);
        match field_name.as_deref() {
            Some("bundle") => {
                bundle = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| HandlerError::internal("failed to read bundle part", e))?,
                );
            }
            Some(key @ ("provenance" | "name" | "subtitle" | "url" | "requiresTunnel")) => {
                let value = field
                    .text()
                    .await
                    .map_err(|e| HandlerError::internal("failed to read multipart field", e))?;
                match key {
                    "provenance" => provenance = Some(value),
                    "name" => name = Some(value),
                    "subtitle" => subtitle = Some(value),
                    "url" => url = Some(value),
                    "requiresTunnel" => requires_tunnel = Some(value),
                    // The outer pattern already narrowed `key` to this set.
                    _ => unreachable!("field name matched the guarded set"),
                }
            }
            // Ignore unknown parts rather than reject — forward-compatible.
            _ => {}
        }
    }

    let name = name.ok_or_else(|| HandlerError::InvalidName {
        message: "name is required".to_owned(),
    })?;
    // The typed client always sends a known provenance; a missing/unknown one is
    // a protocol violation, surfaced as a logged 500 rather than a wire 400.
    match provenance.as_deref() {
        Some("cloud") => create_cloud(&state, name, subtitle, url, requires_tunnel),
        Some("self-hosted") => create_self_hosted(&state, name, subtitle, bundle).await,
        other => Err(HandlerError::internal(
            "create: missing or unknown provenance",
            format!("{other:?}"),
        )),
    }
    .map(Json)
}

/// Create a cloud app from the form fields. `url` / `requiresTunnel` are required
/// for this arm (schema-optional on the shared multipart body); an absent `url`
/// is a `400 InvalidUrl`, and a missing/malformed `requiresTunnel` is a protocol
/// violation surfaced as a logged 500 (the typed client always sends it).
fn create_cloud(
    state: &AppsState,
    name: String,
    subtitle: Option<String>,
    url: Option<String>,
    requires_tunnel: Option<String>,
) -> Result<AppListEntry, HandlerError> {
    if name.is_empty() {
        return Err(HandlerError::InvalidName {
            message: "name must not be empty".to_owned(),
        });
    }
    let url = url.ok_or_else(|| HandlerError::InvalidUrl {
        message: "url is required for a cloud app".to_owned(),
    })?;
    let url = url
        .parse::<AppUrl>()
        .map_err(|e| HandlerError::InvalidUrl {
            message: e.to_string(),
        })?;
    let requires_tunnel = parse_bool_field(requires_tunnel.as_deref())?;
    let new = NewCloudApp {
        id: mint_app_id(),
        content: CloudContent {
            name,
            // Empty `""` clears the subtitle.
            subtitle: subtitle.filter(|s| !s.is_empty()),
            url,
            requires_tunnel,
        },
    };
    // The returned `App` was read back in-txn, so projecting it is exactly the
    // `GET /apps` shape with no second read.
    let app = state
        .store
        .insert_cloud_app(&new)
        .map_err(|e| HandlerError::internal("insert_cloud_app failed", e))?
        .ok_or_else(|| {
            // 21-char random id collided — vanishingly unlikely, but surface it
            // as a logged 500 rather than silently returning the existing row.
            tracing::error!("app id collision on {}", new.id);
            HandlerError::internal("insert_cloud_app id collision", "id already exists")
        })?;
    Ok(AppListEntry::from(&app))
}

/// Install a self-hosted app from the uploaded `bundle` via the staged install:
/// extract off-runtime, move into place before the row is committed, insert
/// (allocating slug + port), then bring the listener online — cleaning up on any
/// failure. See `docs/Apps/Store and Install Explanation.md`.
async fn create_self_hosted(
    state: &AppsState,
    name: String,
    subtitle: Option<String>,
    bundle: Option<Bytes>,
) -> Result<AppListEntry, HandlerError> {
    let slug = slugify(&name).ok_or_else(|| HandlerError::InvalidName {
        message: "name must contain at least one letter or digit".to_owned(),
    })?;
    let bundle = bundle.ok_or_else(|| HandlerError::InvalidZip {
        message: "a self-hosted app requires an uploaded bundle".to_owned(),
    })?;

    let apps_dir = state.self_hosted.apps_dir().to_path_buf();
    // A fresh mint per upload names both the staging dir and the final serving
    // folder (the row's `content_folder`) — see the content-folder section of
    // `docs/Apps/Store and Install Explanation.md`.
    let folder = mint_app_id();
    let staging = apps_dir.join(".staging").join(&folder);

    // Extract off the async runtime — zip inflate + disk writes are blocking.
    // The same blocking task infers the launch path from the extracted (and
    // hoisted) tree, so the `launch.html` probe rides the same off-runtime hop.
    let staging_for_extract = staging.clone();
    let extract = tokio::task::spawn_blocking(move || {
        extract_zip_bundle(&bundle, &staging_for_extract)
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

    // Move the extracted files into their serving location BEFORE the DB insert,
    // so a committed row always points at present files (a crash after this leaks
    // only an unreferenced folder — no row, never served).
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
        name,
        subtitle: subtitle.filter(|s| !s.is_empty()),
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

    // Bring it online now. `start` swallows bind failures (the row is committed
    // and files are in place, so it comes up on the next restart); the only error
    // it propagates is a poisoned lock, where reverse-proxy registration did NOT
    // happen and won't self-heal. That's a real fault — surface it.
    if let Err(error) = state.self_hosted.start(&app.id, child).await {
        return Err(HandlerError::internal(
            "installed self-hosted app failed to register",
            error,
        ));
    }

    Ok(AppListEntry::from(&app))
}

/// Parse a `requiresTunnel` multipart field (`"true"` / `"false"`). Absent or
/// malformed is a protocol violation (the typed client always sends a valid
/// value), surfaced as a logged 500 rather than an off-contract 400.
fn parse_bool_field(value: Option<&str>) -> Result<bool, HandlerError> {
    match value {
        Some("true") => Ok(true),
        Some("false") => Ok(false),
        other => Err(HandlerError::internal(
            "create: missing or malformed requiresTunnel field",
            format!("{other:?}"),
        )),
    }
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

/// Best-effort removal of a failed install's directory (the staging dir, or the
/// already-moved serving folder when the DB insert is what failed). A cleanup
/// failure is logged, not surfaced — the request already has its real error.
fn remove_staging(dir: &std::path::Path) {
    if let Err(error) = std::fs::remove_dir_all(dir) {
        if error.kind() != std::io::ErrorKind::NotFound {
            tracing::warn!(%error, path = %dir.display(), "failed to clean up a failed install's directory");
        }
    }
}

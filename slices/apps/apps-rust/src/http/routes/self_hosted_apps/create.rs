//! `POST /self-hosted-apps` — install a self-hosted app from an uploaded zip
//! `bundle`. The body is `multipart/form-data` (`name`, optional `subtitle`, and
//! the `bundle` file). Runs the staged install (extract → move → insert → start)
//! so it never leaves a half-installed app behind — see
//! `docs/Apps/Store and Install Explanation.md` §"The self-hosted upload pipeline".
//! Form fields cross the wire as text and the file rides its own part, so the
//! handler reads the [`Multipart`] parts by hand. Returns the created
//! [`SelfHostedAppDetail`], read back in-txn.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Multipart, State};
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::{actions, AppKind, AppRegistration, AppsError, SelfHostedAppConfiguration};
use crate::http::errors::InvalidFieldBody;
use crate::http::state::AppsState;
use crate::http::wire_representations::SelfHostedAppDetail;
use crate::id::mint_app_id;
use crate::install::{self, extract_zip_bundle, infer_launch_path, slugify};

/// Documents the `multipart/form-data` body for OpenAPI. The handler reads the
/// parts manually via [`Multipart`], so this is never deserialized directly (the
/// `Deserialize` derive only carries the `serde` rename to the generated schema).
/// `name` is always present; `subtitle` is optional; `bundle` is the uploaded zip.
/// Matches the TS `CreateSelfHostedAppBodySchema`.
#[derive(Deserialize, ToSchema)]
#[serde(rename_all = "camelCase")]
#[allow(dead_code)]
pub(crate) struct CreateSelfHostedAppMultipart {
    name: String,
    subtitle: Option<String>,
    /// The app's static files as a zip.
    #[schema(format = Binary)]
    bundle: String,
}

/// `POST /self-hosted-apps` — install a self-hosted app from the uploaded `bundle`.
/// Owner-gated by the host; the body limit is raised for this route (see the
/// router wiring).
#[utoipa::path(
    post,
    tag = "Self-hosted apps",
    path = "/self-hosted-apps",
    request_body(content = CreateSelfHostedAppMultipart, content_type = "multipart/form-data"),
    responses(
        (status = 200, description = "The installed self-hosted app detail", body = SelfHostedAppDetail),
        (status = 400, description = "Empty/unusable or already-taken name (`InvalidName`) or a bad bundle (`InvalidZip`)", body = InvalidFieldBody),
    ),
)]
pub(crate) async fn handle_create_self_hosted_app(
    State(state): State<Arc<AppsState>>,
    mut multipart: Multipart,
) -> Result<Json<SelfHostedAppDetail>, AppsError> {
    let mut name: Option<String> = None;
    let mut subtitle: Option<String> = None;
    let mut bundle: Option<Bytes> = None;

    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|e| AppsError::infrastructure("failed to read multipart body", e))?
    {
        // `name()` borrows `field`; own it before `text()`/`bytes()` consumes it.
        let field_name = field.name().map(str::to_owned);
        match field_name.as_deref() {
            Some("bundle") => {
                bundle = Some(
                    field
                        .bytes()
                        .await
                        .map_err(|e| AppsError::infrastructure("failed to read bundle part", e))?,
                );
            }
            Some(key @ ("name" | "subtitle")) => {
                let value = field
                    .text()
                    .await
                    .map_err(|e| AppsError::infrastructure("failed to read multipart field", e))?;
                match key {
                    "name" => name = Some(value),
                    "subtitle" => subtitle = Some(value),
                    // The outer pattern already narrowed `key` to this set.
                    _ => unreachable!("field name matched the guarded set"),
                }
            }
            // Ignore unknown parts rather than reject — forward-compatible.
            _ => {}
        }
    }

    let name = name.ok_or_else(|| AppsError::InvalidName {
        message: "name is required".to_owned(),
    })?;
    let (registration, config) = install_self_hosted(&state, name, subtitle, bundle).await?;
    Ok(Json(SelfHostedAppDetail::from((&registration, &config))))
}

/// Install a self-hosted app from the uploaded `bundle` via the staged install:
/// extract off-runtime, move into place before the row is committed, insert (the
/// name-derived slug as id, allocating the port), then bring the listener online —
/// cleaning up on any failure. See `docs/Apps/Store and Install Explanation.md`.
async fn install_self_hosted(
    state: &AppsState,
    name: String,
    subtitle: Option<String>,
    bundle: Option<Bytes>,
) -> Result<(AppRegistration, SelfHostedAppConfiguration), AppsError> {
    let slug = slugify(&name).ok_or_else(|| AppsError::InvalidName {
        message: "name must contain at least one letter or digit".to_owned(),
    })?;
    let bundle = bundle.ok_or_else(|| AppsError::InvalidZip {
        message: "a self-hosted app requires an uploaded bundle".to_owned(),
    })?;

    let apps_dir = state.self_hosted.apps_dir().to_path_buf();
    // A fresh mint per upload names both the staging dir and the final serving
    // folder (the row's `content_folder`).
    let folder = mint_app_id();
    let staging = apps_dir.join(".staging").join(&folder);

    // Extract off the async runtime — zip inflate + disk writes are blocking. The
    // same blocking task infers the launch path from the extracted (and hoisted)
    // tree, so the `launch.html` probe rides the same off-runtime hop.
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
            return Err(AppsError::infrastructure(
                "zip extraction task failed",
                join_error,
            ));
        }
    };

    // Move the extracted files into their serving location BEFORE the DB insert, so
    // a committed row always points at present files (a crash after this leaks only
    // an unreferenced folder — no row, never served).
    let dest = apps_dir.join(&folder);
    if let Err(error) = std::fs::rename(&staging, &dest) {
        remove_staging(&staging);
        return Err(AppsError::infrastructure(
            "failed to move the staged app into place",
            error,
        ));
    }

    // Synthesize the caller-built pair the store persists: the slug is the id and
    // subdomain, `position` / `port` are placeholders the store overrides, and an
    // upload is never seeded.
    let registration = AppRegistration {
        id: slug.clone(),
        kind: AppKind::SelfHosted,
        position: 0,
        on_homescreen: true,
        name,
        subtitle: subtitle.filter(|s| !s.is_empty()),
        local_only: true,
        client_id: None,
        requires_tunnel: false,
    };
    let config = SelfHostedAppConfiguration {
        port: 0,
        content_folder: folder,
        subdomain: slug,
        seeded: false,
        launch_path,
    };
    // The host's own loopback port is reserved so an upload never binds over it.
    let reserved_ports: Vec<u16> = state.loopback_base_url.port().into_iter().collect();
    // The action inserts (the slug as id, allocating the port in-txn) and maps an
    // insert failure onto the wire error — a taken slug is `400 InvalidName`, an
    // exhausted port space a logged 500. Any error unwinds the just-moved files.
    let (registration, config) = match actions::create_self_hosted_app(
        &state.store,
        &registration,
        &config,
        &reserved_ports,
    ) {
        Ok(pair) => pair,
        Err(error) => {
            remove_staging(&dest);
            return Err(error);
        }
    };

    // Bring it online now. `start` swallows bind failures (the row is committed and
    // files are in place, so it comes up on the next restart); the only error it
    // propagates is a poisoned lock, where reverse-proxy registration did NOT
    // happen and won't self-heal. That's a real fault — surface it.
    if let Err(error) = state
        .self_hosted
        .start(registration.id.as_str(), &config)
        .await
    {
        return Err(AppsError::infrastructure(
            "installed self-hosted app failed to register",
            error,
        ));
    }

    Ok((registration, config))
}

/// Map an extraction failure to the wire error: a disk-write failure is our fault
/// (`500`), every other variant is a bad upload (`400 InvalidZip`).
fn map_install_error(error: install::InstallError) -> AppsError {
    match error {
        install::InstallError::Io(io_error) => {
            AppsError::infrastructure("zip extraction io error", io_error)
        }
        other => AppsError::InvalidZip {
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

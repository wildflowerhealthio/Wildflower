//! `POST /self-hosted-apps` — install a self-hosted app from an uploaded zip
//! `bundle`. The body is `multipart/form-data` (`name`, optional `subtitle`, and
//! the `bundle` file); form fields cross the wire as text and the file rides its own
//! part, so the handler reads the [`Multipart`] parts by hand. It only shapes the
//! parts into a [`SelfHostedAppPayload`] and hands them (with the service, which is
//! the [`SelfHostedInstaller`](crate::domain::SelfHostedInstaller)) to
//! [`install_self_hosted_app`](actions::install_self_hosted_app) — the staged install
//! (extract → move → insert → start, cleaning up on failure) lives in the action +
//! its installer, not here. Returns the created [`SelfHostedAppDetail`].

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Multipart, State};
use axum::Json;
use serde::Deserialize;
use utoipa::ToSchema;

use crate::domain::{actions, actions::SelfHostedAppPayload, AppsError};
use crate::http::errors::InvalidFieldBody;
use crate::http::state::AppsState;
use crate::http::wire_representations::SelfHostedAppDetail;

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
    let bundle = bundle.ok_or_else(|| AppsError::InvalidZip {
        message: "a self-hosted app requires an uploaded bundle".to_owned(),
    })?;

    // Everything below the wire shaping — slugify, stage, synthesize, insert, start,
    // cleanup — lives in the action + its installer. The service *is* the installer.
    let payload = SelfHostedAppPayload {
        name,
        subtitle,
        bundle,
        // The host's own loopback port is reserved so an upload never binds over it.
        reserved_ports: state.loopback_base_url.port().into_iter().collect(),
    };
    let (registration, config) =
        actions::install_self_hosted_app(&state.store, state.self_hosted.as_ref(), payload).await?;
    Ok(Json(SelfHostedAppDetail::from((&registration, &config))))
}

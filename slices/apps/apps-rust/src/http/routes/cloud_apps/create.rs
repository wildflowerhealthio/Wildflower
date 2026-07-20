//! `POST /cloud-apps` — register a new cloud app from a JSON body
//! (`{name, subtitle?, url, requiresTunnel}`). The server mints the id (a 21-char
//! nanoid). `url` is parsed through the write-side [`AppUrl`] filter so an open
//! redirect never lands in the row; an empty name is `400 InvalidName`, a bad url
//! `400 InvalidUrl`. Returns the created [`CloudAppDetail`], hydrated via `RETURNING`, so
//! the editor renders the tile without a re-list.

use axum::Json;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use super::CloudAppBody;
use crate::domain::actions::CloudAppPayload;
use crate::domain::AppsError;
use crate::http::errors::InvalidFieldBody;
use crate::http::wire_representations::CloudAppDetail;
use crate::live_bindings::LiveAppsCreator;

/// `POST /cloud-apps` — create a cloud app. Scope-gated on `wildflower/Apps.c`
/// through [`Scoped<LiveAppsCreator>`].
#[utoipa::path(
    post,
    tag = "Cloud apps",
    path = "/cloud-apps",
    request_body = CloudAppBody,
    responses(
        (status = 200, description = "The created cloud app detail", body = CloudAppDetail),
        (status = 400, description = "Empty name (`InvalidName`) or bad url (`InvalidUrl`)", body = InvalidFieldBody),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.c`", body = InsufficientScopeBody),
    ),
)]
pub(crate) async fn handle_create_cloud_app(
    creator: Scoped<LiveAppsCreator>,
    Json(body): Json<CloudAppBody>,
) -> Result<Json<CloudAppDetail>, AppsError> {
    // The handler transforms: it maps its `CloudAppBody` onto the capability's
    // `CloudAppPayload`; the capability mints the id, validates the fields,
    // synthesizes the registration + configuration, inserts (mapping a server-minted
    // id collision to a logged 500), and reads the pair back in-txn — exactly the
    // `GET /cloud-apps/{id}` shape with no second read.
    let (registration, config) = creator.create_cloud_app(CloudAppPayload {
        name: body.name,
        subtitle: body.subtitle,
        url: body.url,
        requires_tunnel: body.requires_tunnel,
    })?;
    Ok(Json(CloudAppDetail::from((&registration, &config))))
}

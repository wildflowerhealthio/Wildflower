//! `POST /apps` — register a new app from a JSON body
//! (`{name, subtitle?, url, requiresTunnel}`). The server mints the id (a 21-char
//! nanoid). `url` is parsed through the write-side [`AppUrl`](crate::domain::AppUrl)
//! filter so an open redirect never lands in the row; an empty name is
//! `400 InvalidName`, a bad url `400 InvalidUrl`. Returns the created
//! [`AppRegistration`], hydrated via `RETURNING`, so the editor renders the tile
//! without a re-list.

use axum::Json;

use scope_capabilities_rust::{InsufficientScopeBody, Scoped};

use super::AppBody;
use crate::domain::actions::AppPayload;
use crate::domain::{AppRegistration, AppsError};
use crate::http::errors::InvalidFieldBody;
use crate::live_bindings::LiveAppsCreator;

/// `POST /apps` — create an app. Scope-gated on `wildflower/Apps.c` through
/// [`Scoped<LiveAppsCreator>`].
#[utoipa::path(
    post,
    tag = "Catalogue",
    path = "/apps",
    request_body = AppBody,
    responses(
        (status = 200, description = "The created app", body = AppRegistration),
        (status = 400, description = "Empty name (`InvalidName`) or bad url (`InvalidUrl`)", body = InvalidFieldBody),
        (status = 403, description = "The caller's token doesn't cover `wildflower/Apps.c`", body = InsufficientScopeBody),
    ),
)]
pub(crate) async fn handle_create_app(
    creator: Scoped<LiveAppsCreator>,
    Json(body): Json<AppBody>,
) -> Result<Json<AppRegistration>, AppsError> {
    // The handler transforms: it maps its `AppBody` onto the capability's
    // `AppPayload`; the capability mints the id, validates the fields, synthesizes
    // the registration, and inserts (mapping a server-minted id collision to a
    // logged 500) — exactly the `GET /apps/{id}` shape with no second read.
    Ok(Json(creator.create_app(AppPayload {
        name: body.name,
        subtitle: body.subtitle,
        url: body.url,
        requires_tunnel: body.requires_tunnel,
    })?))
}

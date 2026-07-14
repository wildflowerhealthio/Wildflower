//! `POST /cloud-apps` — register a new cloud app from a JSON body
//! (`{name, subtitle?, url, requiresTunnel}`). The server mints the id (a 21-char
//! nanoid). `url` is parsed through the write-side [`AppUrl`] filter so an open
//! redirect never lands in the row; an empty name is `400 InvalidName`, a bad url
//! `400 InvalidUrl`. Returns the created [`CloudAppDetail`], read back in-txn, so
//! the editor renders the tile without a re-list.

use std::sync::Arc;

use axum::extract::State;
use axum::Json;

use super::CloudAppBody;
use crate::domain::{actions, AppsError};
use crate::http::errors::InvalidFieldBody;
use crate::http::state::AppsState;
use crate::http::wire_representations::CloudAppDetail;
use crate::id::mint_app_id;

/// `POST /cloud-apps` — create a cloud app. Owner-gated by the host.
#[utoipa::path(
    post,
    tag = "Cloud apps",
    path = "/cloud-apps",
    request_body = CloudAppBody,
    responses(
        (status = 200, description = "The created cloud app detail", body = CloudAppDetail),
        (status = 400, description = "Empty name (`InvalidName`) or bad url (`InvalidUrl`)", body = InvalidFieldBody),
    ),
)]
pub(crate) async fn handle_create_cloud_app(
    State(state): State<Arc<AppsState>>,
    Json(body): Json<CloudAppBody>,
) -> Result<Json<CloudAppDetail>, AppsError> {
    // The handler transforms: it mints the id and maps its `CloudAppBody` onto the
    // action's `CloudAppContent`; the action validates the fields, synthesizes the
    // registration + configuration, inserts (mapping a server-minted id collision to
    // a logged 500), and reads the pair back in-txn — exactly the
    // `GET /cloud-apps/{id}` shape with no second read.
    let (registration, config) = actions::create_cloud_app(
        &state.store,
        mint_app_id(),
        actions::CloudAppContent {
            name: body.name,
            subtitle: body.subtitle,
            url: body.url,
            requires_tunnel: body.requires_tunnel,
        },
    )?;
    Ok(Json(CloudAppDetail::from((&registration, &config))))
}

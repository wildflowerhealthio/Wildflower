//! `DELETE /apps/{id}` — remove an app row of any kind. Unknown ids return
//! 404; bundled rows are deletable like any other.

use std::sync::Arc;

use axum::extract::{Path, State};
use axum::Json;
use serde::Serialize;
use utoipa::ToSchema;

use crate::http::response_templates::{AppNotFoundBody, HandlerError};
use crate::http::state::AppsState;

#[derive(Debug, Serialize, ToSchema)]
pub(crate) struct DeletedBody {
    deleted: bool,
}

/// `DELETE /apps/{id}` — remove any row. Owner-gated by the consumer.
#[utoipa::path(
    delete,
    path = "/apps/{id}",
    params(("id" = String, Path, description = "App id")),
    responses(
        (status = 200, description = "The row was removed", body = DeletedBody),
        (status = 404, description = "No app has this id", body = AppNotFoundBody),
    ),
)]
pub(crate) async fn handle_delete_app(
    State(state): State<Arc<AppsState>>,
    Path(id): Path<String>,
) -> Result<Json<DeletedBody>, HandlerError> {
    let deleted = state
        .store
        .delete_app(&id)
        .map_err(|e| HandlerError::internal("delete_app failed", e))?;
    if !deleted {
        return Err(HandlerError::NotFound { id });
    }
    Ok(Json(DeletedBody { deleted: true }))
}

use std::sync::Arc;

use axum::response::IntoResponse;
use axum::routing::{get, MethodRouter};
use axum::Json;

use crate::domain::gatekeeper_error::GatekeeperError;
use crate::http::scoped::facades::GrantsReader;
use crate::http::scoped::Scoped;
use crate::http::state::GatekeeperState;

/// `GET /grants` — list every standing client grant for the Owner UI. Acquired
/// through [`GrantsReader`] (scope `wildflower/Grant.r`): the read capability
/// *is* the extractor, so the scope check can't be skipped.
pub(super) fn route() -> MethodRouter<Arc<GatekeeperState>> {
    get(handle_list_grants)
}

async fn handle_list_grants(
    grants: Scoped<GrantsReader>,
) -> Result<impl IntoResponse, GatekeeperError> {
    Ok(Json(grants.list()?))
}

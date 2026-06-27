//! The read + launch route handlers — `list` (`GET /apps`) and `launch`
//! (`POST /apps/{id}`). Each exposes a `#[utoipa::path]`-annotated handler;
//! [`crate::http::handlers::openapi_router`] collects them into the single
//! `/apps` router alongside the cloud-admin + placement routes.

pub(crate) mod launch;
pub(crate) mod list;

//! The read + launch route handlers — `list` (`GET /apps`) and `launch`
//! (`POST /apps/{id}`). Each exposes a `#[utoipa::path]`-annotated handler;
//! [`crate::http::handlers::openapi_router`] collects them alongside the
//! cloud-admin + home-screen routes.

pub(crate) mod launch;
pub(crate) mod list;

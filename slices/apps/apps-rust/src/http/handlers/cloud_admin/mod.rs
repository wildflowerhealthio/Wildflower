//! The app mutate route handlers — `create` (`POST /apps`), `update`
//! (`PATCH /apps/{id}`), and `delete` (`DELETE /apps/{id}`). Each exposes a
//! `#[utoipa::path]`-annotated handler.
//!
//! `create` installs **cloud** apps only. `update` and `delete` edit both cloud
//! apps and uploaded (non-seeded) self-hosted apps, dispatching on the parent
//! row's provenance; system apps and seeded self-hosted apps return
//! `409 AppNotEditable`. [`crate::http::handlers::openapi_router`] collects them
//! into the single `/apps` router.

pub(crate) mod create;
pub(crate) mod delete;
pub(crate) mod update;

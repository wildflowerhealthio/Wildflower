//! The cloud-app mutate route handlers — `create` (`POST /apps`), `update`
//! (`PATCH /apps/{id}`), and `delete` (`DELETE /apps/{id}`). Each exposes a
//! `#[utoipa::path]`-annotated handler; only **cloud** apps are editable here
//! (system / self-hosted ids return `409 AppNotEditable`).
//! [`crate::http::handlers::openapi_router`] collects them into the single
//! `/apps` router.

pub(crate) mod create;
pub(crate) mod delete;
pub(crate) mod update;

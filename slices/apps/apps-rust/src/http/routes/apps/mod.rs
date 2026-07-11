//! The `/apps` URL-segment routes, one file per operation: `list` (`GET /apps`),
//! `create` (`POST /apps`), `launch` (`GET` + `POST /apps/{id}`), `update`
//! (`PUT /apps/{id}`), and `delete` (`DELETE /apps/{id}`). Each exposes a
//! `#[utoipa::path]`-annotated handler; the route table in
//! [`crate::http::routes`] wires them into the gated + launch routers.
//!
//! `create` registers cloud apps and installs uploaded self-hosted apps
//! (multipart, discriminated on `provenance`). `update` and `delete` edit both
//! cloud apps and uploaded (non-seeded) self-hosted apps, dispatching on the
//! stored app's provenance; system apps and seeded self-hosted apps return
//! `409 AppNotEditable`.

pub(crate) mod create;
pub(crate) mod delete;
pub(crate) mod launch;
pub(crate) mod list;
pub(crate) mod update;

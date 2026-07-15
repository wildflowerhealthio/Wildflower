//! The `/apps` URL-segment routes, one file per operation: `list_all` (`GET /apps` —
//! the uniform registry), `launch` (`GET` + `POST /apps/{id}`), and `delete_by_id`
//! (`DELETE /apps/{id}` — unified across kinds, kind resolved via the
//! registration). The per-kind detail/create/replace routes live off the root
//! under [`cloud_apps`](crate::http::routes::cloud_apps) /
//! [`self_hosted_apps`](crate::http::routes::self_hosted_apps) /
//! [`system_apps`](crate::http::routes::system_apps). Each file exposes a
//! `#[utoipa::path]`-annotated handler; the route table in
//! [`crate::http::routes`] wires them into the gated + launch routers.

pub(crate) mod delete_by_id;
pub(crate) mod launch;
pub(crate) mod list_all;

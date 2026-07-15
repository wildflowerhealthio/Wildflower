//! The `/self-hosted-apps` root resource — self-hosted apps as their own REST
//! resource, off `/apps`. One file per operation: `get_by_id`
//! (`GET /self-hosted-apps/{id}`), `create` (`POST /self-hosted-apps`, the
//! multipart upload/install pipeline), `update_by_id` (`PUT /self-hosted-apps/{id}`, the
//! `launchPath`), all returning the
//! [`SelfHostedAppDetail`](crate::http::wire_representations::SelfHostedAppDetail) shape. A path given
//! an id that isn't a self-hosted app is a `404`; a seeded app's edit is a `409`.

pub(crate) mod create;
pub(crate) mod get_by_id;
pub(crate) mod update_by_id;

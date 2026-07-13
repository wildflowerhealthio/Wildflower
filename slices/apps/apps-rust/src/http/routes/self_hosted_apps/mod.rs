//! The `/self-hosted-apps` root resource — self-hosted apps as their own REST
//! resource, off `/apps`. One file per operation: `get`
//! (`GET /self-hosted-apps/{id}`), `create` (`POST /self-hosted-apps`, the
//! multipart upload/install pipeline), `update` (`PUT /self-hosted-apps/{id}`, the
//! `launchPath`), all returning the
//! [`SelfHostedAppDetail`](crate::domain::SelfHostedAppDetail) shape. A path given
//! an id that isn't a self-hosted app is a `404`; a seeded app's edit is a `409`.

pub(crate) mod create;
pub(crate) mod get;
pub(crate) mod update;

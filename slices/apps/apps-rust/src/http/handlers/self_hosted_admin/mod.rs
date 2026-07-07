//! The self-hosted-app admin surface — currently just `create`
//! (`POST /self-hosted-apps`), the upload install route. Mirrors the
//! `cloud_admin` module layout. The route is deliberately **not** under
//! `/apps/…` so it can't shadow the parameterized launch route `POST /apps/{id}`
//! (see the router wiring in [`crate::http::handlers`]).

pub(crate) mod create;

//! The adapters behind the servers [`ports`](crate::ports):
//! [`JsonServerRegistry`], the [`ServerRegistry`](crate::ServerRegistry) kept
//! in `<data root>/servers.json`, and [`RelaySiteClient`], the
//! [`RelaySite`](crate::RelaySite) over HTTPS for one relay's site, which
//! signs `GET /me` with `request_signature`.

mod json_server_registry;
mod relay_site_client;
mod request_signature;

pub use json_server_registry::{JsonServerRegistry, SERVERS_FILE_NAME};
pub use relay_site_client::RelaySiteClient;

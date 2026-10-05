//! The adapters behind the servers [`ports`](crate::ports):
//! [`JsonServerRegistry`], the [`ServerRegistry`](crate::ServerRegistry) kept
//! in `<data root>/servers.json`, and [`ReqwestRelaySite`], the
//! [`RelaySite`](crate::RelaySite) over HTTPS, which signs `GET /me` with
//! `request_signature`.

mod json_server_registry;
mod request_signature;
mod reqwest_relay_site;

pub use json_server_registry::{JsonServerRegistry, SERVERS_FILE_NAME};
pub use reqwest_relay_site::ReqwestRelaySite;

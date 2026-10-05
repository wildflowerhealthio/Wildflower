//! The adapters behind the servers [`ports`](crate::ports):
//! [`JsonServerRegistry`], the [`ServerRegistry`](crate::ServerRegistry) kept
//! in `<data root>/servers.json`, and [`ReqwestRelayClient`], the
//! [`RelayClient`](crate::RelayClient) over HTTPS for one relay's site, which
//! signs `GET /me` with `request_signature`.

mod json_server_registry;
mod request_signature;
mod reqwest_relay_client;

pub use json_server_registry::{JsonServerRegistry, SERVERS_FILE_NAME};
pub use reqwest_relay_client::ReqwestRelayClient;

//! The adapters behind the servers [`ports`](crate::ports):
//! [`JsonServerRegistry`], the [`ServerRegistry`](crate::ServerRegistry) kept
//! in `<data root>/servers.json`.

mod json_server_registry;

pub use json_server_registry::{JsonServerRegistry, SERVERS_FILE_NAME};

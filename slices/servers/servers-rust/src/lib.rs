//! `servers-rust`: the servers this install knows about.
//!
//! A server is a domain, a folder and an enrolment at a relay. Its
//! [`ServerRecord`] holds the relay, the tunnel name and token there, what the
//! relay's `GET /rathole` returned, the launcher apps open from, and whether
//! its certificates come from the ACME staging directory. Its
//! [`domain`](ServerRecord::domain), `<tunnel name>.<relay domain>`, is its
//! only name: the registry key, the issuer, and its data folder
//! `<data root>/servers/<domain>/`. Records hold configuration only; whether a
//! server is running, its tunnel and its certificate are never stored here.
//!
//! The list lives in `<data root>/servers.json`, behind the
//! [`ServerRegistry`] port, and holds any number of servers.
//!
//!  - [`domain`] — [`ServerRecord`], its [`Relay`] and [`TunnelToken`], and
//!    [`RegistryError`]. The token is a secret: its `Debug` and `Serialize`
//!    write a redaction marker, and only `servers.json` holds it in full.
//!  - `ports` — the [`ServerRegistry`] port: read all, insert, update, remove.
//!  - `adapters` — [`JsonServerRegistry`], which replaces `servers.json`
//!    atomically on every change and refuses a file whose `version` it
//!    doesn't read.

pub mod domain;

mod adapters;
mod ports;

pub use adapters::{JsonServerRegistry, SERVERS_FILE_NAME};
pub use domain::{RegistryError, Relay, ServerRecord, TunnelToken};
pub use ports::ServerRegistry;

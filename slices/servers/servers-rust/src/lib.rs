//! `servers-rust`: the servers this install knows about.
//!
//! A server is a domain, a folder and an enrolment at a relay. Its
//! [`ServerRecord`] holds the relay, the tunnel name and token there, what the
//! relay's `GET /rathole` returned, the launcher apps open from, whether its
//! certificates come from the ACME staging directory, and when the user wants
//! it run, its [`RunPolicy`]. Its [`domain`](ServerRecord::domain),
//! `<tunnel name>.<relay domain>`, is its only name: the registry key, the
//! issuer, and its data folder `<data root>/servers/<domain>/`
//! ([`server_dir`](ServerRecord::server_dir)). Records hold configuration
//! only; whether a run is up, its tunnel and its certificate are never stored
//! here.
//!
//! The list lives in `<data root>/servers.json`, behind the
//! [`ServerRegistry`] port, and holds any number of servers.
//!
//! A server is added by enrolment ([`add_server`]). For a Wildflower relay,
//! official or self-hosted, the relay's `GET /rathole` is fetched and
//! checked, a signed `GET /me` confirms the relay holds the tunnel name and
//! token, and only then is the record written. A rathole relay, a rathole
//! server with no Wildflower relay site, is entered as its settings, which get
//! the same checks. [`set_server_credentials`] replaces a server's token the
//! same way, refusing a relay whose identity ([`RelayIdentity`]: its dial
//! address and noise key) is no longer the one the server was added with,
//! and replaces a rathole server's without a request.
//!
//! A registered server's run policy is set by [`set_run_policy`], its
//! launcher and certificate source by [`update_server`], and it is deleted,
//! folder and all, by [`remove_server`]. Each changes only the server it
//! names. The policy is `UnitRunner`'s [`RunPolicy`], stored in its wire
//! shape; the app stores it here and pushes it to `UnitRunner`, which never
//! reads `servers.json`.
//!
//! A server runs as a [`ServerUnit`] on `UnitRunner`: the host pushes each
//! record to `UnitRunner` with a factory that builds a fresh unit for every
//! run, and the unit reports its health as its [`ServerDetail`]. What the host
//! notifies about its servers is decided here too: the per-caller request
//! notifications ([`RequestNotificationCoalescer`]) and the notifications for
//! each stop of a server's run ([`StopNotificationCoalescer`]).
//!
//!  - [`domain`] — [`ServerRecord`], its [`RelayKind`], [`TunnelToken`] and
//!    [`RunPolicy`], [`RegistryError`], enrolment with its [`EnteredRelay`],
//!    [`RelayIdentity`] and [`EnrolmentError`], and the changes to a
//!    registered server with [`RunPolicyChoice`] and [`ServerChangeError`];
//!    [`ServerDetail`]; and the [`notifications`](domain::notifications)
//!    the host posts: [`LocalNotification`], the request coalescer and the
//!    stop notifications. The token is a secret: its `Debug` and `Serialize`
//!    write a redaction marker, and only `servers.json` holds it in full.
//!  - `ports` — the [`ServerRegistry`] port (read all, insert, modify,
//!    remove) and the [`RelayClient`] port (`GET /rathole`, signed
//!    `GET /me`).
//!  - `adapters` — [`JsonServerRegistry`], which replaces `servers.json`
//!    atomically on every change and refuses a file whose `version` it
//!    doesn't read, and [`ReqwestRelayClient`], which signs `GET /me` with
//!    HTTP Message Signatures (RFC 9421) keyed by the token, so the token is
//!    never sent.
//!  - `live_bindings` — [`ServerUnit`], a server bound to
//!    `wildflower-server-rust` as a unit `UnitRunner` runs.

pub mod domain;

mod adapters;
mod live_bindings;
mod ports;

pub use adapters::{JsonServerRegistry, ReqwestRelayClient, SERVERS_FILE_NAME};
pub use domain::notifications::local_notification::LocalNotification;
pub use domain::notifications::request_notifications::{
    CallerActivity, RequestNotificationCoalescer,
};
pub use domain::notifications::stop_notification::{stop_notification, StopNotificationCoalescer};
pub use domain::{
    add_server, remove_server, set_run_policy, set_server_credentials, update_server,
    EnrolmentError, EnteredRelay, RegistryError, RelayIdentity, RelayKind, RunPolicyChoice,
    ServerChangeError, ServerDetail, ServerRecord, TunnelToken, SERVERS_DIR_NAME,
};
pub use live_bindings::server_unit::ServerUnit;
pub use ports::{NewRecord, RegistryChange, RelayClient, ServerRegistry};
pub use unit_runner::RunPolicy;

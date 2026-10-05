//! Tauri host glue for the servers slice: the base's commands for adding a
//! server and re-entering its token. Every decision lives in
//! [`servers_rust`], which needs no webview to be tested; this crate is only
//! the glue.
//!
//! - [`server_add`] enrols a tunnel at a relay and registers the server (see
//!   [`servers_rust::add_server`]), answering with the server's domain.
//! - [`server_set_credentials`] replaces a registered server's token, checked
//!   with its relay the same way, or replaced at once for a rathole relay
//!   (see [`servers_rust::set_server_credentials`]).
//!
//! Arguments and answers are camelCase. Each command trims the token's
//! surrounding whitespace, as the relay does, and refuses one left empty.
//! Enrolment gets a [`ReqwestRelayClient`](servers_rust::ReqwestRelayClient)
//! for a relay's site, built when it asks for one.
//!
//! The token goes in and never comes back: neither command answers with it
//! or logs it. A failure answers with the
//! [`EnrolmentError`](servers_rust::EnrolmentError), serialised as
//! `{"kind", "message"}`.
//!
//! The app registers both in its `invoke_handler` and grants them to the
//! `main` webview only, through its app-defined `allow-server-enrolment`
//! permission. [`manage_servers`] puts the [`ServersState`] they read in the
//! app's managed state.

mod commands;

use std::path::Path;
use std::sync::Arc;

use servers_rust::{JsonServerRegistry, ServerRegistry};
use tauri::{AppHandle, Manager};

pub use commands::{server_add, server_set_credentials, ServerAddArgs, ServerSetCredentialsArgs};

/// What the servers commands work through: the install's registry.
pub struct ServersState {
    pub(crate) registry: Arc<dyn ServerRegistry>,
}

impl ServersState {
    #[must_use]
    pub fn new(registry: Arc<dyn ServerRegistry>) -> Self {
        Self { registry }
    }
}

/// Manage the [`ServersState`] over `<data_root>/servers.json`. `data_root`
/// is the directory the host already resolved and created in `setup()`.
/// Call once per app lifecycle.
pub fn manage_servers(app: &AppHandle, data_root: &Path) {
    app.manage(ServersState::new(Arc::new(
        JsonServerRegistry::in_data_root(data_root),
    )));
}

//! `wildflower-relay` — the self-hostable tunnel relay.
//!
//! One process runs two things side by side on one shutdown broadcast:
//!
//! - the [`rathole`] library in *server* mode, which holds a noise-encrypted
//!   tunnel per device and implements no protocol of our own; and
//! - a small TCP [`front`] on `:443` and `:80` that routes each visitor to a
//!   device's tunnel by the server name in the TLS ClientHello.
//!
//! ## Where it sits
//!
//! ```text
//!   browser ──TLS──► front :443 ── reads SNI only ──► 127.0.0.1:<port>
//!                    (wildflower-relay)                (rathole service <label>)
//!                                                             │ noise tunnel
//!                                                             ▼
//!                                       device: rathole CLIENT ──► TLS listener
//!                                       (holds the certificate for <label>.<domain>)
//! ```
//!
//! TLS for `https://<label>.<domain>` is terminated on the device. The relay
//! routes ciphertext: it reads the ClientHello's server name, maps
//! `<label>.<domain>` to the rathole service `[server.services.<label>]`,
//! writes a PROXY protocol v2 header carrying the visitor's address, replays
//! the hello and then copies bytes both ways. It holds no certificates or keys
//! for the public surface, and a hostname it cannot route is closed without a
//! byte written rather than answered with a certificate of its own. `:80`
//! only redirects to `https://`.
//!
//! Every service binds a loopback `bind_addr`, so nothing but the front
//! reaches a tunnel, and rathole binds it only while that device is
//! connected: a refused connect is how the front knows a device is offline.
//! The front reads its routes from the same TOML rathole hot-reloads (see
//! [`watch`]), so one write that adds a service makes it routable.
//!
//! ## Configuration
//!
//! Everything is set through `WILDFLOWER_RELAY_*` environment variables (the
//! full list is in [`settings`]). At startup the relay writes the rathole
//! `[server]` keys (control address, noise key) into the TOML at
//! `WILDFLOWER_RELAY_CONFIG`, creating it if needed and keeping its
//! `[server.services.*]` tables, which enrolment appends to (see [`config`]).
//! Device services can also come from `WILDFLOWER_RELAY_SERVICES`
//! (`label=token,...`), for hosts whose disk does not persist; those are
//! written into the file on every start and win over a file entry with the
//! same label. There is no default token: each service carries its own
//! `token`.
//! The front's own settings (domain suffix, listen addresses, limits) stay
//! out of the file because rathole rejects unknown keys in it.

pub mod config;
pub mod front;
pub mod route;
pub mod settings;
pub mod watch;

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::Context;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

pub use front::{Front, Limits};
pub use route::{Route, RouteTable, Router};
pub use settings::{ControlSettings, FrontSettings, RelaySettings, Secret};

/// Build the [`rathole::Cli`] that runs the relay in server mode against the
/// config at `config_path`.
///
/// We construct the args directly instead of parsing `argv` so the same entry
/// point is reusable from tests and from any future embedding (e.g. running
/// the relay in-process). `..Default::default()` fills the remaining flags
/// (`client`, `genkey`) with their off/none defaults so this keeps compiling
/// if rathole grows further optional flags.
#[must_use]
pub fn build_server_cli(config_path: PathBuf) -> rathole::Cli {
    rathole::Cli {
        config_path: Some(config_path),
        server: true,
        ..Default::default()
    }
}

/// Write the rathole TOML from `settings`, then run the relay — rathole, the
/// `:443`/`:80` front and the route watcher — until `shutdown_rx` receives
/// `true`.
///
/// # Errors
///
/// Returns an error if the config cannot be written or loaded, a front
/// listener cannot bind, or rathole exits with an error.
pub async fn run_relay(
    config_path: PathBuf,
    settings: RelaySettings,
    shutdown_rx: broadcast::Receiver<bool>,
) -> anyhow::Result<()> {
    config::write_config(&config_path, &settings.control).await?;
    let settings = settings.front;
    // The watcher is created first so a write made while the initial routes
    // load is still seen as a change; it only starts polling in `try_join!`.
    let router = Arc::new(Router::new(&settings.domain, RouteTable::default()));
    let watcher = watch::watch_routes(
        &config_path,
        Arc::clone(&router),
        watch::POLL_INTERVAL,
        shutdown_rx.resubscribe(),
    );
    let table = watch::load_routes(&config_path)
        .await
        .with_context(|| format!("loading routes from {}", config_path.display()))?;
    tracing::info!(domain = %settings.domain, routes = table.len(), "routes loaded");
    router.replace(table);
    let front = Front::new(Arc::clone(&router), settings.limits);

    let https = TcpListener::bind(settings.https_addr)
        .await
        .with_context(|| format!("binding the TLS front on {}", settings.https_addr))?;
    let http = TcpListener::bind(settings.http_addr)
        .await
        .with_context(|| format!("binding the HTTP redirect on {}", settings.http_addr))?;
    tracing::info!(https = %settings.https_addr, http = %settings.http_addr, "front listening");

    tokio::try_join!(
        Arc::clone(&front).serve_https(https, shutdown_rx.resubscribe()),
        front.serve_http(http, shutdown_rx.resubscribe()),
        watcher,
        rathole::run(build_server_cli(config_path), shutdown_rx),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The CLI we hand rathole must be server-mode and point at our config —
    /// never client-mode (which would make the relay dial out instead of
    /// listen) and never `genkey` (which would print a key and exit).
    #[test]
    fn build_server_cli_is_server_mode_with_config() {
        let cli = build_server_cli(PathBuf::from("/etc/wildflower/relay.toml"));
        assert!(cli.server, "relay must run in server mode");
        assert!(!cli.client, "relay must not run in client mode");
        assert!(cli.genkey.is_none(), "relay must not be in genkey mode");
        assert_eq!(
            cli.config_path.as_deref(),
            Some(std::path::Path::new("/etc/wildflower/relay.toml"))
        );
    }

    /// Golden check that the shipped example config is a valid rathole server
    /// config — catches drift between the example and rathole's schema before
    /// it bites an operator at deploy time. rathole only exposes the async
    /// `Config::from_file`, so the example is written to a temp file and parsed
    /// through the same path an operator's deploy would take.
    #[tokio::test]
    async fn example_config_is_a_valid_rathole_server_config() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("relay.toml");
        std::fs::write(&path, include_str!("../relay.example.toml")).expect("write example config");
        let config = rathole::Config::from_file(&path)
            .await
            .expect("example config must parse");
        assert!(
            config.server.is_some(),
            "example must define a [server] section"
        );
        assert!(
            config.client.is_none(),
            "relay example must not define a [client] section"
        );
    }
}

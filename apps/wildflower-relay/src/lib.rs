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
//!                    (wildflower-relay)                (rathole service <tunnel name>)
//!                                                             │ noise tunnel
//!                                                             ▼
//!                                       device: rathole CLIENT ──► TLS listener
//!                                       (holds the certificate for <tunnel name>.<domain>)
//! ```
//!
//! Each device has a *tunnel*, named by the subdomain it is reached at. A
//! tunnel is a rathole service of the same name, `[server.services.<tunnel
//! name>]`; "service" below means only that rathole table.
//!
//! TLS for `https://<tunnel name>.<domain>` is terminated on the device. The
//! relay routes ciphertext: it reads the ClientHello's server name, maps
//! `<tunnel name>.<domain>` to that tunnel's loopback port, writes a PROXY protocol v2 header carrying the visitor's address, replays
//! the hello and then copies bytes both ways. It holds no certificates or keys
//! for the public surface, and a hostname it cannot route is closed without a
//! byte written rather than answered with a certificate of its own. `:80`
//! only redirects to `https://`.
//!
//! Every tunnel's port is on loopback, so nothing but the front reaches it,
//! and rathole binds it only while that device is connected: a refused
//! connect is how the front knows a device is offline.
//!
//! ## Configuration
//!
//! The environment is the only source of configuration: every setting is a
//! `WILDFLOWER_RELAY_*` variable (see [`settings`], and `relay.example.env`
//! for a commented list). Tunnels come from `WILDFLOWER_RELAY_TUNNELS`, one
//! `name=token` each, with no shared token. On every start the relay
//! renders a fresh rathole TOML from the environment to
//! `WILDFLOWER_RELAY_CONFIG` (see [`config`]) and never reads it back; the
//! front's routes are built from the same tunnel list.
//!
//! ## Deploying
//!
//! `wildflower-relay.service` is a systemd unit for a plain host. It reads
//! the environment from `/etc/wildflower-relay/env` and writes the rathole
//! TOML to `/run/wildflower-relay/relay.toml`, running as a dynamic user
//! allowed only to bind ports 443 and 80. The relay stops cleanly on SIGINT
//! or SIGTERM.
//!
//! `.github/workflows/deploy-relay.yml` deploys it to an Ubuntu 24.04
//! droplet on every push to `main` that touches this crate or `Cargo.lock`,
//! and on manual dispatch. It builds the release binary on `ubuntu-24.04`,
//! then, in the `relay` GitHub environment, writes the environment file from
//! that environment's secrets (`WILDFLOWER_RELAY_DOMAIN`,
//! `WILDFLOWER_RELAY_NOISE_PRIVATE_KEY`, `WILDFLOWER_RELAY_TUNNELS`) and
//! variables (any other setting, left out when unset). It copies the binary,
//! environment file and unit to the host over SSH as the `deploy` user
//! (secrets `RELAY_HOST`, `RELAY_SSH_KEY`, `RELAY_SSH_KNOWN_HOSTS`) and runs
//! `deploy/install.sh` there. That script keeps the running binary and
//! environment file as `.prev`, installs the new ones and the unit, restarts
//! the relay and checks it is active and answers `:80` with a 404. If either
//! check fails it restores the `.prev` files, restarts again and fails the
//! job. `deploy/sudoers` lets `deploy` run exactly those commands as root.
//! A restart drops open connections; devices reconnect their tunnels.

pub mod config;
pub mod front;
pub mod route;
pub mod settings;

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

/// Write the rathole TOML from `settings`, then run the relay — rathole and
/// the `:443`/`:80` front — until `shutdown_rx` receives `true`.
///
/// # Errors
///
/// Returns an error if the config cannot be written, a front listener cannot
/// bind, or rathole exits with an error.
pub async fn run_relay(
    config_path: PathBuf,
    settings: RelaySettings,
    shutdown_rx: broadcast::Receiver<bool>,
) -> anyhow::Result<()> {
    config::write_config(&config_path, &settings.control).await?;
    let routes = RouteTable::from_addrs(settings.control.tunnel_addrs());
    let settings = settings.front;
    tracing::info!(domain = %settings.domain, routes = routes.len(), "routes built");
    let router = Arc::new(Router::new(&settings.domain, routes));
    let front = Front::new(router, settings.limits);

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
        let cli = build_server_cli(PathBuf::from("/run/wildflower-relay/relay.toml"));
        assert!(cli.server, "relay must run in server mode");
        assert!(!cli.client, "relay must not run in client mode");
        assert!(cli.genkey.is_none(), "relay must not be in genkey mode");
        assert_eq!(
            cli.config_path.as_deref(),
            Some(std::path::Path::new("/run/wildflower-relay/relay.toml"))
        );
    }
}

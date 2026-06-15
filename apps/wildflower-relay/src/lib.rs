//! `wildflower-relay` — the self-hostable tunnel relay.
//!
//! This crate is a thin wrapper over the [`rathole`] library in *server*
//! mode. It deliberately implements no tunneling protocol of its own: it
//! loads a rathole server config, runs the relay, and translates a shutdown
//! signal into rathole's broadcast shutdown channel.
//!
//! ## Where it sits
//!
//! ```text
//!   Tauri host (rathole CLIENT)  ──noise──►  wildflower-relay (rathole SERVER)
//!                                                     │  forwards a control
//!                                                     │  port per device
//!                                                     ▼
//!                                            reverse-proxy edge (Caddy/Traefik)
//!                                            terminates TLS, routes
//!                                            https://{sub}.{root} → device port
//! ```
//!
//! rathole forwards raw TCP/UDP only — it has no HTTP virtual-host routing —
//! so subdomain + TLS for the public surface are the edge proxy's job. Keeping
//! that split is intentional: the relay stays a small, audited binary and the
//! battle-tested proxy owns certificates and host routing.

use std::path::PathBuf;

use tokio::sync::broadcast;

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

/// Run the relay until `shutdown_rx` receives `true` (or the underlying
/// rathole instance exits on its own).
///
/// # Errors
///
/// Returns an error if rathole fails to load the config, bind its control
/// port, or exits with a transport error.
pub async fn run_relay(
    config_path: PathBuf,
    shutdown_rx: broadcast::Receiver<bool>,
) -> anyhow::Result<()> {
    rathole::run(build_server_cli(config_path), shutdown_rx).await
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

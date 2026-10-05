//! `wildflower-relay` — the self-hostable tunnel relay.
//!
//! One process runs these side by side on one shutdown broadcast:
//!
//! - the [`rathole`] library in *server* mode, which holds a noise-encrypted
//!   tunnel per device and implements no protocol of our own;
//! - a small TCP [`front`] on `:443` and `:80` that routes each visitor to a
//!   device's tunnel by the server name in the TLS ClientHello; and
//! - the relay's own HTTPS [`site`] on its own hostname, with a certificate
//!   from Let's Encrypt that [`site::acme`] keeps ordered and renewed.
//!
//! ## Where it sits
//!
//! ```text
//!   browser ──TLS──► front :443 ── reads SNI only ──► rathole service <tunnel name>
//!                    (wildflower-relay, in process)          │ noise tunnel
//!                                                            ▼
//!                                      device: rathole CLIENT ──► TLS listener
//!                                      (holds the certificate for <tunnel name>.<domain>)
//! ```
//!
//! Each device has a *tunnel*, named by the subdomain it is reached at. A
//! tunnel is a rathole service of the same name, `[server.services.<tunnel
//! name>]`; "service" below means only that rathole table.
//!
//! TLS for `https://<tunnel name>.<domain>` is terminated on the device. The
//! relay routes ciphertext: it reads the ClientHello's server name, hands the
//! connection to the rathole service of the tunnel `<tunnel name>.<domain>`
//! names, writes a PROXY protocol v2 header carrying the visitor's address,
//! replays the hello and then copies bytes both ways. It holds no
//! certificates or keys for any tunnel's hostname, and a hostname it cannot
//! route is closed without a byte written rather than answered with a
//! certificate of its own. `:80` only redirects to `https://`.
//!
//! The one exception is the relay's own hostname, `<domain>` itself. There
//! the front hands the connection to the [`site`], which terminates TLS with
//! the relay's own certificate and serves `GET /health` (`200
//! {"status":"pass"}`), `GET /rathole`, the public settings a rathole
//! client needs to dial the relay (see
//! [`RelaySettings::public_rathole_settings`]), and `GET /me`, a signed
//! request's tunnel (see "Signed requests" below). The certificate comes from
//! Let's Encrypt over TLS-ALPN-01, whose validation handshakes reach the
//! site through the same routing, and is cached in the state directory
//! (`WILDFLOWER_RELAY_STATE_DIR`), so a restart reuses it instead of
//! ordering again. Until the first certificate is issued, TLS handshakes for
//! the relay's hostname fail. `WILDFLOWER_RELAY_ACME_STAGING=true` orders
//! from Let's Encrypt's staging directory instead, whose certificates
//! browsers do not trust.
//!
//! rathole binds no port for a tunnel: the front puts each visitor into the
//! tunnel's queue in process, through [`Tunnels`], so nothing but the front
//! reaches a tunnel. rathole reports a tunnel's queue only while that
//! device is connected: a tunnel with none is how the front knows a device
//! is offline.
//!
//! ## Signed requests
//!
//! A device authenticates to the relay's site with its tunnel token without
//! sending it: it signs the request with HTTP Message Signatures (RFC 9421),
//! `alg="hmac-sha256"`, `keyid` its tunnel name and the token's UTF-8 bytes
//! as the key. The operator signs with `keyid="admin"` and
//! `WILDFLOWER_RELAY_ADMIN_KEY`, so `admin` is not a valid tunnel name.
//! `GET /me` answers a tunnel's signed request with `{"tunnel_name":
//! "<tunnel name>", "public_host": "<tunnel name>.<domain>"}`; a request
//! that fails verification gets a bare `401`.
//!
//! To sign `GET https://relay.example.com/me` as tunnel `alice` at unix
//! time `1700000000`, a client builds this signature base (lines joined
//! with `\n`, no trailing newline):
//!
//! ```text
//! "@method": GET
//! "@target-uri": https://relay.example.com/me
//! "@signature-params": ("@method" "@target-uri");created=1700000000;nonce="<random>";keyid="alice";alg="hmac-sha256"
//! ```
//!
//! and sends the HMAC-SHA256 of it under the token as:
//!
//! ```text
//! Signature-Input: sig=("@method" "@target-uri");created=1700000000;nonce="<random>";keyid="alice";alg="hmac-sha256"
//! Signature: sig=:<base64 MAC>:
//! ```
//!
//! - `created` must be within 60 seconds of the relay's clock, and each
//!   `nonce` is accepted once (a fresh random value per request, at most
//!   128 characters).
//! - `@target-uri` is the URL fetched, as a URL parser serializes it:
//!   `https`, the lowercase host without `:443`, then the path and query
//!   exactly as sent. The relay rebuilds it from `Host` and the request
//!   target.
//! - A request with a body also sends `Content-Digest: sha-256=:<base64
//!   SHA-256 of the body>:` (RFC 9530) and covers `"content-digest"` after
//!   `"@target-uri"`. Bodies are limited to 64 KiB.
//! - Exactly one signature per request; other components may be covered
//!   too, but none with component parameters.
//!
//! [`site::signature`] has the full rules.
//!
//! ## Configuration
//!
//! The environment is the only source of configuration: every setting is a
//! `WILDFLOWER_RELAY_*` variable (see [`settings`], and `relay.example.env`
//! for a commented list). Tunnels come from `WILDFLOWER_RELAY_TUNNELS`, one
//! `name=token` each, with no shared token. On every start the relay builds
//! the rathole config from the environment in memory (see [`config`]) and
//! runs rathole on it; the front's routes are built from the same tunnel
//! list. The tunnels stay as they are while the relay runs.
//!
//! ## Deploying
//!
//! `wildflower-relay.service` is a systemd unit for a plain host. It reads
//! the environment from `/etc/wildflower-relay/env` and keeps its state in
//! `/var/lib/wildflower-relay`, running as a dynamic user allowed only to
//! bind ports 443 and 80. The relay stops cleanly on SIGINT or SIGTERM.
//!
//! `.github/workflows/deploy-relay.yml` deploys it to an Ubuntu 24.04
//! droplet on every push to `main` that touches this crate, one of its path
//! dependencies (`shared-structures-rust`, `rathole-settings-rust`) or
//! `Cargo.lock`, and on manual dispatch. It builds the release binary on
//! `ubuntu-24.04`, then, in the `relay` GitHub environment, writes the
//! environment file from
//! that environment's secrets (`WILDFLOWER_RELAY_DOMAIN`,
//! `WILDFLOWER_RELAY_NOISE_PRIVATE_KEY`, `WILDFLOWER_RELAY_TUNNELS`) and
//! variables (any other setting, left out when unset). It copies the binary,
//! environment file and unit to the host over SSH as the `deploy` user
//! (secrets `RELAY_HOST`, `RELAY_SSH_KEY`, `RELAY_SSH_KNOWN_HOSTS`) and runs
//! `deploy/install.sh` there. If the binary and environment file match what
//! is already running, the script leaves the relay alone. Otherwise it keeps
//! the running ones as `.prev`, installs the new ones, restarts the relay and
//! checks that it is active, answers `:80` with a 404, accepts connections
//! on `:443` and the control port, and answers `https://<domain>/health`.
//! On a new host the first start orders the certificate, so the checks
//! wait up to two minutes. If any of that fails it
//! restores the `.prev` files, restarts again and fails the job.
//! `deploy/sudoers` lets `deploy` run exactly those commands as root. The
//! unit is installed by hand, because writing one is as good as root; the
//! deploy stops before changing anything if the installed unit differs from
//! this crate's. The binary lives in `/opt/wildflower-relay`, off root's
//! `PATH`, since `deploy` decides its contents.
//! A restart drops open connections; devices reconnect their tunnels.

pub mod config;
pub mod front;
pub mod route;
pub mod settings;
pub mod site;
pub mod tunnels;

use std::path::Path;
use std::sync::Arc;

use anyhow::Context;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

pub use front::{Front, Limits};
pub use route::{Route, RouteTable, Router};
pub use settings::{AcmeSettings, ControlSettings, FrontSettings, RelaySettings, Secret};
pub use site::signature::{SignedBy, Verifier};
pub use site::Site;
pub use tunnels::{TunnelDown, Tunnels};

/// Build the rathole config from `settings`, then run the relay — rathole, the
/// `:443`/`:80` front and the site's certificate upkeep — until
/// `shutdown_rx` receives `true`.
///
/// # Errors
///
/// Returns an error if the config is invalid, the state directory
/// cannot be created, a front listener cannot bind, or rathole exits with an
/// error.
pub async fn run_relay(
    settings: RelaySettings,
    shutdown_rx: broadcast::Receiver<bool>,
) -> anyhow::Result<()> {
    let rathole_config = config::build(&settings.control)?;
    let routes = RouteTable::from_names(settings.control.tunnel_names());
    create_state_dir(&settings.state_dir)
        .with_context(|| format!("creating {}", settings.state_dir.display()))?;
    let local_hostnames = settings.front.local_hostnames();
    let acme = site::acme::state(&local_hostnames, &settings.acme, &settings.state_dir);
    let verifier = Verifier::new(&settings.control.tunnels, settings.admin_key.clone());
    let site = Site::new(
        acme.resolver(),
        settings.public_rathole_settings(),
        verifier,
    );
    let settings = settings.front;
    tracing::info!(domain = %settings.domain, routes = routes.len(), "routes built");
    let router = Arc::new(Router::new(&settings.domain, local_hostnames, routes));
    let tunnels = Tunnels::default();
    let front = Front::new(router, tunnels.clone(), site, settings.limits);

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
        site::acme::drive(acme, shutdown_rx.resubscribe()),
        tunnels.serve(rathole_config, shutdown_rx),
    )?;
    Ok(())
}

/// Create the state directory, and any missing parents, readable by the
/// owner only: it holds the ACME account key. Under systemd,
/// `StateDirectory=` has already created it.
fn create_state_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

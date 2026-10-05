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
//!   browser ──TLS──► front :443 ── reads SNI only ──► visitor queue of
//!                    (wildflower-relay)                rathole service <tunnel name>
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
//! `<tunnel name>.<domain>` to that tunnel, hands rathole one end of an
//! in-process pipe as a visitor of it, writes a PROXY protocol v2 header
//! carrying the visitor's address and the replayed hello into the other
//! end, and then copies bytes both ways, half-closes included. It holds no
//! certificates or keys for any tunnel's hostname, and a hostname it cannot
//! route is closed without a byte written rather than answered with a
//! certificate of its own. `:80` only redirects to `https://`.
//!
//! The exception is the relay's own hostnames, `<domain>` itself and
//! `admin.<domain>`. There the front hands the connection to the [`site`],
//! which terminates TLS with the relay's own certificate and serves `GET
//! /health` (`200 {"status":"pass"}`), `GET /rathole`, the public settings a
//! rathole client needs to dial the relay (see
//! [`RelaySettings::public_rathole_settings`]), `GET /me`, a signed
//! request's tunnel, and on `admin.<domain>` the admin API (see "Signed
//! requests" below). The certificate, for both names, comes from
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
//! is offline, and it closes the visitor without a byte written.
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
//! ### Admin API
//!
//! With `WILDFLOWER_RELAY_ADMIN_KEY` set, `https://admin.<domain>` serves an
//! API for tunnels, to requests signed with `keyid="admin"`. It is the only
//! way to create a tunnel: without the key it is not served, and the relay
//! serves only the tunnels already stored. On any other hostname its paths
//! are `404`, and a request signed by a tunnel, or not verified, is a bare
//! `401`.
//!
//! - `POST /api/tunnels` with `Content-Type: application/json` and
//!   `{"email": "<owner>", "name": "<tunnel name>"}` creates a tunnel and
//!   answers `201 {"name", "token", "public_host"}`. The token, 32 random
//!   bytes as unpadded base64url, is shown only in this answer. `name` is
//!   optional: without it the relay picks two random words from the EFF
//!   short wordlist, e.g. `acorn-shady`, never anything taken from the
//!   email, since names appear in cleartext SNI and in Certificate
//!   Transparency logs. A given name must be a lowercase DNS label (`422`
//!   otherwise), and not reserved or in use (`409`). `admin` is reserved.
//! - `GET /api/tunnels` lists every tunnel as `{"name", "email",
//!   "public_host", "created_at"}`, without tokens. `created_at` is Unix
//!   epoch seconds.
//! - `DELETE /api/tunnels/{name}` deletes a tunnel (`204`), or is `404` when
//!   no tunnel has the name.
//!
//! A created tunnel's device can connect and sign at once. A deleted one can
//! no longer sign or be routed to, and rathole drops its tunnel.
//! A `POST` has a body, so its signature covers `content-digest`;
//! `content-type` may be covered too but need not be.
//!
//! ### Admin UI
//!
//! `https://admin.<domain>/` also serves a page for the admin API: the
//! static build of `apps/relay/web`, embedded in the binary (see
//! [`site`]'s `admin_ui`), under a `Content-Security-Policy` that allows
//! only its own files. To manage tunnels, the operator opens it and pastes
//! `WILDFLOWER_RELAY_ADMIN_KEY` once; the browser keeps a non-extractable
//! signing key made from it, signs each API call with it as above, and
//! forgets it on Sign out. The page lists the tunnels, creates one (showing
//! its token once, to hand to the tunnel's owner) and deletes one. A `401`
//! there means the key is wrong or the operator's clock is more than a
//! minute off the relay's. The relay keeps no session: without the key the
//! page can do nothing.
//!
//! ## Configuration
//!
//! The environment is the only source of settings: every setting is a
//! `WILDFLOWER_RELAY_*` variable (see [`settings`], and `relay.example.env`
//! for a commented list). Tunnels come only from the admin API, which keeps
//! them, each with its own token, in SQLite at
//! `<WILDFLOWER_RELAY_STATE_DIR>/tunnels.db`. On every start the relay
//! builds rathole's config for them in memory (see [`config`]); no rathole
//! file is written or read. Each change through the admin API reaches the
//! running rathole server as one service added or deleted, and the same
//! change inserts or removes the tunnel in the [`ServedTunnels`] the front
//! routes by and the site verifies signatures against (see
//! [`TunnelRegistry`]).
//!
//! The tunnels are layered like the slices' stores:
//!
//!  - [`domain`] — pure: the [`Tunnel`] and [`StoredTunnel`] types, the
//!    [`TunnelStore`] persistence *port*, the failure vocabulary
//!    ([`TunnelError`](domain::TunnelError)), and the admin-gated
//!    capabilities (`domain::capabilities`) that decide a read, create or
//!    delete and drive the store through the port.
//!  - [`db`] — the [`SqliteTunnelStore`] adapter implementing that port with
//!    Diesel over a `persistence_rust::DieselPool` onto `tunnels.db`, and its
//!    migrations (`migrations/`).
//!  - [`live_bindings`] — the [`TunnelRegistry`] router state that holds the
//!    store and what serves the stored tunnels, and the bindings that build
//!    each capability from it for an admin-signed request, run it off the
//!    async runtime and serve the change: rathole's services and the
//!    [`ServedTunnels`].
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
//! dependencies (`shared-structures-rust`, `rathole-settings-rust`,
//! `persistence-rust`), the admin UI (`apps/relay/web`, `slices/relay`),
//! `Cargo.lock` or `pnpm-lock.yaml`, and on manual dispatch. It builds the
//! admin UI and then the release binary, which embeds it, on
//! `ubuntu-24.04`, then, in the `relay` GitHub
//! environment, writes the environment file from that environment's secrets
//! (`WILDFLOWER_RELAY_DOMAIN`, `WILDFLOWER_RELAY_NOISE_PRIVATE_KEY`,
//! `WILDFLOWER_RELAY_ADMIN_KEY`) and
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
pub mod db;
pub mod domain;
pub mod front;
pub mod live_bindings;
pub mod route;
pub mod served;
pub mod settings;
pub mod site;
#[cfg(test)]
mod test_support;
pub mod tunnels;

use std::path::Path;
use std::sync::Arc;

use anyhow::Context;
use tokio::net::TcpListener;
use tokio::sync::broadcast;

pub use db::SqliteTunnelStore;
pub use domain::{StoredTunnel, Tunnel, TunnelStore};
pub use front::{Front, Limits};
pub use live_bindings::state::{RatholeFeed, TunnelRegistry};
pub use route::{Route, Router};
pub use served::ServedTunnels;
pub use settings::{AcmeSettings, ControlSettings, FrontSettings, RelaySettings, Secret};
pub use site::signature::{SignedBy, Verifier};
pub use site::Site;
pub use tunnels::{TunnelDown, Tunnels};

/// Load the stored tunnels, then run the relay — rathole on a config built
/// for them, the `:443`/`:80` front and the site's certificate upkeep —
/// until `shutdown_rx` receives `true`.
///
/// # Errors
///
/// Returns an error if the state directory cannot be created, the tunnels
/// cannot be loaded (see [`TunnelRegistry::open`]), a front listener cannot
/// bind, or rathole exits with an error.
pub async fn run_relay(
    settings: RelaySettings,
    shutdown_rx: broadcast::Receiver<bool>,
) -> anyhow::Result<()> {
    create_state_dir(&settings.state_dir)
        .with_context(|| format!("creating {}", settings.state_dir.display()))?;
    let (registry, rathole) = TunnelRegistry::open(&settings).await?;
    let registry = Arc::new(registry);
    let acme = site::acme::state(
        &settings.front.local_hostnames(),
        &settings.acme,
        &settings.state_dir,
    );
    // Without an admin key nothing could sign for the admin API, and no
    // tunnel can be created: the relay serves only the stored ones.
    let admin = settings.admin_key.is_some().then(|| Arc::clone(&registry));
    tracing::info!(enabled = admin.is_some(), "admin API");
    let site = Site::new(
        acme.resolver(),
        settings.public_rathole_settings(),
        registry.verifier(),
        admin,
    );
    let settings = settings.front;
    tracing::info!(domain = %settings.domain, "routes built");
    let tunnels = Tunnels::default();
    let front = Front::new(registry.router(), tunnels.clone(), site, settings.limits);

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
        tunnels.serve(rathole.initial_config, rathole.changes, shutdown_rx),
    )?;
    Ok(())
}

/// Create the state directory, and any missing parents, readable by the
/// owner only: it holds the ACME account key and the tunnel store. Under systemd,
/// `StateDirectory=` has already created it.
fn create_state_dir(path: &Path) -> std::io::Result<()> {
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(path)
}

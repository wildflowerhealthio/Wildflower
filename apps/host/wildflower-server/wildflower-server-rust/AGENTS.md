# AGENTS.md — apps/host/wildflower-server/wildflower-server-rust

The **Wildflower server**: the API the Tauri host runs, served on a loopback
port and on the tunnel. Part of the host app, `apps/host/`, in the
[`wildflower-server/`](../AGENTS.md) group beside the server slices' crates
only it composes. Rust-only, no `-core`.

## Package roles

- **`wildflower-server-rust`** — `set_up(config, host, observers)` opens the
  host's databases, sets up every server slice (gatekeeper, FHIR R4, OHIF, collector,
  request log, apps, databases), gates them into one inner router, starts the
  tunnel and the reachability monitor, and binds the loopback port;
  `WildflowerServer::serve(shutdown)` serves both listeners until `shutdown` is
  cancelled. It derives the server's public origin from its domain once
  and hands it to fhir-r4-rust (HFS's `base_url`), apps (every launch's origin) and the
  tunnel front. The unmatched-route `404` is here too.
  - **Two listeners, two routers.** Each listener serves its own router,
    built from the one inner router:
    - The **loopback listener** (the bound loopback port) serves the local
      clients and a front run on this machine. Its router adds the loopback
      owner trust, the loopback-peer gate, CORS and the forwarded-request
      report. A request with no `Forwarded` is a direct-local caller and gets
      the host owner token; one a front relayed carries the front's
      `Forwarded`.
    - The **tunnel listener** serves the tunnel. The tunnel has no route on
      the server and binds no port: its rathole client hands each visitor's
      stream over in process, on a channel `set_up` creates. Each stream runs
      its opening handshake on a task of its own
      (`handshake_tunnel_connection`), at most 64 at once, the rest waiting on
      the channel: its PROXY protocol v2 header, when it opens with the whole
      signature, is read for the visitor's address, then its TLS is accepted,
      both under one 5 s timeout. A
      malformed or late header, a failed or late handshake, or an SNI naming
      another host closes the connection; a TLS-ALPN-01 validation handshake
      (ALPN `acme-tls/1`) is answered and closed. The tunnel router adds the forwarded-request report, the
      tunnel front and, outermost so even a `421` is readable cross-origin,
      CORS, and never the owner trust or the loopback-peer gate. The front drops any inbound `Forwarded`, answers
      `421` (unreported) unless every host the request names (each `Host`, and
      the request target's authority) is the server's domain, and writes
      `Forwarded: for=<visitor>;host="<domain>";proto=https` (no `for`
      without a PROXY address), so every served-origin reader treats the
      request as forwarded, at the public origin. `WildflowerServer` holds
      the tunnel's daemon, so it dials for exactly as long as the server
      serves.
  - **The device certificate** (`adapters/acme_certificate.rs`) is
    the tunnel listener's certificate for the server's domain, from
    rustls-acme over TLS-ALPN-01, the CA reaching the device through the
    relay and the tunnel like any visitor. `set_up` starts it for the run and
    hands its resolver to the tunnel listener's `TunnelTlsAcceptor`, and
    `WildflowerServer` holds it like the tunnel daemon, ordering and
    renewing until it is dropped: a valid cached certificate is deployed, a missing or expired one
    is ordered at once, and it is renewed once a third of its lifetime is
    left. A failed order is retried by rustls-acme with backoff while the
    server keeps running; until a certificate is deployed, tunnel handshakes
    fail. Where it comes from is the host's
    `WildflowerServerConfig::device_certificate`, a `DeviceCertificateConfig`
    built from the server's record: its `certificate_authority` (Let's
    Encrypt's staging or production CA), ordered from at the directory the
    CA names (`CertificateAuthority::directory_url`), so the issuer a state
    or history reports is always the CA ordered from. Only the production
    CA's certificates are browser-trusted
    (`CertificateAuthority::is_browser_trusted`). Tests order from
    `CertificateAuthority::UnreachableForTests`, which only the
    `test-support` feature has: nothing answers at its directory. The order
    has no contact.
    Keys are files: the certificate and its key in `certificate_dir`, the
    server's own, and the account key, one per CA, in `acme_account_dir`,
    shared by the install's servers. Starting the certificate makes both
    folders readable by this user only, and a folder that can't be created
    fails `set_up`.
  - **The certificate's state** (`domain/certificate_state.rs`) is a
    `CertificateState`: its status (`NotIssued`, `Ordering`,
    `NoRenewalNeeded`, `RenewalDue`, `Expired`, `OrderFailing`), its issuer,
    the certificate `held` (`IssuedCertificate`: validity and the SHA-256
    fingerprint of its leaf) and the last error (`CertificateOrderError`: an
    order's, rate limited, with when to retry, a challenge that didn't reach
    the device, the CA unreachable, or other; or `Cache`, the certificate or
    account cache unreadable or unwritable). Only an order's error with no
    valid certificate held makes a run `OrderFailing`: rustls-acme keeps
    ordering through a cache fault. A run keeps
    what it has observed of its certificate as an `ObservedCertificate`,
    built from rustls-acme's events and the certificate read from the cache
    entry rustls-acme last loaded or stored (`LastEntryCertCache`), derives
    its state from that, and publishes it on
    `ServerObservers::certificate_tx` at start, on each event, and when the
    certificate's renewal falls due or it expires, which it checks against
    the wall clock at least once a minute, since a suspended device's
    monotonic clock stops. A cache entry is read as
    rustls-acme reads it before deploying it (a PKCS #8 ECDSA key, then the
    chain), so an entry it refuses is never a certificate held, and one it
    refuses at start is dropped. `RenewalDue` is a third or less of the
    lifetime left, rustls-acme's renewal point. Any server
    without a run's state has what its cache says
    (`cached_certificate_state`): `NotIssued`, `NoRenewalNeeded`,
    `RenewalDue` or `Expired`, or `CacheUnreadable` with the error when the
    cache can't be read or holds an entry that isn't a certificate; never
    `Ordering` or `OrderFailing`. `Expired` is only ever the cache's, and
    renews when the server starts. In a run, a cache that can't be read is a
    `cache` error, as above.
  - **The certificate history** (`adapters/certificate_history.rs`) is
    `history.json` in the server's `certificate_dir`, a JSON array of
    `CertificateHistoryEntry` (`{deployedAt, issuer, fingerprint, notBefore,
notAfter}`). A run appends each certificate it deploys unless the history
    records it already, replacing the file atomically;
    `read_certificate_history` reads it.
  - **`/health`** follows `draft-inadarei-api-health-check-06`
    (`wildflowerhealthio_shared_structures::health_check`): `application/health+json`,
    uncached, `200` for `pass`/`warn` and `503` for `fail`, with exactly two
    checks, a functional breakdown: `server` (a `wildflower.sqlite` pool
    connection answering `SELECT 1`) and `connectivity` (the tunnel daemon's
    published `HealthStatus`; nothing sets it to `warn` or `fail` yet). The
    overall status is the worst check's. Each check is in-process and bounded
    at 1 s. The route is public and unauthenticated, so the report
    carries only statuses: no output, observed values, errors or versions.
  - **Reachability** is the server's own: the reachability monitor GETs
    `https://<domain>/health`, out to the relay and back down the
    tunnel, 400 ms after start and every 400 ms until it answers, each bounded
    at 3 s, and publishes `ServerHealth` (`Unreachable { error }` while it
    doesn't, when the reason changes, then `Reachable(HealthReport)`) on the
    host's `ServerObservers::server_health_tx`. The first answer ends the
    probing: every app already reaches the server through the same relay, and
    the next run confirms reach again. The probe trusts only publicly trusted
    CAs, so it fails while no certificate is deployed, and against a staging
    certificate. `WildflowerServer` holds the monitor
    like the tunnel daemon, so it also stops when the server stops serving.
    The forwarded-request report skips `/health`, so the probes stay out of
    the request log and the request notifications.
  - Layout: `config.rs` at the crate root, the host's inputs
    (`WildflowerServerConfig` with its `DeviceCertificateConfig`, `HostPorts`,
    `ServerObservers`); `domain/`
    `ServerHealth` and the reachability monitor with its `HealthProbe` port,
    `CertificateAuthority`, `CertificateState` with the
    `ObservedCertificate` a run derives it from, and
    `CertificateHistoryEntry`;
    `adapters/` ports implemented here (apps' `AppLaunchScopes` and
    `LaunchContextMinter` from gatekeeper, the monitor's `HealthProbe` over
    reqwest), the device certificate over rustls-acme with its state, and
    the certificate history file; `http/` the
    server's own middleware (CORS, the loopback owner trust, the
    forwarded-request report, the tunnel front), the tunnel listener with its
    PROXY header reader and its TLS acceptor, the `/health` checks and the
    `404`; `live_bindings/` composition only: `set_up`, `WildflowerServer`
    and the database catalogue.
  - The `test-support` feature adds `WildflowerServer::tunnel_stream_tx`
    for `tests/serve.rs`, which hands the tunnel listener connections the way
    the tunnel does, over TLS with a self-signed certificate it puts in the
    certificate cache, and `CertificateAuthority::UnreachableForTests`, the
    CA every test that runs a server orders from. Only dev-dependencies
    enable it: the crate's own and `servers-rust`'s.
  - `tests/scope_claims.rs` pins a seam between two slices this crate
    composes: gatekeeper's bearer gate inserts the `ScopeClaims` databases'
    `Scoped<…>` capabilities read. It drives both real crates together, since
    each slice's own tests fabricate the extension.

## Layering

- **No `tauri` dependency**, so the crate compiles and tests without GTK, in the
  non-Tauri partition of `scripts/checks/rust.sh`.
- **The host hands in what it owns.** `WildflowerServerConfig` carries the values
  `apps/host/host-app` derives at build time (`tauri-shared-config.json`),
  from its platform paths (the server's folder, the FHIR SearchParameter
  bundle dir) or from the server's record (the tunnel's relay settings, the
  domain, and the `DeviceCertificateConfig` its
  `ServerRecord::device_certificate_config` builds: the CA, the server's
  certificate folder and the install's ACME account folder). `HostPorts` carries its native adapters as trait
  objects (`LoopbackConsentPrompt`, `OnDeviceWebviewHandle`) and the `watch`
  senders its bridge reads. The server reads none of the host's build-time
  configuration or platform paths itself.
- **The host watches the server through `ServerObservers`.** Host-owned
  senders: the server's `ServerHealth` through its public origin, published by
  the reachability monitor until it first answers, on a channel the host makes
  for each run; the server's `CertificateState`, published by the device
  certificate for as long as the server runs, on a channel the host makes for
  each run; and each forwarded request (every request through the tunnel,
  and each one a front run on this machine relayed), on a channel the host
  shares across runs, reported by the forwarded-request layer as a
  `ForwardedRequest` record: the
  visitor's address, the path reduced to its route, the status, and the
  `RequestCaller` or `RequestRefusal` the gatekeeper bearer gates stamped on the
  response. The layer sends the same record to the request-log slice.
  A full report channel drops the report; it never delays a response.
- **Background tasks die with the runtime.** Slices `tokio::spawn` long-lived
  tasks onto the runtime that runs `set_up`; cancelling `shutdown` stops the
  listeners, not those tasks (the tunnel's supervisor, the reachability
  monitor and the device certificate's ordering and renewal are the exception: they
  stop when `serve` returns). The host runs
  each server as a unit on the unit runner, which gives each run a dedicated
  runtime and shuts it down when the run ends, which is what ends them.

## References

- [wildflower-server AGENTS.md](../AGENTS.md) — the group this crate sits in.
- [slices/AGENTS.md](../../../../slices/AGENTS.md) — slice layering rules this
  crate follows.
- [Server Runs Explanation](../../servers/docs/Server%20Runs%20Explanation.md)
  — how the host runs, restarts and watches each server, as a `ServerUnit`.
- [Origins Explanation](../../../../docs/Origins/Explanation.md) — the two listeners,
  and loopback vs forwarded served origins, which the owner trust, the 404 and
  HFS's base URL resolve per request.
- [Shared Diesel Pool Explanation](../../../../docs/Persistence/Shared%20Diesel%20Pool%20Explanation.md)
  — the pool `set_up` builds and shares across the diesel-backed slices.

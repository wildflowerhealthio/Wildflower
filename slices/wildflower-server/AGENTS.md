# AGENTS.md — slices/wildflower-server

The **Wildflower server**: the API the Tauri host runs, served on a loopback
port and on the tunnel. Rust-only, no `-core`.

## Package roles

- **`wildflower-server-rust`** — `set_up(config, host, observers)` opens the
  host's databases, sets up every server slice (gatekeeper, emr, OHIF, collector,
  request log, apps, databases), gates them into one inner router, starts the
  tunnel and the reachability monitor, and binds the loopback port;
  `WildflowerServer::serve(shutdown)` serves both listeners until `shutdown` is
  cancelled. It derives the server's public origin from its public host once
  and hands it to emr (HFS's `base_url`), apps (every launch's origin) and the
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
      stream over in process, on a channel `set_up` creates. Each stream is
      prepared on a task of its own (`prepare_tunnel_connection`), at most 64
      at once, the rest waiting on the channel: its PROXY protocol v2 header,
      when it opens with the whole signature, is read under a 5 s timeout for
      the visitor's address, and a malformed or late header closes the
      connection. The tunnel router adds the forwarded-request report, the
      tunnel front and, outermost so even a `421` is readable cross-origin,
      CORS, and never the owner trust or the loopback-peer gate. The front drops any inbound `Forwarded`, answers
      `421` (unreported) unless every host the request names (each `Host`, and
      the request target's authority) is the server's public host, and writes
      `Forwarded: for=<visitor>;host="<public host>";proto=https` (no `for`
      without a PROXY address), so every served-origin reader treats the
      request as forwarded, at the public origin. `WildflowerServer` holds
      the tunnel's daemon, so it dials for exactly as long as the server
      serves.
  - **`/health`** follows `draft-inadarei-api-health-check-06`
    (`shared_structures_rust::health_check`): `application/health+json`,
    uncached, `200` for `pass`/`warn` and `503` for `fail`, with exactly two
    checks, a functional breakdown: `server` (a `wildflower.sqlite` pool
    connection answering `SELECT 1`) and `connectivity` (the tunnel daemon's
    published `HealthStatus`; nothing sets it to `warn` or `fail` yet). The
    overall status is the worst check's. Each check is in-process and bounded
    at 1 s. The route is public and unauthenticated, so the report
    carries only statuses: no output, observed values, errors or versions.
  - **Reachability** is the server's own: the reachability monitor GETs
    `https://<public host>/health`, out to the relay and back down the
    tunnel, 400 ms after start and every 400 ms until it answers, each bounded
    at 3 s, and publishes `ServerHealth` (`Unreachable { error }` while it
    doesn't, when the reason changes, then `Reachable(HealthReport)`) on the
    host's `ServerObservers::server_health_tx`. The first answer ends the
    probing: every app already reaches the server through the same relay, and
    the next run confirms reach again. `WildflowerServer` holds the monitor
    like the tunnel daemon, so it also stops when the server stops serving.
    The forwarded-request report skips `/health`, so the probes stay out of
    the request log and the request notifications.
  - Layout: `config.rs` at the crate root, the host's inputs
    (`WildflowerServerConfig`, `HostPorts`, `ServerObservers`); `domain/`
    `ServerHealth` and the reachability monitor with its `HealthProbe` port;
    `adapters/` ports implemented here (apps' `AppLaunchScopes` and
    `LaunchContextMinter` from gatekeeper, the monitor's `HealthProbe` over
    reqwest); `http/` the
    server's own middleware (CORS, the loopback owner trust, the
    forwarded-request report, the tunnel front), the tunnel listener and its
    PROXY header reader, the `/health` checks and the `404`;
    `live_bindings/` `set_up`, `WildflowerServer` and the database catalogue.
  - The `test-support` feature adds `WildflowerServer::tunnel_stream_tx`
    for `tests/serve.rs`, which hands the tunnel listener connections the way
    the tunnel does. Only the crate's own dev-dependency enables it.

## Layering

- **No `tauri` dependency**, so the crate compiles and tests without GTK, in the
  non-Tauri partition of `scripts/checks/rust.sh`.
- **The host hands in what it owns.** `WildflowerServerConfig` carries the values
  `apps/wildflower-tauri` derives at build time (`tauri-shared-config.json`),
  from its platform paths (the server's folder, the FHIR SearchParameter bundle
  dir) or from the server's record (the tunnel's relay settings and the public
  host). `HostPorts` carries its native adapters as trait
  objects (`LoopbackConsentPrompt`, `OnDeviceWebviewHandle`) and the `watch`
  senders its bridge reads. The server reads none of the host's build-time
  configuration or platform paths itself.
- **The host watches the server through `ServerObservers`.** Host-owned
  senders: the server's `ServerHealth` through its public origin, published by
  the reachability monitor until it first answers, on a channel the host makes
  for each run, and each forwarded request (every request through the tunnel,
  and each one a front run on this machine relayed), on a channel the host
  shares across runs, reported by the forwarded-request layer as a
  `ForwardedRequest` record: the
  visitor's address, the path reduced to its route, the status, and the
  `RequestCaller` or `RequestRefusal` the gatekeeper bearer gates stamped on the
  response. The layer sends the same record to the request-log slice.
  A full report channel drops the report; it never delays a response.
- **Background tasks die with the runtime.** Slices `tokio::spawn` long-lived
  tasks onto the runtime that runs `set_up`; cancelling `shutdown` stops the
  listeners, not those tasks (the tunnel's supervisor and the reachability
  monitor are the exception: they stop when `serve` returns). The host runs
  each server as a unit on the unit runner, which gives each run a dedicated
  runtime and shuts it down when the run ends, which is what ends them.

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
- [Server Runs Explanation](../servers/docs/Server%20Runs%20Explanation.md)
  — how the host runs, restarts and watches each server, as a `ServerUnit`.
- [Origins Explanation](../../docs/Origins/Explanation.md) — the two listeners,
  and loopback vs forwarded served origins, which the owner trust, the 404 and
  HFS's base URL resolve per request.
- [Shared Diesel Pool Explanation](../../docs/Persistence/Shared%20Diesel%20Pool%20Explanation.md)
  — the pool `set_up` builds and shares across the diesel-backed slices.

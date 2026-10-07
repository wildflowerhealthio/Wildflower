# AGENTS.md — slices/wildflower-server

The **Wildflower server**: the loopback API the Tauri host runs. Rust-only, no
`-core`.

## Package roles

- **`wildflower-server-rust`** — `set_up(config, host, observers)` opens the
  host's databases, sets up every server slice (gatekeeper, emr, OHIF, collector,
  request log, apps, databases), gates them, wraps them in the loopback owner
  trust, the loopback-peer gate, the CORS policy and the forwarded-request
  observer, starts the tunnel and the reachability monitor, and binds the
  loopback port; `WildflowerServer::serve(shutdown)` serves the result until
  `shutdown` is cancelled. The tunnel has no route on the server and only
  dials: `WildflowerServer` holds its daemon, so it dials for exactly as long
  as the server serves. It derives the server's public origin from its public
  host once and hands it to emr (HFS's `base_url`) and apps (every launch's
  origin). The unmatched-route `404` is here too.
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
    host's `ServerObservers::server_health_sender`. The first answer ends the
    probing: every app already reaches the server through the same relay, and
    the next run confirms reach again. `WildflowerServer` holds the monitor
    like the tunnel daemon, so it also stops when the server stops serving.
    The forwarded-request report skips `/health`, so the probes stay out of
    the request log and the request notifications.
  - Layout: `config.rs` at the crate root, the host's inputs
    (`WildflowerServerConfig`, `HostPorts`, `ServerObservers`); `domain/`
    `ServerHealth` and the reachability monitor with its `HealthProbe` port;
    `adapters/` ports implemented here (apps' `AppLaunchScopes` from
    gatekeeper, the monitor's `HealthProbe` over reqwest); `http/` the
    server's own middleware (CORS, the loopback owner trust, the
    forwarded-request report), the `/health` checks and the `404`;
    `live_bindings/` `set_up`, `WildflowerServer` and the database catalogue.

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
  for each run, and each request the trusted front relayed through the
  tunnel, on a channel the host shares across runs, reported by the outermost layer as a `ForwardedRequest` record: the
  visitor's address, the path reduced to its route, the status, and the
  `RequestCaller` or `RequestRefusal` the gatekeeper bearer gates stamped on the
  response. The layer sends the same record to the request-log slice.
  A full report channel drops the report; it never delays a response.
- **Background tasks die with the runtime.** Slices `tokio::spawn` long-lived
  tasks onto the runtime that runs `set_up`; cancelling `shutdown` stops the
  listener, not those tasks (the tunnel's supervisor and the reachability
  monitor are the exception: they stop when `serve` returns). The host runs
  each server as a unit on the unit runner, which gives each run a dedicated
  runtime and shuts it down when the run ends, which is what ends them.

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
- [Server Runs Explanation](../servers/docs/Server%20Runs%20Explanation.md)
  — how the host runs, restarts and watches each server, as a `ServerUnit`.
- [Origins Explanation](../../docs/Origins/Explanation.md) — loopback vs
  forwarded served origins, which the owner trust, the 404 and HFS's base URL
  resolve per request.
- [Shared Diesel Pool Explanation](../../docs/Persistence/Shared%20Diesel%20Pool%20Explanation.md)
  — the pool `set_up` builds and shares across the diesel-backed slices.

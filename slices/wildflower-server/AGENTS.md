# AGENTS.md — slices/wildflower-server

The **Wildflower server**: the loopback API the Tauri host runs. Rust-only, no
`-core`.

## Package roles

- **`wildflower-server-rust`** — `set_up(config, host, observers)` opens the
  host's databases, sets up every server slice (gatekeeper, emr, OHIF, collector,
  tunnel, request log, apps, databases), gates them, wraps them in the loopback
  owner trust, the loopback-peer gate, the CORS policy and the forwarded-request
  observer, and binds the loopback port;
  `WildflowerServer::serve(shutdown)` serves the result until `shutdown` is
  cancelled. It also holds the server-side adapters that join two slices: the
  gatekeeper-backed `AppLaunchScopes` for apps, the reqwest `HealthProbe` for the
  tunnel, and HFS's base URL following the tunnel's public host. The
  unmatched-route `404` is here too.
  - Layout: `config.rs` at the crate root, the host's inputs
    (`WildflowerServerConfig`, `HostPorts`, `ServerObservers`); `adapters/`
    other slices' ports implemented here (apps' `AppLaunchScopes`, the tunnel's
    `HealthProbe`); `http/` the server's own middleware (CORS, the loopback
    owner trust, the forwarded-request report) and the `404`; `live_bindings/`
    `set_up`, `WildflowerServer`, the database catalogue and HFS's base URL
    following the tunnel.

## Layering

- **No `tauri` dependency**, so the crate compiles and tests without GTK, in the
  non-Tauri partition of `scripts/checks/rust.sh`.
- **The host hands in what it owns.** `WildflowerServerConfig` carries the values
  `apps/wildflower-tauri` derives at build time (`tauri-shared-config.json`,
  build-time env) or from its platform paths (the server's folder, the FHIR
  SearchParameter bundle dir). `HostPorts` carries its native adapters as trait
  objects (`LoopbackConsentPrompt`, `OnDeviceWebviewHandle`) and the `watch`
  senders its bridge reads. The server reads none of the host's build-time
  configuration or platform paths itself.
- **The host watches the server through `ServerObservers`.** Host-owned senders
  that outlive any one server: the tunnel's liveness, copied by a task on the
  server's runtime, and each request the trusted front relayed through the
  tunnel, reported by the outermost layer as a `ForwardedRequest` record: the
  visitor's address, the path reduced to its route, the status, and the
  `RequestCaller` or `RequestRefusal` the gatekeeper bearer gates stamped on the
  response. The layer sends the same record to the request-log slice.
  A full report channel drops the report; it never delays a response.
- **Background tasks die with the runtime.** Slices `tokio::spawn` long-lived
  tasks onto the runtime that runs `set_up`; cancelling `shutdown` stops the
  listener, not those tasks. `background-server-service` runs each server on a
  dedicated runtime it shuts down when the server stops, which is what ends
  them.

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
- [background-server-service AGENTS.md](../background-server-service/AGENTS.md)
  — how the host runs, restarts and watches the server.
- [Origins Explanation](../../docs/Origins/Explanation.md) — loopback vs
  forwarded served origins, which the owner trust, the 404 and HFS's base URL
  resolve per request.
- [Shared Diesel Pool Explanation](../../docs/Persistence/Shared%20Diesel%20Pool%20Explanation.md)
  — the pool `set_up` builds and shares across the diesel-backed slices.

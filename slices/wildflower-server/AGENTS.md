# AGENTS.md — slices/wildflower-server

The **Wildflower server**: the loopback API the Tauri host runs. Rust-only, no
`-core`.

## Package roles

- **`wildflower-server-rust`** — `serve(config, host, shutdown)` opens the
  host's databases, sets up every server slice (gatekeeper, emr, OHIF, collector,
  tunnel, apps, databases, the `/docs` reference), gates them, and serves them on
  the loopback port behind the loopback owner trust, the loopback-peer gate, the
  CORS policy and the tunnel's subdomain reverse proxy, until `shutdown` is
  cancelled. It also holds the server-side adapters that join two slices: the
  apps-store `SelfHostedRedirectResolver` for gatekeeper, the reqwest
  `HealthProbe` for the tunnel, and HFS's base URL following the tunnel's public
  host. The unmatched-route `404` is here too.

## Layering

- **No `tauri` dependency**, so the crate compiles and tests without GTK, in the
  non-Tauri partition of `scripts/checks/rust.sh`.
- **The host hands in what it owns.** `WildflowerServerConfig` carries the values
  `apps/wildflower-tauri` derives at build time (`tauri-shared-config.json`,
  build-time env) or from its platform paths (the app-data dir, the FHIR
  SearchParameter bundle dir, the vendored self-hosted apps). `HostPorts` carries
  its native adapters as trait objects (`LoopbackConsentPrompt`,
  `OnDeviceWebviewHandle`) and the `watch` senders its bridge reads. The server
  reads none of the host's build-time configuration or platform paths itself.
- **Background tasks follow the runtime.** Slices `tokio::spawn` long-lived tasks
  onto the runtime that runs `serve`; cancelling `shutdown` stops the listener,
  not those tasks.

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
- [Origins Explanation](../../docs/Origins/Explanation.md) — loopback vs
  forwarded served origins, which the owner trust, the 404 and HFS's base URL
  resolve per request.
- [Shared Diesel Pool Explanation](../../docs/Persistence/Shared%20Diesel%20Pool%20Explanation.md)
  — the pool `serve` builds and shares across the diesel-backed slices.

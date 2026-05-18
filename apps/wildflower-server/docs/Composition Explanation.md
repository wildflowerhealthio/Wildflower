# Wildflower Server — Composition Explanation

## What this package is

`wildflower-server` exports a single, platform-neutral `Layer`:
[`WildflowerServerLive`](../src/index.ts). It composes every slice's
`HttpApi` group (gatekeeper, FHIR resources / public, collector, apps,
vendor-apps), the SPA static-file fallback, Swagger docs, and the
CORS + cookie-stripping middleware into one runnable server Layer.

The package owns the API shape and the security posture. It does **not**
own the platform binding (HTTP transport, file system, store, telemetry,
tunnel control). Those services are required _peers_ — a host app
(`wildflower-node`, `wildflower-expo`) supplies them.

## The host's job

A host is a thin Layer composer. Its single responsibility is to
satisfy `WildflowerServerLive`'s peer requirements with implementations
that fit its runtime, then `Layer.launch` the result. The two existing
hosts share their composition shape because the contract is identical;
only the Lives differ.

### Transport + filesystem

- `HttpServer.HttpServer` — the TCP/HTTP binding the API runs on. Node: `NodeHttpServer.layer`. Expo: `ExpoHttpServer.layer` (from `expo-effect-platform`, bound to `127.0.0.1`).
- `FileSystem.FileSystem` + `Path.Path` — read static SPA assets, join paths. Node: `NodeFileSystem.layer` + `NodePath.layer`. Expo: both bundled in `ExpoContext.layer`.
- `WebAssetsDir` — absolute path to the SPA bundle directory. Both hosts get it from `wildflower-react/web-assets`.
- `Origin` — the server's public origin (alphanumeric-terminated). Node: from the `ORIGIN` env var. Expo: starts as `http://127.0.0.1:<port>`, gets reissued when the tunnel comes up.

### Cross-cutting platform services

- `CryptoRandom` — token + nonce entropy. Both hosts use `cryptoRandomLayerFromWebCrypto(globalThis.crypto)`.
- `Telemetry` — OTEL + Sentry wiring. Node: `nodeTelemetryLayerFromEnv`. Expo: the react-native equivalent.

### Slice stores (all projections of one LiveStore handle)

The four store layers must close over the **same** `Store`. Building
them from a fresh store per slice would split the database in four.

- `LivestoreStore` — `makeLivestoreStoreLayer(store)`.
- `GatekeeperStore` — `makeGatekeeperStoreLayer(store)`.
- `AppsStore` — `makeAppsStoreLayer(store)`.
- `CollectorStore` — `makeCollectorStoreLayer(store)`.

Adapter differs by host: `@livestore/adapter-node` (filesystem) for
the node host, `@livestore/adapter-expo` (expo-sqlite) for the Expo
host.

### Tunnel

- `TunnelControl` — read + control the public-origin tunnel. Node: a static Live that reports no tunnel and rejects every `setTunnelActive`. Expo: an `expo-localtunnel`-backed Live that actually starts and reports a live public origin.

## Layer graph

`WildflowerServerLive` from `wildflower-server` resolves to:

```text
WildflowerServerLive
├── HttpApiBuilder.serve(middleware)         ← CORS + cookie-strip
├── HttpApiSwagger.layer()
├── WildflowerHttpApiLive                    ← all 7 HttpApi groups
│   ├── GatekeeperApiHandlersFor             (needs: GatekeeperStore, CryptoRandom, Origin)
│   ├── FhirResourcesApiHandlersFor          (needs: LivestoreStore + RequireAuth)
│   ├── FhirPublicApiHandlersFor             (needs: LivestoreStore)
│   ├── CollectorApiHandlersFor              (needs: CollectorStore + RequireAuth)
│   ├── AppsApiHandlersFor                   (needs: AppsStore, TunnelControl)
│   ├── AppsAdminApiHandlersFor              (needs: AppsStore, TunnelControl + RequireAuth)
│   ├── VendorAppsApiHandlersFor             (static, base64-encoded assets)
│   ├── RequireAuthMiddlewareLive            (needs: GatekeeperStore)
│   └── SmartConfigurationLive               (needs: Origin)
└── StaticSpaLive                            (needs: WebAssetsDir, FileSystem, Path)
```

## Boot sequence

The Layer graph is declarative — Effect resolves it bottom-up — but the
host's `Effect.gen` _before_ the Layer launch has a real ordering:

1. **Open the LiveStore** (`createStore`). Single shared handle.
2. **Build the gatekeeper store layer.** Needed by the seeds below.
3. **Seed signing key.** Idempotent. Without it gatekeeper can't sign
   anything.
4. **Seed the first-party `wildflower-host` client.** Idempotent. The
   identity tokens for this host are minted against.
5. **(dev only) Mint a bootstrap host-owner token.** Logged at startup
   so a developer can paste it into the SPA without going through the
   device flow. Production must use the device flow.
6. **Compose `FullServerLive`** by providing every peer above to
   `WildflowerServerLive`.
7. **`Layer.launch(FullServerLive)`.** The HTTP server binds; the SPA
   becomes reachable at `<Origin>`.

The tunnel — when one exists — sits one rung up the boot sequence:
start it after the server binds locally, then announce the public
origin to the host (which the host then uses for any externally-visible
URL construction).

## Notes for the Expo mirror

The Expo host's composition mirrors this file section-for-section. The
salient differences:

- **HTTP server** is `ExpoHttpServer.layer` from `expo-effect-platform`
  (native bridge to FlyingFox / Ktor). Bind to `127.0.0.1` — the LAN
  exposure threat model only makes sense for desktop.
- **`FileSystem` + `Path`** come bundled in `ExpoContext.layer`, not as
  two separate layers. Provide that one instead.
- **LiveStore adapter** is `@livestore/adapter-expo` (SQLite via
  `expo-sqlite`).
- **`TunnelControl` Live** wraps `expo-localtunnel`. Unlike the node
  host (where there's no tunnel and `setTunnelActive` always fails),
  the Expo Live can start, stop, and report a live public origin.
- **`Origin`** is dynamic: at boot the only origin you know is
  `http://127.0.0.1:<port>`. The tunnel's public origin becomes
  available asynchronously; expose both, and let the bridge surface
  the transition to the embedded SPA.
- **Bootstrap token**: the Expo host mints one on first launch (the
  device IS the owner) and forwards it to the SPA via the
  `AuthTokenIssued` bridge message. Persist between launches via
  `expo-secure-store`.

## When this doc is wrong

- A slice gains or loses an `HttpApiGroup`, or changes which middleware
  it requires.
- A new top-level peer requirement appears on `WildflowerServerLive`
  (look for added `Layer.provide` calls in a host that aren't covered
  here).
- A store-layer factory's signature changes shape (it no longer takes
  the shared `Store`, or returns a different Tag).

Update the requirements table and the layer graph; the boot-sequence
section is more stable but worth re-reading if seeds shift.

## Related

- [Effect Patterns Reference](../../../docs/Effect/Patterns%20Reference.md)
- [HttpApi Composition How-To](../../../docs/Effect/HttpApi%20Composition%20How-To.md) — phantom-id bridge pattern that makes the `*HandlersFor<'WildflowerApi'>()` calls possible
- [`wildflower-node/src/index.ts`](../../wildflower-node/src/index.ts) — the canonical reference composition
- [`wildflower-server/src/index.ts`](../src/index.ts) — what's being composed

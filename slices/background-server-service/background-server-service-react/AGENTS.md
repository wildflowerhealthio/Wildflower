# AGENTS.md — slices/background-server-service/background-server-service-react

The **background server service's browser surface**: the banner the app shell
shows while the Wildflower server isn't running, and the `/settings/server`
page. Both render the host's latest `ServerServiceStatus` and send
`RestartServer`; the wire lives one layer down in
[`background-server-service-core`](../background-server-service-core/AGENTS.md).

## Shape

- `src/server-service-status-store.ts` — **`ServerServiceStatusStore`** (the
  latest snapshot, `null` before the first), `makeServerServiceStatusStore`,
  its context and **`useServerServiceStatus()`**.
  `src/server-service-status-provider.tsx` provides it.
- `src/web-bridge.ts` — **`makeBackgroundServerServiceWebHandlers(setStatus)`**,
  the inbound handler record that writes each snapshot into the store.
- `src/background-server-service-sender-context.ts` / `-provider.tsx` /
  `src/use-background-server-service-sender.ts` — the `RestartServer` sender,
  fed by the app's `BackgroundServerServiceSenderForwarder`;
  `src/use-restart-server.ts` turns it into a click handler.
- `src/server-status-banner.tsx` — **`ServerStatusBanner`**: nothing before
  the first snapshot or while running; `starting` calmly; `stopped` with the
  stop reason, the error and Restart.
- `src/server-settings-page.tsx` — the page: state, last stop reason, last
  error, notifications, Restart in every state, and the Tunnel section.
  `src/server-tunnel-status.tsx` reads the tunnel through `tunnel-react`'s
  `tunnelStateQueryOptions` and draws it with its `TunnelStatusHero`, mounted
  only while the server runs.
- `src/server-status-text.ts` — the labels and sentences for states, stop
  reasons and notification permissions.
- `src/routes/settings/server/index.tsx` — the route, mounted into
  `apps/wildflower-react` by its `routes.config.ts`; `src/routes/__root.tsx`
  exists only so the slice's own route generator has an anchor, with a
  context matching the app's (`src/router-context.ts`).

## Wiring

- **The handler is boot-stable, not registered on mount.** The host answers
  the page's `__Ready` with the current snapshot before any component mounts,
  and a bridge with no handler drops what it receives. So the Tauri entry
  seeds `makeBackgroundServerServiceWebHandlers` into `makeTauriTransport`'s
  `initial` record, like gatekeeper's, and components subscribe to the store.
- **The app owns the store.** `apps/wildflower-react`'s `buildAppTree` builds
  one per page and provides it to every entry; only the Tauri transport writes
  to it.
- **Only the Tauri entry mounts the banner** (`platformBanner`), and only it
  links the page from Settings.

## Traps

- **No client-side state machine.** Derive everything from the snapshot; don't
  remember a previous state to decide what to show.
- **The tunnel query refetches on mount.** The app warms the tunnel cache at
  boot, and a restart starts a new tunnel, so a cached value can be a previous
  run's.

## Testing

- `src/server-status-banner.test.tsx` — hidden before the first snapshot and
  for any running status, `stopped` shows its reason and error, `starting`
  shows neither, Restart sends `RestartServer`, and a running snapshot hides it.
- `src/server-settings-page.test.tsx` — through the slice's route tree, with
  the real tunnel client over a stub `HttpClient`: waiting before the first
  snapshot, each state with Restart, a stopped server's fields and no tunnel
  request, and the tunnel's host while running.
- `src/web-bridge.test.ts` — each snapshot replaces the store's.
- `src/routes.test.tsx` — the route tree is `/settings/server/` alone.

## References

- [slices/background-server-service AGENTS.md](../AGENTS.md) — the slice's role
  and packages.
- [Design Explanation](../docs/Design%20Explanation.md) — the snapshot, the
  restart, and why the page keeps no state of its own.
- [Web Handler Coordinator Explanation](../../../docs/Effect/Web%20Handler%20Coordinator%20Explanation.md)
  — why the handler is boot-stable.
- [tunnel-react](../../tunnel/tunnel-react) — the tunnel query and component the
  page reuses.

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
- `src/server-status-banner.tsx` — **`ServerStatusBanner`**: one row under
  the status bar. Nothing before the first snapshot, while running, or on
  `/settings/server`; `starting` and `restarting` calmly, without a reason or
  Restart; `stopped` on the warning surface with the stop reason, the error and
  Restart. It takes the top safe-area inset and zeroes `--safe-area-inset-top`
  for the route below, so the page header doesn't add a second one.
- `src/server-settings-page.tsx` — the page: a Status card (state,
  notifications, last stop reason, last error) on the Settings list's card
  surface, and Restart in every state.
- `src/server-status-text.ts` — the labels and sentences for states, stop
  reasons and notification permissions, and `serverDisplayState`, which shows a
  clean `appStop` stop (the stop half of a restart) as `restarting`.
- `src/settings-fragments.ts` — **`backgroundServerServiceSettingsItemsFragment`**,
  the Settings row for `/settings/server`, which `main-tauri` passes as its
  `platformSettingsItems`.
- `src/routes/settings/server/index.tsx` — the route, mounted into
  `apps/wildflower-react` by its `routes.config.ts`; `src/routes/__root.tsx`
  exists only so the slice's own route generator has an anchor, with a
  context matching the app's (`src/router-context.ts`, the shared base: the
  page calls no API).

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

## Testing

- `src/server-status-banner.test.tsx` — under a memory router: hidden before
  the first snapshot, for any running status and on `/settings/server`;
  `stopped` shows its reason, error and Restart; `starting` and the stop half of
  a restart show none of them; Restart sends `RestartServer`; a running
  snapshot hides it.
- `src/server-settings-page.test.tsx` — through the slice's route tree:
  waiting before the first snapshot, each state with Restart, a stopped
  server's fields, the notification permission, and the stop half of a restart
  as restarting.
- `src/web-bridge.test.ts` — each snapshot replaces the store's.
- `src/routes.test.tsx` — the route tree is `/settings/server/` alone.
- `src/settings-fragments.test.ts` — the one Settings row links to
  `/settings/server`.

## References

- [slices/background-server-service AGENTS.md](../AGENTS.md) — the slice's role,
  its packages and the wire.
- [Web Handler Coordinator Explanation](../../../docs/Effect/Web%20Handler%20Coordinator%20Explanation.md)
  — why the handler is boot-stable.

# AGENTS.md — apps/launcher/wildflower-server-core-js

The **server-status wire's pure layer**: `BackgroundServerServiceBridge`, a
status snapshot of the Wildflower server (host → web) and a request to restart
it (web → host). No DOM, no React.

The wire is kept for the web app to read a server's status over a future
websocket. Nothing sends or answers it today: the Tauri host runs its servers
on the unit runner (see `apps/host/servers`'s
[Server Runs Explanation](../../host/servers/docs/Server%20Runs%20Explanation.md)),
and neither sends `ServerServiceStatus` nor listens for `RestartServer`.

## Shape

- `src/bridge.ts` — **`BackgroundServerServiceBridge`**: `ServerServiceStatus`
  (host→web: `state`, `stopReason`, `lastError`, `notifications`) and
  `RestartServer` (web→host). Also exports the literal schemas the status is
  built from (`ServerServiceState`, `ServiceStopReason`,
  `NotificationPermission`). The TSDoc holds the exact wire strings.
- `src/index.ts` — re-exports them.
- `test/bridge-wire-golden.json` — the exact wire strings and stop reasons
  `bridge.test.ts` pins.

## Wire

```text
Host → Web  ServerServiceStatus {
              state: "starting" | "running" | "stopped",
              stopReason: StopReason | null,        // tauri-plugin-background-service's camelCase reasons
              lastError: string | null,
              notifications: "granted" | "denied" | "unknown"
            }
Web → Host  RestartServer {}
```

Exact strings:

```text
{"_tag":"ServerServiceStatus","state":"running","stopReason":null,"lastError":null,"notifications":"granted"}
{"_tag":"ServerServiceStatus","state":"stopped","stopReason":"platformExpiration","lastError":"failed to bind to 127.0.0.1:8080: Address already in use","notifications":"denied"}
{"_tag":"RestartServer"}
```

## Layering

Pure and neutral (`platform: 'neutral'`). Depends on `effect` and
`effect-messaging-core` (`Bridge`). Imported by
`wildflower-server-react`, `apps/launcher/launcher-web` (the bridges tuple)
and `apps/host/host-app` (the bridge name its transport seeds).

## Traps

- **Field order is part of the wire.** The golden strings write `_tag`,
  `state`, `stopReason`, `lastError`, `notifications` in that order; a host
  that answers the wire must write them the same way.
- **`null`, never absent.** The host always writes every field, so the schema
  requires each one; a missing field is a decode failure, not a default.
- **`stopReason` outlives its run.** A `starting` status after a restart still
  carries that restart's `appStop`.
- **A wire change edits `test/bridge-wire-golden.json` and the schema
  together.** The schema is the contract; the golden file pins its text.

## Testing

- `bridge.test.ts` — over `test/bridge-wire-golden.json`: each golden string
  decodes to its documented value and re-encodes byte for byte,
  `ServiceStopReason`'s literals are the file's list, and `RestartServer`
  encodes to its string. Properties: any status round-trips in the host's
  field order, and a status missing any field is refused.

## References

- [apps/launcher/AGENTS.md](../AGENTS.md) — the folder this package sits in.
- [Bridge Explanation](../../../docs/Messaging/Bridge%20Explanation.md) — the
  webview ↔ host bridge the wire rides.
- [Wire Pinning How-To](../../../docs/Messaging/Wire%20Pinning%20How-To.md) —
  the discipline `src/bridge.ts` follows.

# AGENTS.md — slices/background-server-service/background-server-service-core

The **background server service's pure layer**: `BackgroundServerServiceBridge`,
the Tauri host's status snapshot of the Wildflower server it runs and the
page's request to restart it. No DOM, no React.

## Shape

- `src/bridge.ts` — **`BackgroundServerServiceBridge`**: `ServerServiceStatus`
  (host→web: `state`, `stopReason`, `lastError`, `notifications`) and
  `RestartServer` (web→host). Also exports the literal schemas the status is
  built from (`ServerServiceState`, `ServiceStopReason`,
  `NotificationPermission`). The TSDoc holds the exact wire strings.
- `src/index.ts` — re-exports them.

## Layering

Pure and neutral (`platform: 'neutral'`). Depends on `effect` and
`effect-messaging-core` (`Bridge`). Imported by
`background-server-service-react`, `apps/wildflower-react` (the bridges tuple)
and `apps/wildflower-tauri` (the bridge name its transport seeds).

## Traps

- **The serde mirror must match byte for byte.**
  `background-server-service-rust/src/bridge.rs` serializes the same shapes.
  Field order matters to the golden strings: `_tag`, `state`, `stopReason`,
  `lastError`, `notifications`.
- **`null`, never absent.** The host always writes every field, so the schema
  requires each one; a missing field is a decode failure, not a default.
- **`stopReason` outlives its run.** A `starting` status after a restart still
  carries that restart's `appStop`.

## Testing

- `bridge.test.ts` — over `../bridge-wire-golden.json`, the file the Rust golden
  tests read: each golden string decodes to its documented value and
  re-encodes byte for byte, `ServiceStopReason`'s literals are the file's list,
  and `RestartServer` encodes to its string. Properties: any status round-trips
  in the host's field order, and a status missing any field is refused.

## References

- [slices/background-server-service AGENTS.md](../AGENTS.md) — the slice's role,
  its packages and the wire.
- [Wire Pinning How-To](../../../docs/Messaging/Wire%20Pinning%20How-To.md) —
  the discipline `src/bridge.ts` follows.

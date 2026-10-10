# AGENTS.md — slices/background-server-service

The **server-status wire**: `BackgroundServerServiceBridge`, a status snapshot
of the Wildflower server (host → web) and a request to restart it
(web → host), with the web app's banner and `/settings/server` page that
render it. The wire is kept for the web app to read a server's status over a
future websocket. Nothing sends or answers it today: the Tauri host runs its
servers on the unit runner (see `apps/host/servers`'s
[Server Runs Explanation](../../apps/host/servers/docs/Server%20Runs%20Explanation.md)),
and neither sends `ServerServiceStatus` nor listens for `RestartServer`.

## Package roles

- **`background-server-service-rust`** — the serde mirror of the wire
  (`bridge.rs`), with its golden tests. No `tauri` dependency. The only
  package left in this slice.

The two TS packages moved to `apps/launcher/`, beside the launcher that mounts
them:

- **[`wildflower-server-core-js`](../../apps/launcher/wildflower-server-core-js/AGENTS.md)**
  — `BackgroundServerServiceBridge`: the `ServerServiceStatus` and
  `RestartServer` schemas, the contract the Rust mirror is pinned to. Pure.
- **[`wildflower-server-react`](../../apps/launcher/wildflower-server-react/AGENTS.md)**
  — the page side: the status store and the boot-stable handler that fills it,
  `ServerStatusBanner`, the `/settings/server` page, and the `RestartServer`
  sender.

`bridge-wire-golden.json`, at the slice root, holds the exact wire strings and
stop reasons both `-rust`'s golden tests and `wildflower-server-core-js`'s
`bridge.test.ts` read.

## Wire (`BackgroundServerServiceBridge`)

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

## Rules

- **The page renders the latest snapshot and nothing else.** No client-side
  state machine: a store holds the last `ServerServiceStatus`, and the banner
  and page derive everything from it.
- **A wire change edits `bridge-wire-golden.json`, the TS schema and the serde
  mirror together.** The TS schema in `wildflower-server-core-js` is the
  contract. Each side's tests read the shared file, `-rust`'s serializing to it
  and `wildflower-server-core-js`'s decoding and re-encoding it byte for byte,
  so neither side can rename, reorder or re-case a field alone.

## References

- [slices/AGENTS.md](../AGENTS.md) — slice layering rules this slice follows.
- [Bridge Explanation](../../docs/Messaging/Bridge%20Explanation.md) and the
  [Wire Pinning How-To](../../docs/Messaging/Wire%20Pinning%20How-To.md) — the
  discipline `ServerServiceStatus` and `RestartServer` follow.

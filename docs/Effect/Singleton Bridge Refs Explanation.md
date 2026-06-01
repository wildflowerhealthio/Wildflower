# Singleton Bridge Refs Explanation

Several slices (`gatekeeper-react`, `collector-react`, `apps-react`) bridge React-side state into Effect-side message-handler records via a **module-level mutable cell** — a "ref" in the JavaScript sense, not the React sense. This document explains the invariant, why it works, and the cross-cutting constraints it imposes.

## The pattern

Each slice's page-side `BridgeTransport` is built **once at boot**, outside React (see `apps/wildflower-react/src/bridges/build-transport.ts`). Its handler record for the slice's Host→Web messages needs to call into React-installed handlers — token writers, sync handlers, tunnel resolvers — that don't exist at boot.

To bridge the lifecycle gap, each slice exports:

1. A module-level cell holding the current handler (or `null`):

   ```ts
   const activeHandlerRef: { current: ActiveHandler | null } = { current: null }
   ```

2. A plain handler record (`MessageHandler.HandlersFor<Bridge['HostToWeb']>`) — one Effect-returning function per Host→Web tag — that reads `cell.current` on every dispatch and forwards into it (or `log-and-drops` when `null`):

   ```ts
   const collectorWebHandlers: MessageHandler.HandlersFor<(typeof CollectorBridge)['HostToWeb']> = {
     ResponseStart: (event) => {
       const h = activeHandlerRef.current
       return h === null
         ? HandlerHelpers.droppedTagWarning('ResponseStart')
         : h.ResponseStart(event)
     },
     // ...one handler per Host→Web tag
   }
   ```

3. A setter (and matching set-if-equal clearer) the React-side hook calls on mount/unmount:

   ```ts
   const setActiveHandler = (h: ActiveHandler | null): void => {
     activeHandlerRef.current = h
   }
   const clearActiveHandlerIfCurrent = (h: ActiveHandler): void => {
     if (activeHandlerRef.current === h) activeHandlerRef.current = null
   }
   ```

Concrete instances in this repo:

| Slice              | Ref                        | Hook               | Handler record          |
| ------------------ | -------------------------- | ------------------ | ----------------------- |
| `gatekeeper-react` | `authTokenRef`             | n/a (token write)  | `gatekeeperWebHandlers` |
| `collector-react`  | `activeHandlerRef`         | `useSyncRunner`    | `collectorWebHandlers`  |
| `apps-react`       | `pendingTunnelResolverRef` | `useRequestTunnel` | `appsWebHandlers`       |

## The invariant

> The page has exactly one transport, exactly one writer at a time. Last writer wins.

Two halves matter:

- **Exactly one writer at a time.** The slice's hook (`useSyncRunner`, `useRequestTunnel`) installs into the ref on mount, clears on unmount. No two concurrently-mounted instances make sense — a second instance would silently displace the first's installation. The slice is expected to enforce this by being a singleton mount in the route tree (e.g. mounted under `_auth` only).

- **Last writer wins.** When a successor arrives before the predecessor has cleared, the successor takes the slot. The predecessor's later cleanup must not blank the successor's installation — see _set-if-equal_ below.

## Set-if-equal clear

The naive cleanup pattern:

```ts
useEffect(() => {
  setActiveHandler(handler)
  return () => setActiveHandler(null) // ← unconditional clear
}, [handler])
```

is unsafe under StrictMode double-mount, suspense remounts, and any cleanup-after-install ordering. If the successor's `setActiveHandler(handlerB)` runs before the predecessor's cleanup, the predecessor's `setActiveHandler(null)` will silently blank `handlerB`.

Use **set-if-equal** instead:

```ts
return () => clearActiveHandlerIfCurrent(handler)
```

The `clear` is only effective when the ref still points at `handler` — i.e. when no successor has taken the slot. This makes stale cleanups idempotent no-ops.

The `apps-react` resolver ref uses an additional **supersede** layer: installing a new resolver while another is in flight first calls the predecessor with a `superseded by newer request` error so its outer Promise settles rather than dangling until its own 8-second timer fires.

## Implications

- **No multi-instance mount.** Mounting two React subtrees that each install into the same ref will not work — only one's handler is observable at a time. Slice consumers should structure routes so the singleton hook mounts in exactly one place (typically the slice's gated layout route).

- **StrictMode double-mount.** React's StrictMode mounts effects twice. The supersede + set-if-equal patterns together make this benign: the second install supersedes the first cleanly, and the first install's eventual cleanup is a no-op against the second handler's ref slot.

- **HMR caveats.** Hot Module Replacement re-runs the slice module, which re-initializes the module-level `cell.current = null`. Any currently-installed handler is lost; the next React render re-installs. Hot-reloading the _handler_ module without re-mounting the consumer hook leaves the old handler in the ref. Mostly cosmetic; full reload (Cmd-R) resets cleanly.

- **Test isolation.** The ref is module-scoped, so tests within a worker share it. Any test that installs into the ref needs an `afterEach` that resets it:

  ```ts
  afterEach(() => setActiveHandler(null))
  ```

  Otherwise a leaked install from one test will supersede the next test's first install (and possibly record an unexpected outcome).

## Why module-level, not React context?

The transport is built before React mounts. A React context-only design would require the transport build to wait for React, which adds an asynchronous lifecycle step the embedded host has to coordinate around (host posts URL-encoded `AuthTokenIssued` messages immediately on transport readiness; deferring transport build past React commit would let those messages hit a closed bridge).

The module-level ref decouples transport lifetime from React lifetime: transport spawns at module-eval, the handler records close over the (still `null`) ref, and the React tree later writes into the ref via slice-specific hooks. The records read through the ref on every dispatch, so the staleness window between transport-build and first React commit only manifests as `log-and-drop` of any messages that arrive in that window — which is correct for messages the React tree wouldn't have known how to handle yet.

## See also

- [Effect Patterns Reference](./Patterns%20Reference.md)
- [HttpApi Composition How-To](./HttpApi%20Composition%20How-To.md)
- `slices/gatekeeper/gatekeeper-react/src/client/token-storage.ts` — `authTokenRef`
- `slices/collector/collector-react/src/runtime/active-handler-ref.ts` — `activeHandlerRef` + `clearActiveHandlerIfCurrent`
- `slices/apps/apps-react/src/runtime/tunnel-resolver-ref.ts` — `pendingTunnelResolverRef` + supersede + `clearPendingTunnelResolverIfCurrent`

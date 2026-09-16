# AGENTS.md — slices/har-recorder/har-recorder-react

The **HAR Recorder's browser surface**: the `/har-recorder` page and the
`useHarRecorder` state machine behind it. Everything about the format lives one
layer down in [`har-recorder-core`](../har-recorder-core/AGENTS.md); this
package is the React shell that drives it and the two bridges it straddles.

## Shape

- `src/use-har-recorder.ts` — **`useHarRecorder()`** → `{ state, start(url), stop() }`.
  `state` is `Idle` → `Recording(count, startUrl, startedAt)` → `Saving(fileName)`
  → `Saved(path)` | `Failed(message)`.
- `src/use-har-recorder-register.ts` — `makeUseSliceRegister(HarRecorderBridge)`:
  the coordinator accessor for the recorder's _own_ bridge (`HarSaved` /
  `HarSaveFailed`).
- `src/har-recorder-sender-context.ts` / `-provider.tsx` / `src/use-har-recorder-sender.ts`
  — the `SaveHar` sender, fed by the app's `HarRecorderSenderForwarder`.
- `src/routes/_auth/har-recorder/index.tsx` — the page. Mounted into
  `apps/wildflower-react` by that app's `routes.config.ts`; `src/routes/__root.tsx`
  exists only so the slice's own route generator has an anchor.

## Two bridges, one page

The recorder's **intake is the collector's data plane**: the sniffer's
`ResponseStart` / `ResponseData` / `ResponseFinished` / `RequestError` /
`Cancelled` events (and `UserDismissed`) arrive on **`CollectorBridge`**, so
this package registers through `collector-react`'s `useCollectorRegister` and
sends `Open` / `SniffingComplete` through its `useCollectorSender` — it does not
re-declare those tags. Its **output** is **`HarRecorderBridge`**: `SaveHar` out,
`HarSaved` / `HarSaveFailed` back. That is why `collector-react` is an intrinsic
dependency rather than a layering smell.

## Traps

- **A handler record must cover every inbound tag of its bridge.** The
  coordinator stores one record per bridge and the transport requires it
  complete, so `PageLoaded`, `PageRequested` and `SnifferDisposed` are explicit
  no-ops in the collector record, not omissions.
- **`unregister` is set-if-equal.** The hook builds each bridge's handler record
  once per instance and re-uses that same object; a freshly-built record would
  leave the coordinator unable to evict the one it holds.
- **The coordinator keys its slots by bridge _name_.** A mounted recorder and a
  running collector sync would contend for the single `Collector` slot — they
  are separate pages and never concurrent, but a future surface that runs both
  at once needs more than this.
- **`SaveHar` goes out before `SniffingComplete`.** `SniffingComplete` is what
  closes the sniffer webview; the host must hold the bytes first. Unmounting
  mid-recording still sends it, or the window is orphaned.
- **`count` is bumped only on `ResponseFinished`.** A body arrives as hundreds of
  `ResponseData` messages; re-rendering on each would be a render storm, and the
  recording itself is a ref (megabytes of bytes, none of it rendered).

## Testing

- `src/use-har-recorder.test.tsx` — the state machine against a fake coordinator
  and fake senders: register-then-`Open`, the counter, the
  `SaveHar` → `SniffingComplete` → unregister order, `UserDismissed`, answer
  matching by file name, `stop()` idempotence, and unmount-while-recording.
- `src/routes/_auth/har-recorder/index.test.tsx` — the page's affordances:
  Start enablement follows the URL's validity, Stop shows only while recording,
  and the saved path is rendered.

## References

- [har-recorder AGENTS.md](../AGENTS.md) — the slice's role and packages.
- [har-recorder-core AGENTS.md](../har-recorder-core/AGENTS.md) — `Recording`,
  `toHar`, `recordingFileName`, `HarRecorderBridge`.
- [collector-react](../../collector/collector-react) — the register/sender hooks
  this package intakes through.
- [Bridge Explanation](../../../docs/Messaging/Bridge%20Explanation.md) — the
  webview ↔ host bridge both halves ride.

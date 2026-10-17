# AGENTS.md — apps/host/recorder/recorder-react

The **Recorder's browser surface**: `RecorderPage`, and `RecorderProvider`
running the `useRecorder` state machine behind it. Everything about the format lives one layer down in
[`recorder-core-js`](../recorder-core-js/AGENTS.md); this package is the React
shell that drives it over `RecorderBridge`.

## Shape

- `src/use-recorder.ts` — **`useRecorder()`** → `{ state, start(url), stop() }`.
  `state` is `Idle` → `Recording(count, startUrl, startedAt)` → `Saving(fileName)`
  → `Saved(path)` | `Failed(message)`.
- `src/use-recorder-register.ts` — `makeUseSliceRegister(RecorderBridge)`: the
  coordinator accessor for the recorder's bridge.
- `src/recorder-sender-context.ts` / `-provider.tsx` / `src/use-recorder-sender.ts`
  — the `RecorderBridge` sender (`Open`, `SniffingComplete`, `SaveHar`), which
  the app provides from its transport's `sendMessage`.
- `src/recorder-provider.tsx` / `src/recorder-context.ts` —
  **`RecorderProvider`**, which runs one `useRecorder` for as long as it is
  mounted, and `useProvidedRecorder`, which reads it. An app mounts the
  provider above its routes so a recording outlives the page.
- `src/use-save-folder.ts` — **`useSaveFolder(invoke)`**: the recordings
  folder, read once on mount: `Reading` → `Read(folder)` | `Unreadable(message)`.
- `src/use-bookmarks.ts` — **`useBookmarks(invoke)`** →
  `{ state, isChanging, add, rename, remove, recorded }`. `state` is
  `Reading` → `Read(bookmarks)` | `Unreadable(message)`, read once on mount;
  each action replaces the list with the host's answer and resolves to the
  host's refusal, if any, for the page's `ErrorBanner`. Only the latest
  request's answer lands.
- `src/recorder-page.tsx` — **`RecorderPage`**, a plain component with no
  route, taking `invoke` (Tauri's) and `revealFile` (`tauri-plugin-opener`'s
  `revealItemInDir`). It shows the recordings folder, and after a save offers
  Show file where the folder's `revealsFiles` says the platform can. Under the
  controls it lists the bookmarks `byRecency`, each with when it was last
  recorded (`kitchen-sink`'s `formatRelativeTime`), a name that fills the URL
  field, and Rename and Remove; Bookmark this names a startable URL that
  isn't bookmarked, and Start recording stamps the bookmark at that URL. It
  drives the provider's recorder, so a page that mounts mid-recording shows
  the recording and its URL. `apps/host/host-app` renders it at `/recorder`,
  under a `RecorderProvider`, a `RecorderSenderProvider` and a
  `HandlerCoordinatorContext` over its `RecorderBridge` transport, which its
  layout holds around every route.

## Traps

- **A handler record must cover every inbound tag of its bridge.** The
  coordinator stores one record per bridge and the transport requires it
  complete, so `PageLoaded`, `PageRequested` and `SnifferDisposed` are explicit
  no-ops, not omissions.
- **The record lives as long as the hook**, which `RecorderProvider` runs. It is registered on mount and
  unregistered on unmount, so it is in place before any `Open` and still there
  when `HarSaved` arrives after the window closed. A sniffer event with no
  recording running is dropped.
- **`unregister` is set-if-equal.** The hook builds its handler record once
  per instance and re-uses that same object; a freshly-built record would
  leave the coordinator unable to evict the one it holds.
- **`SaveHar` goes out before `SniffingComplete`.** `SniffingComplete` is what
  closes the sniffer webview; the host must hold the bytes first. Unmounting
  mid-recording still sends it, or the window is orphaned.
- **`count` is bumped only on `ResponseFinished`.** A body arrives as hundreds of
  `ResponseData` messages; re-rendering on each would be a render storm, and the
  recording itself is a ref (megabytes of bytes, none of it rendered).

## Testing

- `src/use-recorder.test.tsx` — the state machine against a fake coordinator
  and a fake sender: register-on-mount, the counter, events outside a
  recording dropped, the `SaveHar` → `SniffingComplete` order, `UserDismissed`,
  answer matching by file name, `stop()` idempotence, and unmount while
  recording or idle.
- `src/recorder-page.test.tsx` — the page's affordances: Start enablement
  follows the URL's validity, Stop shows only while recording, the folder and
  the saved path are shown, a folder the host can't give says why, and Show
  file reveals the saved file, says so when it can't, and is absent where the
  platform can't reveal one. Over an in-memory bookmark host: the rows in
  recency order with when each was recorded, a name filling the URL field,
  Bookmark this adding under the entered name and absent for a bookmarked or
  unstartable URL, Rename and Remove, Start stamping its URL, unreadable
  bookmarks saying why while recording still works, and a refused add's
  reason in the banner. It renders the page under a `RecorderProvider`.
- `apps/host/host-app`'s `src/host-root.test.tsx` — a recording kept going
  while the base shows.

## References

- [recorder AGENTS.md](../AGENTS.md) — the recorder's role and packages.
- [recorder-core-js AGENTS.md](../recorder-core-js/AGENTS.md) — `Recording`,
  `toHar`, `recordingFileName`, `RecorderBridge`.
- [Web Handler Coordinator Explanation](../../../../docs/Effect/Web%20Handler%20Coordinator%20Explanation.md)
  — the register/unregister contract the hook follows.
- [Bridge Explanation](../../../../docs/Messaging/Bridge%20Explanation.md) — the
  webview ↔ host bridge.

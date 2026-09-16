import { Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'

/**
 * The HAR Recorder's save channel: the SPA builds the archive, the host writes
 * it to disk and answers with the path it wrote or the reason it did not.
 *
 * @remarks
 * A separate bridge from `CollectorBridge` rather than two more tags on it: the
 * recorder's *intake* is the collector's data plane (the sniffer events), but
 * its *output* is a filesystem write that the collector has no part in, and a
 * tag must be unique across every listener on the shared `BRIDGE_EVENT`
 * channel. `SaveHar` / `HarSaved` / `HarSaveFailed` are unused by any other
 * bridge.
 *
 * The archive rides as `text` — the already-encoded contents of the `.har`
 * file — so there is one HAR emitter (`http-archive`) and the host needs no
 * HAR model of its own, only a validated file name and a write.
 *
 * See the [Wire Pinning How-To](../../../docs/Messaging/Wire%20Pinning%20How-To.md):
 * the wire strings below are the contract `har-recorder-rust`'s serde mirror is
 * pinned to by its golden tests.
 *
 * @packageDocumentation
 */

/**
 * Web → Host: write this archive into the app's `saved_data` directory.
 *
 * @remarks
 * `fileName` is one path segment, as {@link recordingFileName} produces it; the
 * host validates it again before any filesystem call (one segment, `.har`
 * suffix, `[A-Za-z0-9._-]`, ≤ 200 characters) and answers
 * {@link HarSaveFailed} without writing when it does not hold. `text` is the
 * `.har` file's contents — what `harToJson` encoded — not a nested object.
 *
 * Wire: `{"_tag":"SaveHar","fileName":"…","text":"…"}`
 */
const SaveHar = Schema.parseJson(
  Schema.TaggedStruct('SaveHar', {
    fileName: Schema.NonEmptyString,
    text: Schema.String,
  })
)
type SaveHar = Schema.Schema.Type<typeof SaveHar>

/**
 * Host → Web: the archive was written, and `path` is where it landed.
 *
 * @remarks
 * `path` is the absolute path of the written file, which the page shows as the
 * recording's result. `fileName` echoes the request so a page that has since
 * started another recording can tell whose answer this is.
 *
 * Wire: `{"_tag":"HarSaved","fileName":"…","path":"/…/saved_data/….har"}`
 */
const HarSaved = Schema.parseJson(
  Schema.TaggedStruct('HarSaved', {
    fileName: Schema.NonEmptyString,
    path: Schema.NonEmptyString,
  })
)
type HarSaved = Schema.Schema.Type<typeof HarSaved>

/**
 * Host → Web: nothing was written, and `message` says why.
 *
 * @remarks
 * Covers both a rejected `fileName` and a failed write. The recording's bytes
 * are gone with the page state either way, so the page surfaces this to the
 * user rather than retrying silently.
 *
 * Wire: `{"_tag":"HarSaveFailed","fileName":"…","message":"…"}`
 */
const HarSaveFailed = Schema.parseJson(
  Schema.TaggedStruct('HarSaveFailed', {
    fileName: Schema.NonEmptyString,
    message: Schema.String,
  })
)
type HarSaveFailed = Schema.Schema.Type<typeof HarSaveFailed>

type HarRecorderBridge = Bridge.Bridge<
  'HarRecorder',
  {
    HarSaved: typeof HarSaved
    HarSaveFailed: typeof HarSaveFailed
  },
  {
    SaveHar: typeof SaveHar
  }
>

/**
 * Slice-level bridge between the HAR Recorder page and its Tauri host.
 *
 * @remarks
 * One request (`SaveHar`) and its two terminal answers (`HarSaved`,
 * `HarSaveFailed`). No `urlParams`: a recording exists only inside a running
 * page, so there is no initial message to carry on a WebView source URL.
 *
 * The sniffer events the recording is built from do **not** ride here — they
 * arrive on `CollectorBridge`, whose host→web data plane already declares them.
 */
const HarRecorderBridge: HarRecorderBridge = Bridge.make({
  name: 'HarRecorder',
  hostToWeb: [
    ['HarSaved', HarSaved],
    ['HarSaveFailed', HarSaveFailed],
  ] as const,
  webToHost: [['SaveHar', SaveHar]] as const,
})

export { HarRecorderBridge, HarSaveFailed, HarSaved, SaveHar }

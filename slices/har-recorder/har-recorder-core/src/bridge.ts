import { Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'

/**
 * The HAR Recorder's save channel: the SPA builds the archive, the host writes
 * it to disk and answers with the path it wrote or the reason it did not.
 *
 * @remarks
 * Separate from `CollectorBridge` — which carries the recorder's sniffer-event
 * intake — because the save is a filesystem write the collector has no part in
 * and tags must be unique across the shared `BRIDGE_EVENT` channel. The archive
 * rides as already-encoded `.har` text, so the host needs no HAR model. See the
 * slice's [Design Explanation](../../docs/Design%20Explanation.md).
 *
 * The wire strings below are the contract `har-recorder-rust`'s serde mirror is
 * pinned to by its golden tests — see the
 * [Wire Pinning How-To](../../../docs/Messaging/Wire%20Pinning%20How-To.md).
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
 * `path` is absolute. `fileName` echoes the request so a page that has since
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
 * Covers both a rejected `fileName` and a failed write. The bytes are gone with
 * the page state either way, so the page surfaces this rather than retrying.
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
 * One request (`SaveHar`) and its two terminal answers. No `urlParams`: a
 * recording exists only inside a running page, so there is no initial message
 * to carry on a WebView source URL. The sniffer events it is built from arrive
 * on `CollectorBridge`, not here.
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

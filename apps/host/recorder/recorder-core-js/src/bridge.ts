import {
  CancelledMessage,
  PageLoadedMessage,
  PageRequestedMessage,
  RequestErrorMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  ResponseStartMessage,
} from '@wildflowerhealthio/browser-sniffer-core'
import { Bridge } from '@wildflowerhealthio/effect-messaging-core'
import { Schema } from 'effect'

/**
 * The Recorder's one bridge to its Tauri host: the sniffer's data plane in,
 * the sniffer window's lifecycle both ways, and the save channel for the
 * finished archive.
 *
 * @remarks
 * Every tag and wire shape here is the one `browser-sniffer-tauri` already
 * routes and emits, so the host's sniffer glue serves the recorder unchanged:
 * the data-plane messages are `browser-sniffer-core`'s own schemas, and the
 * control messages are the part of the sniffer's control vocabulary the
 * recorder uses. `recorder-wire-golden.json`, beside the packages, pins each
 * tag's wire; `recorder-rust`'s serde mirror of the save channel reads the
 * same file. See the
 * [Wire Pinning How-To](../../../../../docs/Messaging/Wire%20Pinning%20How-To.md).
 *
 * The archive rides `SaveHar` as already-encoded `.har` text, so the host
 * needs no HAR model. See the
 * [Design Explanation](../../docs/Design%20Explanation.md).
 *
 * @packageDocumentation
 */

/**
 * An `http(s)://` URL, the only kind of page the recorder opens.
 *
 * @remarks
 * The host's `Open` decoder refuses `file:`, `javascript:`, `data:` and the
 * rest, so the page refuses them first: Start is enabled on exactly the
 * inputs this accepts.
 */
const HttpUrl = Schema.String.pipe(
  Schema.filter((s) => s.startsWith('https://') || s.startsWith('http://'), {
    description: 'HTTP(S) URL only (http(s)://…)',
  })
)

/**
 * Web → Host: open `source.uri` in the sniffer webview, building the webview
 * if it isn't up, navigating it in place if it is.
 *
 * @remarks
 * The `Uri` source shape alone: the sniffer's `Open` also takes an inline
 * `Html` page and request options the recorder never sends.
 *
 * Wire: `{"_tag":"Open","source":{"_tag":"Uri","uri":"https://…"}}`
 */
const Open = Schema.parseJson(
  Schema.TaggedStruct('Open', {
    source: Schema.TaggedStruct('Uri', { uri: HttpUrl }),
  })
)

/**
 * Web → Host: the recording is over; close the sniffer webview.
 *
 * Wire: `{"_tag":"SniffingComplete"}`
 */
const SniffingComplete = Schema.parseJson(Schema.TaggedStruct('SniffingComplete', {}))

/**
 * Host → Web: the user closed the sniffer webview. The recorder saves, as
 * Stop & Save does.
 *
 * Wire: `{"_tag":"UserDismissed"}`
 */
const UserDismissed = Schema.parseJson(Schema.TaggedStruct('UserDismissed', {}))

/**
 * Host → Web: the sniffer webview was torn down, as it is after every
 * `SniffingComplete`. The recorder needs nothing from it.
 *
 * Wire: `{"_tag":"SnifferDisposed"}`
 */
const SnifferDisposed = Schema.parseJson(Schema.TaggedStruct('SnifferDisposed', {}))

/**
 * Web → Host: write this archive into the recordings folder.
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
 * Wire: `{"_tag":"HarSaved","fileName":"…","path":"/…/Wildflower Recordings/….har"}`
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

type RecorderBridge = Bridge.Bridge<
  'Recorder',
  {
    ResponseStart: typeof ResponseStartMessage
    ResponseData: typeof ResponseDataMessage
    ResponseFinished: typeof ResponseFinishedMessage
    RequestError: typeof RequestErrorMessage
    Cancelled: typeof CancelledMessage
    PageLoaded: typeof PageLoadedMessage
    PageRequested: typeof PageRequestedMessage
    UserDismissed: typeof UserDismissed
    SnifferDisposed: typeof SnifferDisposed
    HarSaved: typeof HarSaved
    HarSaveFailed: typeof HarSaveFailed
  },
  {
    Open: typeof Open
    SniffingComplete: typeof SniffingComplete
    SaveHar: typeof SaveHar
  }
>

/**
 * The bridge between the Recorder page and its Tauri host.
 *
 * @remarks
 * Host → Web: the sniffer's response events and page notifications, the
 * sniffer window's two lifecycle signals, and the two answers to a save.
 * Web → Host: open a page, close the window, save the archive.
 */
const RecorderBridge: RecorderBridge = Bridge.make({
  name: 'Recorder',
  hostToWeb: [
    ['ResponseStart', ResponseStartMessage],
    ['ResponseData', ResponseDataMessage],
    ['ResponseFinished', ResponseFinishedMessage],
    ['RequestError', RequestErrorMessage],
    ['Cancelled', CancelledMessage],
    ['PageLoaded', PageLoadedMessage],
    ['PageRequested', PageRequestedMessage],
    ['UserDismissed', UserDismissed],
    ['SnifferDisposed', SnifferDisposed],
    ['HarSaved', HarSaved],
    ['HarSaveFailed', HarSaveFailed],
  ] as const,
  webToHost: [
    ['Open', Open],
    ['SniffingComplete', SniffingComplete],
    ['SaveHar', SaveHar],
  ] as const,
})

export {
  HarSaveFailed,
  HarSaved,
  HttpUrl,
  Open,
  RecorderBridge,
  SaveHar,
  SnifferDisposed,
  SniffingComplete,
  UserDismissed,
}

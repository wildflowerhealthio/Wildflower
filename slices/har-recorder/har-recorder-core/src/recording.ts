import { Either, Encoding, type DateTime, type Schema } from 'effect'

import type {
  CancelledMessage,
  RequestErrorMessage,
  ResponseDataMessage,
  ResponseFinishedMessage,
  ResponseStartMessage,
} from 'browser-sniffer-core'
import { HttpArchive } from 'http-archive'
import { contentTypeOf } from 'web-trace-core/capture'

import { isOmittedFromRecording } from './omitted.ts'

/**
 * The recording itself: the browser-sniffer's response events, accumulated into
 * the {@link HttpArchive.Log} the recorder saves.
 *
 * @remarks
 * Pure and synchronous — no Effect runtime, no DOM, no clock of its own. Every
 * instant the log carries is one the caller observed and passed in, so a test
 * drives a whole recording without stubbing time.
 *
 * @packageDocumentation
 */

/** The largest body a recording keeps, per response. */
const MAX_BODY_BYTES = 5 * 1024 * 1024

/** The messages a recording is built from, decoded. */
type ResponseStart = Schema.Schema.Type<typeof ResponseStartMessage>
type ResponseData = Schema.Schema.Type<typeof ResponseDataMessage>
type ResponseFinished = Schema.Schema.Type<typeof ResponseFinishedMessage>
type RequestError = Schema.Schema.Type<typeof RequestErrorMessage>
type Cancelled = Schema.Schema.Type<typeof CancelledMessage>

/**
 * One response the sniffer has started reporting and not yet terminated.
 *
 * @remarks
 * `chunks` is empty once `overCap` is set — the bytes past the cap are not kept
 * and the ones before them are released, so a 200 MB download costs a recording
 * a counter rather than the heap. `bytes` keeps counting regardless, which is
 * what makes the omission honest: the entry states how much it did not keep.
 */
interface InFlight {
  readonly url: string
  readonly status: number
  readonly statusText: string
  readonly headers: readonly (readonly [string, string])[]
  readonly startedAt: DateTime.Utc
  chunks: Uint8Array[]
  bytes: number
  overCap: boolean
  undecodable: boolean
}

const concat = (chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> => {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const combined = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    combined.set(chunk, offset)
    offset += chunk.length
  }
  return combined
}

/**
 * A live recording: sniffer events in, archive entries out.
 *
 * @remarks
 * Mutable by design. A recording is one page session's worth of response
 * bodies — rebuilding the accumulated state per chunk would copy megabytes per
 * event — so the events mutate it in place and the caller holds one instance
 * for the run. Nothing it returns is a live view: {@link Recording.entries}
 * hands back a copy, and a settled entry's bytes are its own array.
 *
 * An event for an id the recording does not know is ignored, in every method.
 * That covers the three cases that actually happen: a response that started
 * before the recording did, a second terminal for an id that already settled,
 * and any event for a response whose content type the recording declined.
 */
class Recording {
  /** Responses reported but not yet terminated. */
  readonly #inFlight = new Map<string, InFlight>()
  /** Ids declined at `ResponseStart`, kept so their chunks and terminal drop. */
  readonly #omitted = new Set<string>()
  /** Settled entries, in settle order. */
  readonly #entries: HttpArchive.Entry[] = []
  /** Per settled entry, the body bytes observed — see {@link Recording.observedBodyBytes}. */
  readonly #observedBodyBytes = new Map<string, number>()

  private constructor() {}

  /** A recording with nothing in it. */
  static empty(): Recording {
    return new Recording()
  }

  /**
   * The entries settled so far, in the order they settled.
   *
   * @returns A fresh array, so a caller cannot append to the recording through it
   *
   * @remarks
   * Settle order, not start order: it is the order the recording actually
   * observed completions in, and re-sorting by start would claim an ordering
   * the capture did not establish for concurrent requests. `emitHarFromLog`
   * preserves the order it is given.
   */
  entries(): readonly HttpArchive.Entry[] {
    return [...this.#entries]
  }

  /** How many entries have settled — what a recording page shows while it runs. */
  get count(): number {
    return this.#entries.length
  }

  /**
   * Body bytes observed per settled entry, keyed by {@link HttpArchive.Entry.id}.
   *
   * @remarks
   * For a kept body this is `entry.body.length`. For an over-cap body it is the
   * count the projection cannot carry: {@link HttpArchive.Entry} has no size
   * field, so an entry with `bodyAbsent` re-encodes with `content.size` of `0`
   * and the true size is lost at that boundary. This is where it survives.
   */
  get observedBodyBytes(): ReadonlyMap<string, number> {
    return this.#observedBodyBytes
  }

  /**
   * A response began. Decides once whether this recording keeps it.
   *
   * @param message - The sniffer's `ResponseStart`
   * @param observedAt - When the caller observed the message; the entry's
   *   `startedAt`, because it is the only instant the sniffer's response side
   *   offers and the settle happens later
   *
   * @remarks
   * The keep/drop decision is made here and never revisited: a response whose
   * headers say `image/png` is declined before its first chunk arrives, so its
   * bytes never enter the recording at all. See {@link isOmittedFromRecording}.
   */
  onResponseStart(message: ResponseStart, observedAt: DateTime.Utc): void {
    if (isOmittedFromRecording(contentTypeOf(message.headers))) {
      this.#omitted.add(message.id)
      return
    }
    this.#inFlight.set(message.id, {
      url: message.url,
      status: message.status,
      statusText: message.statusText,
      headers: message.headers,
      startedAt: observedAt,
      chunks: [],
      bytes: 0,
      overCap: false,
      undecodable: false,
    })
  }

  /**
   * A chunk of a response body arrived.
   *
   * @param message - The sniffer's `ResponseData`, whose `data` is base64
   *
   * @remarks
   * Past {@link MAX_BODY_BYTES} the recording stops retaining bytes and drops
   * what it had, while still counting the size. A chunk whose base64 will not
   * decode marks the body undecodable, and the entry settles with no body
   * rather than with a hole in it — a truncated body archived as a whole one
   * would be read as the response the server sent.
   */
  onResponseData(message: ResponseData): void {
    const record = this.#inFlight.get(message.id)
    if (record === undefined) return
    const decoded = Encoding.decodeBase64(message.data)
    if (Either.isLeft(decoded)) {
      record.undecodable = true
      record.chunks = []
      return
    }
    const chunk = decoded.right
    record.bytes += chunk.length
    if (record.overCap || record.undecodable) return
    if (record.bytes > MAX_BODY_BYTES) {
      record.overCap = true
      record.chunks = []
      return
    }
    record.chunks.push(chunk)
  }

  /**
   * A response completed: it becomes an entry.
   *
   * @param message - The sniffer's `ResponseFinished`
   *
   * @remarks
   * `method` is `'UNKNOWN'` and the entry carries no request headers or body:
   * the recorder is response-side only, and states what it did not see rather
   * than guessing it (request-side capture is #440). The entry's id is
   * positional (`har-entry-<index>`), the convention `HttpArchive` synthesizes
   * on the way in, so an id means the same thing whether an archive was read or
   * recorded.
   */
  onResponseFinished(message: ResponseFinished): void {
    this.#omitted.delete(message.id)
    const record = this.#inFlight.get(message.id)
    if (record === undefined) return
    this.#inFlight.delete(message.id)
    const bodyAbsent = record.overCap || record.undecodable
    const id = `${HttpArchive.ENTRY_ID_PREFIX}${this.#entries.length}`
    this.#entries.push({
      id,
      url: record.url,
      method: 'UNKNOWN',
      status: record.status,
      statusText: record.statusText,
      headers: record.headers,
      startedAt: record.startedAt,
      body: bodyAbsent ? new Uint8Array(0) : concat(record.chunks),
      bodyAbsent,
    })
    this.#observedBodyBytes.set(id, record.bytes)
  }

  /**
   * The request failed. Nothing is archived for it.
   *
   * @param message - The sniffer's `RequestError`
   *
   * @remarks
   * A failed request has no complete body, and an entry carrying the prefix
   * that did arrive would read as the whole response. The recording drops it —
   * the absence is the honest record.
   */
  onRequestError(message: RequestError): void {
    this.#drop(message.id)
  }

  /**
   * The request was cancelled mid-stream. Nothing is archived for it.
   *
   * @param message - The sniffer's `Cancelled`, its terminal acknowledgement for
   *   a `CancelSnifferRequest`
   *
   * @remarks
   * Same reasoning as {@link Recording.onRequestError}: a partial body is not a
   * response.
   */
  onCancelled(message: Cancelled): void {
    this.#drop(message.id)
  }

  #drop(id: string): void {
    this.#inFlight.delete(id)
    this.#omitted.delete(id)
  }
}

export { MAX_BODY_BYTES, Recording }

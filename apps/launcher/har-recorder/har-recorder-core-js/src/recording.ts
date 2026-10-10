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
 * Pure, synchronous and clock-free — every instant the log carries is one the
 * caller observed and passed in.
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
 * Once `overCap` is set `chunks` is emptied and stays empty, so a 200 MB
 * download costs a counter rather than the heap; `bytes` keeps counting so the
 * entry can state how much it did not keep.
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

/**
 * The number of bytes a base64 string decodes to, without decoding it.
 *
 * @remarks
 * Used to keep counting {@link InFlight.bytes} once the cap has been reached,
 * without allocating the decoded buffer the recording is no longer keeping.
 */
const decodedBase64Length = (base64: string): number => {
  let len = base64.length
  // Strip whitespace that some encoders add (the sniffer's does not, but
  // defensive is free here).
  while (len > 0 && base64[len - 1] === '=') len -= 1
  // Every 4 base64 chars encode 3 bytes; the remainder encodes 1 or 2.
  const fullGroups = Math.floor(len / 4) * 3
  const remainder = len % 4
  return fullGroups + (remainder === 0 ? 0 : remainder - 1)
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
 * Mutable by design — rebuilding the accumulated state per chunk would copy
 * megabytes per event — so the caller holds one instance for the run. Nothing
 * it returns is a live view.
 *
 * Every method ignores an event for an id it does not know: a response that
 * started before the recording did, a repeated terminal, or an event for a
 * content type it declined.
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
   * Settle order, not start order: re-sorting by start would claim an ordering
   * the capture never established for concurrent requests.
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
   * {@link HttpArchive.Entry} has no size field, so a `bodyAbsent` entry
   * re-encodes with `content.size` of `0`; this map is where the observed count
   * survives.
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
   * The keep/drop decision is made here and never revisited, so a declined
   * response's bytes never enter the recording. See {@link isOmittedFromRecording}.
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
   * Past {@link MAX_BODY_BYTES} the recording stops retaining bytes while still
   * counting the size. A chunk whose base64 will not decode settles the entry
   * with no body rather than with a hole in it — a truncated body archived as a
   * whole one would be read as what the server sent.
   */
  onResponseData(message: ResponseData): void {
    const record = this.#inFlight.get(message.id)
    if (record === undefined) return
    // Already poisoned — count the bytes without decoding so a 200 MB download
    // costs only a counter, not a transient decode allocation per chunk.
    if (record.undecodable) return
    if (record.overCap) {
      record.bytes += decodedBase64Length(message.data)
      return
    }
    const decoded = Encoding.decodeBase64(message.data)
    if (Either.isLeft(decoded)) {
      record.undecodable = true
      record.chunks = []
      return
    }
    const chunk = decoded.right
    record.bytes += chunk.length
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
   * `method` is `'UNKNOWN'` and no request headers or body are carried: the
   * recorder is response-side only and states what it did not see rather than
   * guessing (request-side capture is #440). The id is positional, from
   * `HttpArchive.ENTRY_ID_PREFIX`, so it means the same thing whether an
   * archive was read or recorded.
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
   * An entry carrying only the prefix that arrived would read as the whole
   * response, so the absence is the honest record.
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
   * Same reasoning as {@link Recording.onRequestError}.
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

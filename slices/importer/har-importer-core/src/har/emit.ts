import { DateTime, Duration, Schema } from 'effect'

import type { TraceExchange } from 'web-trace-core'
import {
  type Har,
  type HarBody,
  type HarEntry,
  HarFromJson,
  type HarNameValue,
  type HarRequest,
  type HarTimings,
  NOT_MEASURED,
} from './har.ts'

/**
 * Turns a set of decoded exchanges into a HAR 1.2 archive — the format the
 * export boundary hands to a collector author.
 *
 * @remarks
 * HAR was chosen because it is widely consumable and agents read it fluently.
 * The awkward part is that HAR assumes a full request/response pair and a trace
 * has only the response half, so this emitter is explicit about every gap rather
 * than filling one in. See {@link emitHar}.
 *
 * This builds an archive; it does not serialize one. Writing the file is
 * `Schema.encode` of {@link HarFromJson} — the same schema an import reads
 * through, so the two directions cannot drift.
 *
 * @packageDocumentation
 */

/**
 * Why `request.method` is `UNKNOWN`. Carried on every entry so a reader who has
 * never seen the epic still learns why, from the file itself.
 */
const METHOD_COMMENT =
  'The capture shims fetch and XMLHttpRequest on the response side only, so the request method was never observed. It is reported as UNKNOWN rather than guessed as GET: a GET and a POST to this URL are indistinguishable in this trace.'

/** Why a request carries no headers or body. */
const REQUEST_COMMENT =
  'No request headers or request body were captured. A POST payload — the single most useful artifact for designing a collector against a search API — is not present in this trace.'

/** Why a `content` entry has a size but no text. */
const SKIPPED_BODY_COMMENT =
  'Body not available; its size is recorded. See the reason field for details.'

/**
 * Options for {@link emitHar}.
 */
interface EmitHarOptions {
  /** The session these exchanges came from, recorded on `log.creator`. */
  readonly sessionId: string
  /**
   * Version string for `log.creator.version`.
   *
   * @defaultValue `'0'`
   */
  readonly creatorVersion?: string
  /** Free-text note placed on `log.comment`, e.g. the redaction settings used. */
  readonly comment?: string
}

const CREATOR_NAME = 'Wildflower Web Trace'

const queryStringOf = (url: string): readonly HarNameValue[] => {
  try {
    return [...new URL(url).searchParams].map(([name, value]) => ({ name, value }))
  } catch {
    return []
  }
}

/** A stored body rides as base64, which is what the capture already holds. */
const bodyOf = (exchange: TraceExchange): HarBody =>
  exchange.body._tag === 'StoredBody'
    ? { _tag: 'HarBase64Body', text: exchange.body.data }
    : { _tag: 'HarNoBody' }

const contentOf = (exchange: TraceExchange): HarEntry['response']['content'] => ({
  size: exchange.body.size,
  mimeType: exchange.body.contentType,
  body: bodyOf(exchange),
  ...(exchange.body._tag === 'StoredBody'
    ? {}
    : { comment: `${SKIPPED_BODY_COMMENT} Reason: ${exchange.body.reason}` }),
})

/** HAR states every phase in milliseconds, so a measured `Duration` becomes one. */
const phaseOf = (measured: Duration.Duration | null): number =>
  measured === null ? NOT_MEASURED : Duration.toMillis(measured)

const timingsOf = (exchange: TraceExchange): HarTimings => ({
  // There is no request side to time.
  send: NOT_MEASURED,
  wait: phaseOf(exchange.timings.wait),
  receive: phaseOf(exchange.timings.receive),
})

/**
 * `entry.time` is the sum of the measured phases, or `-1` when nothing was
 * measured — HAR has no way to say "partially measured", and summing `-1`s into
 * a plausible-looking total would be a lie.
 */
const totalTimeOf = (timings: HarTimings): number => {
  const measured = [timings.send, timings.wait, timings.receive].filter((phase) => phase >= 0)
  return measured.length === 0 ? NOT_MEASURED : measured.reduce((total, phase) => total + phase, 0)
}

const requestOf = (exchange: TraceExchange): HarRequest => ({
  method: 'UNKNOWN',
  url: exchange.url,
  httpVersion: '',
  cookies: [],
  headers: [],
  queryString: queryStringOf(exchange.url),
  headersSize: NOT_MEASURED,
  bodySize: NOT_MEASURED,
  comment: `${METHOD_COMMENT} ${REQUEST_COMMENT}`,
})

const entryOf = (exchange: TraceExchange): HarEntry => {
  const timings = timingsOf(exchange)
  return {
    startedDateTime: exchange.startedAt,
    time: totalTimeOf(timings),
    request: requestOf(exchange),
    response: {
      status: exchange.status,
      statusText: exchange.statusText,
      httpVersion: '',
      cookies: [],
      headers: exchange.headers,
      content: contentOf(exchange),
      redirectURL: '',
      headersSize: NOT_MEASURED,
      bodySize: exchange.body.size,
    },
    cache: {},
    timings,
  }
}

/**
 * Emits a HAR 1.2 archive for a set of exchanges.
 *
 * @param exchanges - The exchanges to include, typically already redacted
 * @param options - Session identity and creator metadata
 * @returns An archive that encodes to one the HAR 1.2 schema validates
 *
 * @remarks
 * Entries come out ordered by start instant, the only ordering a reader can act
 * on — the capture order of concurrent requests is not meaningful.
 *
 * Nothing unobserved is guessed: `request.method` is `UNKNOWN`, unmeasured
 * timings are `-1`, and a skipped body is a `HarNoBody` with a size. Each
 * carries a HAR `comment` saying so, so a reader learns it from the file.
 *
 * This function does not redact. Pass it exchanges that have already been
 * through the pseudonymizer — an archive built from raw exchanges contains
 * everything the capture saw.
 */
const emitHar = (exchanges: readonly TraceExchange[], options: EmitHarOptions): Har => ({
  log: {
    version: '1.2',
    creator: {
      name: CREATOR_NAME,
      version: options.creatorVersion ?? '0',
      comment: `Session ${options.sessionId}`,
    },
    entries: [...exchanges]
      .toSorted(
        (left, right) =>
          DateTime.toEpochMillis(left.startedAt) - DateTime.toEpochMillis(right.startedAt)
      )
      .map(entryOf),
    ...(options.comment === undefined ? {} : { comment: options.comment }),
  },
})

/** Serializes an archive to the text of a `.har` file. */
const harToJson = Schema.encode(HarFromJson)

/** Reads the text of a `.har` file into an archive. */
const harFromJson = Schema.decodeUnknown(HarFromJson)

export {
  CREATOR_NAME,
  type EmitHarOptions,
  emitHar,
  harFromJson,
  harToJson,
  METHOD_COMMENT,
  REQUEST_COMMENT,
  SKIPPED_BODY_COMMENT,
}

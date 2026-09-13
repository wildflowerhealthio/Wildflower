import { DateTime } from 'effect'

import { emitHarFromLog, type Har } from 'http-archive'

import { MAX_BODY_BYTES, type Recording } from './recording.ts'

/**
 * The recording, emitted as the HAR 1.2 archive the host writes.
 *
 * @packageDocumentation
 */

/** What a recorded archive says produced it, on `log.creator.name`. */
const CREATOR_NAME = 'Wildflower HAR Recorder'

/**
 * Why a recorded entry states no request side, carried on every entry.
 *
 * @remarks
 * Distinct from `http-archive`'s `DROPPED_REQUEST_ON_IMPORT_COMMENT`, which
 * speaks for an archive that *had* a request side and lost it at import.
 */
const REQUEST_COMMENT =
  'The injected sniffer observes fetch and XMLHttpRequest on the response side only, so this exchange’s method, request headers and request body were never observed. They are reported as UNKNOWN and absent rather than guessed — a GET and a POST to this URL are indistinguishable in this recording.'

/** What a recording collected, stated on `log.comment`. */
const commentOf = (startUrl: string, startedAt: DateTime.Utc, stoppedAt: DateTime.Utc): string =>
  `Recorded ${startUrl} from ${DateTime.formatIso(startedAt)} to ${DateTime.formatIso(stoppedAt)}; fetch/XHR responses only; css/image/video/audio/font omitted; bodies over ${MAX_BODY_BYTES} bytes omitted.`

/** The run {@link toHar} describes in the archive it emits. */
interface ToHarOptions {
  /** The URL the recording was started at. */
  readonly startUrl: string
  /** When it started. */
  readonly startedAt: DateTime.Utc
  /** When it stopped — the moment the user asked for it to be saved. */
  readonly stoppedAt: DateTime.Utc
  /**
   * Version string for `log.creator.version`.
   *
   * @defaultValue `'0'`
   */
  readonly creatorVersion?: string
}

/**
 * Emits a recording as a HAR 1.2 archive.
 *
 * @param recording - The accumulated responses
 * @param options - The run the archive describes
 * @returns An archive that encodes to one the HAR 1.2 schema validates
 *
 * @remarks
 * The whole of the recorder's HAR knowledge is this call: `http-archive` owns
 * the format, and this adds only who produced the file and what the recording
 * did not carry. Encoding it to `.har` text is `harToJson`. Entries come out in
 * settle order, as {@link Recording.entries} holds them.
 */
const toHar = (recording: Recording, options: ToHarOptions): Har =>
  emitHarFromLog(
    { version: '1.2', entries: recording.entries() },
    {
      creatorName: CREATOR_NAME,
      ...(options.creatorVersion === undefined ? {} : { creatorVersion: options.creatorVersion }),
      comment: commentOf(options.startUrl, options.startedAt, options.stoppedAt),
      requestComment: REQUEST_COMMENT,
    }
  )

export { CREATOR_NAME, MAX_BODY_BYTES, REQUEST_COMMENT, type ToHarOptions, toHar }

import { DateTime } from 'effect'

/**
 * What a saved recording is called: `<timestamp>-<host>.har`, one path segment
 * a Windows filesystem accepts.
 *
 * @packageDocumentation
 */

/** The host used when the start URL has none that survives reduction. */
const FALLBACK_HOST = 'recording'

/**
 * The longest name produced, matching the host's own validation.
 *
 * @remarks
 * The host rejects anything longer before it writes, so the producer stays
 * under the same number rather than discovering the limit as a failed save.
 */
const MAX_FILE_NAME_LENGTH = 200

const EXTENSION = '.har'

/**
 * The recording's host, reduced to what a file name may hold.
 *
 * @param startUrl - The URL the recording started at
 * @returns The lower-cased hostname with every character outside `[a-z0-9.-]`
 *   dropped, or {@link FALLBACK_HOST} when nothing usable is left
 *
 * @remarks
 * An allowlist, not an escape: an unparseable URL, an IPv6 host (whose brackets
 * and colons a file name cannot hold), and a punycode-free international host
 * all reduce to something safe rather than to a name the host will reject.
 */
const hostOf = (startUrl: string): string => {
  let hostname: string
  try {
    hostname = new URL(startUrl).hostname.toLowerCase()
  } catch {
    hostname = ''
  }
  const reduced = hostname.replaceAll(/[^a-z0-9.-]/g, '')
  return reduced === '' ? FALLBACK_HOST : reduced
}

/**
 * The instant, as a file name may hold it: `YYYY-MM-DDTHH-mm-ssZ`.
 *
 * @remarks
 * ISO 8601 with the time's colons replaced by hyphens — Windows forbids `:` in
 * a path segment — and the sub-second part dropped, which no recording needs to
 * be distinguished by.
 */
const timestampOf = (startedAt: DateTime.Utc): string =>
  `${DateTime.formatIsoDateUtc(startedAt)}T${DateTime.formatIso(startedAt).slice(11, 19).replaceAll(':', '-')}Z`

/**
 * Names the file a recording is saved as.
 *
 * @param startedAt - When the recording started
 * @param startUrl - The URL it started at; only its host is used
 * @returns One path segment matching `/^[A-Za-z0-9._-]+\.har$/`, at most
 *   {@link MAX_FILE_NAME_LENGTH} characters
 *
 * @remarks
 * Flat by design: recordings land side by side in `saved_data/`, so the name
 * carries everything that distinguishes one — when, and from where. The
 * timestamp leads so a directory listing sorts chronologically.
 *
 * Over-long names are trimmed from the *host*, never from the timestamp: a
 * truncated instant would read as a different one, while a truncated host is
 * visibly partial. The result is a valid single segment for any input,
 * including a URL that does not parse — which is what keeps a bad URL from
 * becoming a rejected save or, worse, a path traversal.
 */
const recordingFileName = (startedAt: DateTime.Utc, startUrl: string): string => {
  const timestamp = timestampOf(startedAt)
  const room = MAX_FILE_NAME_LENGTH - timestamp.length - 1 - EXTENSION.length
  const host = hostOf(startUrl).slice(0, room)
  return `${timestamp}-${host}${EXTENSION}`
}

export { MAX_FILE_NAME_LENGTH, recordingFileName }

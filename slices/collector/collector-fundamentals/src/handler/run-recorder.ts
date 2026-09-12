import { Effect } from 'effect'
import { type Extraction, isOmittedContentType } from 'http-extraction-fundamentals'

import type { CollectorHttpResponse } from '../model/collector-http-response.ts'

/**
 * A run-scoped observer of every response the sniffer settled, claimed by an
 * entity or not, accumulated as `Extraction.Input`s in arrival order.
 *
 * @remarks
 * Inert by design: it encodes nothing, writes nothing and uploads nothing, and
 * has **no size cap** — it holds entries in memory for the run's owner to
 * drain. Page furniture is the one thing it drops, via
 * {@link isOmittedContentType}. One recorder per run: `entries` is the whole
 * run's traffic, and the arrival order across entities is part of the record.
 *
 * For why the recorder sits beside routing rather than after it, see
 * [The run recorder](../../docs/Handler%20Explanation.md#the-run-recorder-seeing-what-routing-discards).
 */
interface RunRecorder {
  /**
   * Append `response` to the recording, unless its content type is omitted.
   *
   * @param response - A response whose body has settled on the wire
   *
   * @remarks
   * Reads `bytes()`, never `text()`: a recording is replayed, and a body that
   * is not valid UTF-8 does not survive a `text()` round trip.
   * `CollectorHttpResponse.bytes()` hands back a fresh array, so the entry owns
   * its body. `startedAt` rides along from the response, which observed it when
   * the response *started* — `record` runs at settle, so a clock read here
   * would relabel every entry's beginning as its end.
   *
   * Effect-returning although the work is synchronous, so a future recorder can
   * do real I/O without changing a caller.
   */
  readonly record: (response: CollectorHttpResponse) => Effect.Effect<void, never, never>
  /**
   * Everything recorded so far, in settle order.
   *
   * @returns The entries, as a snapshot — later `record` calls do not change it
   */
  readonly entries: () => readonly Extraction.Input[]
}

/**
 * Build a {@link RunRecorder} with an empty recording.
 *
 * @returns A recorder, ready to be handed to `CollectorBridgeMessageHandler.make`
 */
const make: Effect.Effect<RunRecorder, never, never> = Effect.sync(() => {
  const recorded: Extraction.Input[] = []

  const record = (response: CollectorHttpResponse): Effect.Effect<void, never, never> =>
    Effect.sync(() => {
      if (isOmittedContentType(response.headers)) return
      recorded.push({
        id: response.id,
        url: response.url,
        method: response.method,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        startedAt: response.startedAt,
        body: response.bytes(),
        // `bodyAbsent` is for an archive that recorded an exchange without its
        // content; a live sniff called at settle always has the body in hand.
        bodyAbsent: false,
      })
    })

  // A copy, so a caller cannot reorder the recording and a snapshot taken
  // mid-run stays the run as it was at that moment.
  const entries = (): readonly Extraction.Input[] => [...recorded]

  return { record, entries }
})

export type { RunRecorder }
export { make }

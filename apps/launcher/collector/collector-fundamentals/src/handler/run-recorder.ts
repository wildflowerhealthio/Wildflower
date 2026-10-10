import { type Extraction, isOmittedContentType } from 'http-extraction-fundamentals'
import type { CollectorHttpResponse } from '../model/index.ts'

/**
 * A run-scoped recorder that accumulates an {@link Extraction.Input} for every
 * settled response whose content type is not omitted. The recorder is injected
 * by the runner and invoked by the tracker at every settle point
 * (`ResponseFinished` and `RequestError`), before the parse runs — so a parse
 * failure or an unclaimed response is still recorded.
 *
 * Nothing is encoded, uploaded, or written — this is the observable seam the
 * next tickets (C2/C3) build on.
 */
interface RunRecorder {
  /**
   * Record a settled response. Reads `bytes()` (never `text()`) and appends an
   * {@link Extraction.Input} unless the response's content type is omitted
   * (JavaScript, CSS, images, fonts, audio, video).
   */
  readonly record: (response: CollectorHttpResponse) => void
  /** The recorded entries in settle order. */
  readonly entries: () => readonly Extraction.Input[]
}

const make = (): RunRecorder => {
  const recorded: Extraction.Input[] = []

  return {
    record(response) {
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
        bodyAbsent: false,
      })
    },
    entries: () => recorded,
  }
}

export type { RunRecorder }
export { make }

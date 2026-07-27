/**
 * The subset of HAR 1.2 this package emits, as TypeScript types.
 *
 * @remarks
 * These mirror the published HAR 1.2 JSON Schema (`har-schema`), which the test
 * suite validates emitted archives against — the schema is the authority, these
 * types are the compile-time convenience. Fields the spec marks optional and
 * this emitter never has anything to say about (`pages`, `browser`, `postData`)
 * are simply absent.
 *
 * @packageDocumentation
 */

/** A `(name, value)` pair, the shape HAR uses for headers, query params, and cookies. */
interface HarNameValue {
  readonly name: string
  readonly value: string
  readonly comment?: string
}

/** HAR `content` — the response body, or the record of one that was not stored. */
interface HarContent {
  /** Length in bytes of the response body as captured. */
  readonly size: number
  readonly mimeType: string
  /** Absent when the body was not stored. */
  readonly text?: string
  /** `base64` when {@link HarContent.text} is base64 rather than plain text. */
  readonly encoding?: string
  readonly comment?: string
}

/** HAR `request`. Everything here except `url` is a placeholder — see {@link emitHar}. */
interface HarRequest {
  readonly method: string
  readonly url: string
  readonly httpVersion: string
  readonly cookies: readonly HarNameValue[]
  readonly headers: readonly HarNameValue[]
  readonly queryString: readonly HarNameValue[]
  readonly headersSize: number
  readonly bodySize: number
  readonly comment?: string
}

/** HAR `response`. */
interface HarResponse {
  readonly status: number
  readonly statusText: string
  readonly httpVersion: string
  readonly cookies: readonly HarNameValue[]
  readonly headers: readonly HarNameValue[]
  readonly content: HarContent
  readonly redirectURL: string
  readonly headersSize: number
  readonly bodySize: number
  readonly comment?: string
}

/** HAR `timings`. `-1` is the spec's "not applicable or not measured". */
interface HarTimings {
  readonly send: number
  readonly wait: number
  readonly receive: number
  readonly comment?: string
}

/** HAR `entry` — one exchange. */
interface HarEntry {
  readonly startedDateTime: string
  readonly time: number
  readonly request: HarRequest
  readonly response: HarResponse
  readonly cache: Record<string, never>
  readonly timings: HarTimings
  readonly comment?: string
}

/** HAR `creator`. */
interface HarCreator {
  readonly name: string
  readonly version: string
  readonly comment?: string
}

/** HAR `log`. */
interface HarLog {
  readonly version: '1.2'
  readonly creator: HarCreator
  readonly entries: readonly HarEntry[]
  readonly comment?: string
}

/** A complete HAR archive. */
interface Har {
  readonly log: HarLog
}

export type {
  Har,
  HarContent,
  HarCreator,
  HarEntry,
  HarLog,
  HarNameValue,
  HarRequest,
  HarResponse,
  HarTimings,
}

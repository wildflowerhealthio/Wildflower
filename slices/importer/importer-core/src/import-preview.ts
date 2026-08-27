import type { ParseResult } from 'effect'

import type { FhirResource } from 'fhir-r4/resources'

/**
 * The result of previewing a HAR import: what running the flat pool over the
 * archive's traffic would write, per-URL.
 *
 * @remarks
 * A single shape, not a tagged union: recognition is **per-response** now (each
 * URL routed independently against the pool), so "no source claimed" is no
 * longer a distinct outcome — an archive nothing recognized is simply a
 * `Preview` whose batches are empty (`unmatchedCount === totalResponses`,
 * `rootUrls` empty), which a caller renders as "nothing here". The only thing
 * that reaches an Effect error channel from `HarImport.run` is a malformed
 * archive (a `ParseError` from the HAR decode); every downstream outcome is data
 * on this type.
 *
 * Nothing here is persisted — a preview is read, confirmed, and only then does
 * {@link persist} write. This type is the whole contract between the two halves
 * of that flow.
 */

/**
 * One archived response whose decode failed, surfaced for display rather than
 * aborting the fold.
 *
 * @remarks
 * The archive was never captured for our purpose, so a response that a kind
 * recognized but did not decode as the resource that pattern promises is a
 * reportable outcome, not a run-ending error — the same stance `Extraction.run`
 * takes. `url` locates it for a reviewer; `error` is the decode's own
 * `ParseError`.
 */
interface ImportParseFailure {
  readonly url: string
  readonly error: ParseResult.ParseError
}

/**
 * What running the pool over the archive produced — grouped for display, with
 * every non-resource outcome counted.
 *
 * @remarks
 * `resourcesByType` is the previewed resources grouped by FHIR `resourceType`
 * (`Patient`, `Observation`, …), each already re-keyed under the root of the URL
 * it arrived on by the pool's entities — the ids here are the ids a subsequent
 * {@link persist} writes. The three counts and `parseFailures` account for every
 * archived exchange that did not become a previewed resource:
 *
 * - `parseFailures` — a kind recognized the URL, the body failed to decode.
 * - `unmatchedCount` — no kind recognized the URL (the browser noise around the
 *   FHIR traffic). An archive nothing recognized has `unmatchedCount ===
 *   totalResponses`.
 * - `bodyAbsentCount` — a kind recognized the URL, but the archive stored no
 *   body, so the entity was never run (distinct from an empty body — see
 *   `Extraction.Input.bodyAbsent`).
 *
 * `rootUrls` is **every** distinct `source.system` the archive's recognized
 * responses named, in first-seen order — read off recognition, not one inferred
 * root. A single capture can span several FHIR servers, and each resource is
 * keyed under the root of *its own* URL, so a two-server archive keeps both
 * roots here and keys each server's resources apart (their ids in
 * `resourcesByType` never collide). It labels the sources; it does not choose
 * between them. `totalResponses` equals the sum of every resource-producing
 * batch's inputs plus the three counts.
 */
interface Preview {
  readonly rootUrls: readonly string[]
  readonly resourcesByType: Readonly<Record<string, readonly FhirResource[]>>
  readonly parseFailures: readonly ImportParseFailure[]
  readonly unmatchedCount: number
  readonly bodyAbsentCount: number
  readonly totalResponses: number
}

/** The outcome of `HarImport.run` — always a {@link Preview}. */
type ImportPreview = Preview

export { persist } from './persist-preview.ts'
export type { ImportParseFailure, ImportPreview, Preview }

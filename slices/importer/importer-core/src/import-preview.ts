import type { ParseResult } from 'effect'

import type { FhirResource } from 'fhir-r4/resources'

/**
 * The result of previewing a HAR import: either no registered HTTP source
 * claimed the archive's traffic, or one did and here is what it would write.
 *
 * @remarks
 * A tagged union rather than an error channel, because "no source claims this
 * traffic" is an ordinary, first-class outcome the caller renders — a browser's
 * HAR export of a site we have no source for is not a failure, it is a
 * `NoSourceClaims`. The only thing that reaches an Effect error channel from
 * `HarImport.run` is a malformed archive (a `ParseError` from the HAR
 * decode); every downstream outcome is data on this union.
 *
 * Nothing here is persisted — a preview is read, confirmed, and only then does
 * {@link persist} write. This type is the whole contract between the two
 * halves of that flow.
 */

/**
 * One archived response whose decode failed, surfaced for display rather than
 * aborting the fold.
 *
 * @remarks
 * The archive was never captured for our purpose, so a response that matched a
 * source's URL pattern but did not decode as the resource that pattern
 * promises is a reportable outcome, not a run-ending error — the same stance
 * `Extraction.run` takes. `url` locates it for a reviewer; `error` is the
 * decode's own `ParseError`.
 */
interface ImportParseFailure {
  readonly url: string
  readonly error: ParseResult.ParseError
}

/**
 * No registered source claimed the archive's traffic.
 *
 * @remarks
 * A first-class outcome, not an error: an archive of a site we have no source
 * for, or one carrying no FHIR resource URL at all, lands here. `totalEntries`
 * is the archive's exchange count so a caller can say "read 42 entries, none
 * recognized" rather than an empty, unexplained result.
 */
interface NoSourceClaims {
  readonly _tag: 'NoSourceClaims'
  readonly totalEntries: number
}

/**
 * A registered source claimed the archive, and this is what running its
 * entities produced — grouped for display, with every non-resource outcome
 * counted.
 *
 * @remarks
 * `resourcesByType` is the previewed resources grouped by FHIR `resourceType`
 * (`Patient`, `Observation`, …), each already re-keyed under the root of the URL
 * it arrived on by the source's entities — the ids here are the ids a
 * subsequent {@link persist} writes. The three counts and
 * `parseFailures` account for every archived exchange that did not become a
 * previewed resource:
 *
 * - `parseFailures` — matched a pattern, failed to decode.
 * - `unmatchedCount` — no entity claimed the URL (the browser noise around the
 *   FHIR traffic).
 * - `bodyAbsentCount` — matched a pattern, but the archive stored no body, so
 *   the entity was never run (distinct from an empty body — see
 *   `Extraction.Input.bodyAbsent`).
 *
 * `rootUrls` is **every** distinct source root the archive reached, in first-seen
 * order — not one inferred root. A single capture can span several FHIR servers,
 * and the source's entities key each resource under the root of *its own* URL,
 * so a two-server archive keeps both roots here and keys each server's resources
 * apart under them (their ids in `resourcesByType` never collide). It labels the
 * sources; it does not choose between them. `totalEntries` equals the sum of
 * every resource-producing batch's inputs plus the three counts.
 */
interface Preview {
  readonly _tag: 'Preview'
  readonly sourceTag: string
  readonly rootUrls: readonly string[]
  readonly resourcesByType: Readonly<Record<string, readonly FhirResource[]>>
  readonly parseFailures: readonly ImportParseFailure[]
  readonly unmatchedCount: number
  readonly bodyAbsentCount: number
  readonly totalEntries: number
}

/** The two outcomes of `HarImport.run`. */
type ImportPreview = NoSourceClaims | Preview

export { persist } from './persist-preview.ts'
export type { ImportParseFailure, ImportPreview, NoSourceClaims, Preview }

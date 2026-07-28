import { Effect } from 'effect'
import type { TraceExchange } from 'web-trace-core'
import {
  buildRedactionPolicy,
  isJsonContentType,
  mapExchangeLeaves,
  redactSession,
  type JsonLeaf,
  type LeafVisitor,
  type PathStat,
  type RedactionError,
  type RedactionOptions,
} from 'web-trace-core/pseudonymizer'

/**
 * The before → after the export preview renders, taken from the pseudonymizer's
 * own output.
 *
 * @remarks
 * The `after` values here are the values that go into the archive: they are
 * sampled from what {@link redactSession} produced, and the very same redacted
 * exchanges are handed to `emitHar`. That is deliberate. The ticket's export
 * acceptance test exists to prove the UI routes *through* the pseudonymizer
 * rather than around it, so a preview that computed its own before/after would
 * defeat the test it is meant to satisfy — and could show a reviewer something
 * the download does not do.
 *
 * Nothing in this module redacts. It calls `web-trace-core`'s redactor and
 * reads its results.
 *
 * @packageDocumentation
 */

/** One path's decision, with a sample of what it looks like on each side. */
interface PreviewRow extends PathStat {
  /**
   * A sample value at this path as captured, or `null` when the path has none.
   *
   * @remarks
   * The first value seen at the path, not every value — a path can hold
   * thousands, and the decision being reviewed is per path.
   */
  readonly before: string | null
  /**
   * The same position's value after redaction, or `null` when the redacted
   * walk produced no value at this path.
   *
   * @remarks
   * `null` is rare and honest rather than impossible: a pseudonym keeps its
   * original's shape, so a redacted URL segment still reads as an identifier
   * and lands on the same path template — but a preview that invented an
   * `after` for a path the redactor did not produce would be asserting
   * something about the archive that is not true.
   */
  readonly after: string | null
}

/** What {@link buildExportPreview} produced: the rows to review, and the archive's contents. */
interface ExportPreview {
  /** Every path the redactor decided on, in first-seen order. */
  readonly rows: readonly PreviewRow[]
  /**
   * The redacted exchanges themselves — what `emitHar` must be given.
   *
   * @remarks
   * Carried on the preview rather than recomputed at download time so the
   * archive cannot differ from what was reviewed. Re-redacting would mint the
   * same values (the policy's assignment table is deterministic under one
   * salt), but "would" is weaker than "is the same object".
   */
  readonly redacted: readonly TraceExchange[]
}

/**
 * The first value seen at each leaf path.
 *
 * @param exchanges - The exchanges to walk
 * @returns Path → the first value at it, stringified the way the policy's own
 *   counting pass stringifies values
 *
 * @remarks
 * Walks through `mapExchangeLeaves`, the same traversal both redaction passes
 * use, so the paths here cannot drift from the paths the policy decided on. The
 * visitor returns each value unchanged — this is a read, not a rewrite.
 */
const sampleLeaves = (
  exchanges: readonly TraceExchange[]
): Effect.Effect<ReadonlyMap<string, string>> =>
  Effect.gen(function* () {
    const samples = new Map<string, string>()
    const remember = <A extends JsonLeaf>(path: string, value: A): A => {
      if (!samples.has(path)) {
        samples.set(path, typeof value === 'string' ? value : JSON.stringify(value))
      }
      return value
    }
    const reading: LeafVisitor<never> = {
      visitString: (path, value) => Effect.sync(() => remember(path, value)),
      visitJsonLeaf: (path, value) => Effect.sync(() => remember(path, value)),
    }
    for (const exchange of exchanges) yield* mapExchangeLeaves(exchange, reading)
    return samples
  })

/**
 * Builds the preview for one export: what each path was decided to be, what it
 * held, and what it will hold in the archive.
 *
 * @param exchanges - The exchanges being exported, raw
 * @param options - The export's salt, enum settings, and per-path overrides
 * @returns The rows to review and the redacted exchanges to emit
 *
 * @remarks
 * One policy for the whole export, per the core's contract: the assignment
 * table it accumulates is what makes response A's `pid` and response B's
 * `patientId` land on the same pseudonym, and it must never be shared with
 * another export.
 */
const buildExportPreview = (
  exchanges: readonly TraceExchange[],
  options: RedactionOptions
): Effect.Effect<ExportPreview, RedactionError> =>
  Effect.gen(function* () {
    const policy = yield* buildRedactionPolicy(exchanges, options)
    const before = yield* sampleLeaves(exchanges)
    const redacted = yield* redactSession(policy, exchanges)
    const after = yield* sampleLeaves(redacted)
    return {
      rows: policy.stats.map((stat) => ({
        ...stat,
        before: before.get(stat.path) ?? null,
        after: after.get(stat.path) ?? null,
      })),
      redacted,
    }
  })

/**
 * How many stored bodies the export will drop for not being JSON.
 *
 * @param exchanges - The exchanges being exported, raw
 * @returns The count of stored, non-JSON bodies
 *
 * @remarks
 * The export is JSON-only by design: the redactor cannot pseudonymize a format
 * it cannot parse, and shipping one unredacted is not an option, so an HTML or
 * binary body becomes a `SkippedBody` with its size at the boundary. The viewer
 * shows every content type; the export does not. Surfacing the count is what
 * keeps that from reading as a silent loss — an export that quietly dropped a
 * non-JSON exchange's body would misrepresent what the session did.
 */
const droppedBodyCount = (exchanges: readonly TraceExchange[]): number =>
  exchanges.filter(
    (exchange) =>
      exchange.body._tag === 'StoredBody' && !isJsonContentType(exchange.body.contentType)
  ).length

export { buildExportPreview, droppedBodyCount, type ExportPreview, type PreviewRow, sampleLeaves }

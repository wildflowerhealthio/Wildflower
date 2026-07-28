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
 * Nothing here redacts: this module calls `web-trace-core`'s redactor and reads
 * its results, so the `after` a reviewer sees is literally what the archive
 * carries. See the package `AGENTS.md` for why a preview that computed its own
 * before/after would defeat the acceptance test it exists to satisfy.
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
   * The same position's value after redaction, or `null` when the redacted walk
   * produced no value at this path.
   *
   * @remarks
   * `null` is rare — a pseudonym keeps its original's shape, so a redacted URL
   * segment still lands on the same path template — but inventing an `after`
   * the redactor never produced would assert something untrue about the archive.
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
   * Carried on the preview rather than recomputed at download time, so the
   * archive cannot differ from what was reviewed. Re-redacting *would* mint the
   * same values, but "would" is weaker than "is the same object".
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

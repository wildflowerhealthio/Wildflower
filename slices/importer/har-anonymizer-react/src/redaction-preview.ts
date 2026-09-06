import { Effect } from 'effect'
import {
  buildPolicyForLog,
  isJsonEntry,
  type JsonLeaf,
  type LeafVisitor,
  mapEntryLeaves,
  type PathStat,
  redactLog,
  type RedactionError,
  type RedactionOptions,
} from 'har-importer-core/anonymizer'
import type { HttpArchive } from 'har-importer-core/har'

/**
 * The before → after the anonymize preview renders, taken from the
 * pseudonymizer's own output.
 *
 * @remarks
 * Nothing here redacts: this module calls `har-importer-core`'s HAR-native
 * redactor and reads its results, so the `after` a reviewer sees is literally
 * what the archive carries. A preview that computed its own before/after would
 * defeat the acceptance test it exists to satisfy.
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
   * the redactor never produced would assert something untrue about the
   * archive.
   */
  readonly after: string | null
}

/** What {@link buildAnonymizePreview} produced: the rows to review, and the archive's contents. */
interface AnonymizePreview {
  /** Every path the redactor decided on, in first-seen order. */
  readonly rows: readonly PreviewRow[]
  /**
   * The redacted archive itself — what an emit must be given.
   *
   * @remarks
   * Carried on the preview rather than recomputed at download time, so the
   * archive cannot differ from what was reviewed. Re-redacting *would* mint
   * the same values, but "would" is weaker than "is the same object".
   */
  readonly redacted: HttpArchive.Log
}

/**
 * The first value seen at each leaf path in a log.
 *
 * @param log - The archive to walk
 * @returns Path → the first value at it, stringified the way the policy's own
 *   counting pass stringifies values
 *
 * @remarks
 * Walks through `mapEntryLeaves`, the same traversal both redaction passes
 * use, so the paths here cannot drift from the paths the policy decided on.
 * The visitor returns each value unchanged — this is a read, not a rewrite.
 */
const sampleLeaves = (log: HttpArchive.Log): Effect.Effect<ReadonlyMap<string, string>> =>
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
    for (const entry of log.entries) yield* mapEntryLeaves(entry, reading)
    return samples
  })

/**
 * Builds the preview for one anonymize: what each path was decided to be, what
 * it held, and what it will hold in the archive.
 *
 * @param log - The archive being anonymized, raw
 * @param options - The salt, enum settings, and per-path overrides
 * @returns The rows to review and the redacted log to emit
 *
 * @remarks
 * One policy for the whole archive, per the core's contract: the assignment
 * table it accumulates is what makes response A's `pid` and response B's
 * `patientId` land on the same pseudonym, and it must never be shared with
 * another anonymize.
 */
const buildAnonymizePreview = (
  log: HttpArchive.Log,
  options: RedactionOptions
): Effect.Effect<AnonymizePreview, RedactionError> =>
  Effect.gen(function* () {
    const policy = yield* buildPolicyForLog(log, options)
    const before = yield* sampleLeaves(log)
    const redacted = yield* redactLog(policy, log)
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
 * How many present bodies the anonymize will drop for not being JSON.
 *
 * @param log - The archive being anonymized, raw
 * @returns The count of present, non-JSON bodies
 *
 * @remarks
 * The anonymize is JSON-only by design: the redactor cannot pseudonymize a
 * format it cannot parse, and shipping one unredacted is not an option, so an
 * HTML or binary body is dropped at the boundary. Surfacing the count is what
 * keeps that from reading as a silent loss — an archive that quietly dropped
 * a non-JSON entry's body would misrepresent what the source held.
 */
const droppedBodyCount = (log: HttpArchive.Log): number =>
  log.entries.filter((entry) => !entry.bodyAbsent && !isJsonEntry(entry)).length

/**
 * How many present bodies the anonymize will carry through.
 *
 * @param log - The archive being anonymized, raw
 * @returns The count of present JSON bodies
 */
const jsonBodyCount = (log: HttpArchive.Log): number =>
  log.entries.filter((entry) => !entry.bodyAbsent && isJsonEntry(entry)).length

export {
  type AnonymizePreview,
  buildAnonymizePreview,
  droppedBodyCount,
  jsonBodyCount,
  type PreviewRow,
  sampleLeaves,
}

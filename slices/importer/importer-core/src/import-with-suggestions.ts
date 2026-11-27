/**
 * An import run with no reviewer: a picked batch read into an import plan,
 * every suggestion taken, resolved and written as one transaction's
 * resources, which the caller persists.
 *
 * @packageDocumentation
 */
import type { FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import {
  ImportedRecord,
  ImportPlan,
  ImportWrite,
  type PickedFile,
  type PlanResolution,
  type RecordKey,
  resolvePlan,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Data, Effect, Option } from 'effect'

import type { FindStoredMatch } from './find-stored-match.ts'
import { planImport } from './plan-import.ts'
import { type BatchCopies, copiesOf, readBatchCopies } from './read-batch-copies.ts'
import type { ReadRegistry } from './read-batch.ts'
import type { FormatSettings } from './registry.ts'

/** One record with no choice, as a failure names it: its key and its title. */
interface UndecidedRecord {
  readonly key: RecordKey.Type
  readonly title: string
}

/**
 * The run's plan left records with no choice: their suggestions need a
 * reviewer (several stored records are the record, or several name matches
 * on a record other records reference), so nothing can be written.
 */
class UndecidedRecords extends Data.TaggedError('UndecidedRecords')<{
  readonly records: readonly UndecidedRecord[]
}> {
  override get message(): string {
    return `No choice for ${this.records.map(({ title }) => title).join(', ')}`
  }
}

/**
 * A run's result: the batch as read (`readBatchCopies`), what each claimed
 * format read, in registry order, and the picks no format claimed, beside
 * the plan resolved and the resources of the one transaction that writes it.
 * `formats[].copies` are the copies the plan was built from, the same
 * resources the resolution's records hold.
 */
interface SuggestedImport extends BatchCopies {
  readonly resolution: PlanResolution.Type
  /** The transaction's resources, each once, in plan order (`ImportWrite.Ready`). */
  readonly resources: readonly FhirResourceWithId[]
}

/** The records of `plan` under `keys`, each named by its key and its title. */
const undecidedRecordsOf = (
  plan: ImportPlan.Type,
  keys: readonly RecordKey.Type[]
): readonly UndecidedRecord[] =>
  Arr.filterMap(keys, (key) =>
    Option.map(ImportPlan.get(plan, key), ({ record }) => ({
      key,
      title: ImportedRecord.titleOf(record),
    }))
  )

/**
 * Read `picks` and import them with every suggestion taken: the batch is
 * read as copies of records (`readBatchCopies`), the copies are matched by
 * `findMatch` and planned (`planImport`), resolved (`resolvePlan`) and
 * written (`ImportWrite.of`).
 *
 * @param registry - The registered formats
 * @param settings - Every format's settings
 * @param picks - The batch, in pick order
 * @param findMatch - `findStoredMatch` to match against the FHIR server, or
 *   `noStore` for an import with no store, every record then saved as new
 * @returns The resolution and the resources to write, which nothing here
 *   sends; fails with {@link UndecidedRecords} naming every record a reviewer
 *   has to decide, and with whatever `findMatch` fails with
 *
 * @remarks
 * A file set the import stage cannot import is reported as an unreadable row
 * per picked file of its format, as `readBatch` reports it, and the rest of
 * the batch is imported.
 */
const importWithSuggestions = <E, R, RMatch>(
  registry: ReadRegistry<R>,
  settings: FormatSettings,
  picks: readonly PickedFile.NamedBytes[],
  findMatch: FindStoredMatch<E, RMatch>
): Effect.Effect<SuggestedImport, E | UndecidedRecords, R | RMatch> =>
  Effect.gen(function* () {
    const batchCopies = yield* readBatchCopies(registry, settings, picks)
    const plan = yield* planImport(copiesOf(batchCopies), findMatch)
    const resolution = yield* resolvePlan(plan)
    const resources = yield* ImportWrite.match(ImportWrite.of(resolution), {
      Ready: ({ resources: ready }) => Effect.succeed(ready),
      Blocked: ({ undecided }) =>
        Effect.fail(new UndecidedRecords({ records: undecidedRecordsOf(plan, undecided) })),
    })
    return { ...batchCopies, resolution, resources }
  })

export { importWithSuggestions, UndecidedRecords }
export type { SuggestedImport, UndecidedRecord }

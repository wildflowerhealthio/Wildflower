/**
 * The import plan's stage work: an import's copies matched against the store
 * the caller names and suggested from what it holds.
 *
 * @packageDocumentation
 */
import {
  type ImportedCopy,
  ImportedRecord,
  type ImportPlan,
  RecordReferences,
  suggestPlan,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect } from 'effect'

import type { FindStoredMatch } from './find-stored-match.ts'

/**
 * The import plan of `copies`: their records (`ImportedRecord.fromCopies`)
 * matched by `findMatch` and suggested from what it finds
 * ({@link suggestPlan}).
 *
 * @param copies - Every copy of every record of the import, in plan order
 * @param findMatch - `findStoredMatch` to match against the FHIR server, or
 *   `noStore` for an import with no store
 * @returns The plan; fails with whatever `findMatch` fails with
 */
const planImport = <E, R>(
  copies: readonly ImportedCopy.Type[],
  findMatch: FindStoredMatch<E, R>
): Effect.Effect<ImportPlan.Type, E, R> => {
  const records = ImportedRecord.fromCopies(copies)
  const recordReferences = RecordReferences.of(records)
  return Effect.map(findMatch(records, recordReferences.unresolved), (storedMatch) =>
    suggestPlan(records, recordReferences, storedMatch)
  )
}

export { planImport }

/**
 * The import plan's stage work: an import's copies matched against the store
 * and suggested from what it holds.
 *
 * @packageDocumentation
 */
import type { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import {
  type ImportedCopy,
  ImportedRecord,
  type ImportPlan,
  RecordReferences,
  suggestPlan,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect } from 'effect'

import { findStoredMatch, type StoredMatchFailure } from './find-stored-match.ts'

/**
 * The import plan of `copies`: their records (`ImportedRecord.fromCopies`)
 * matched against the store
 * ({@link findStoredMatch}) and suggested from it ({@link suggestPlan}).
 *
 * @param copies - Every copy of every record of the import, in plan order
 */
const planImport = (
  copies: readonly ImportedCopy.Type[]
): Effect.Effect<ImportPlan.Type, StoredMatchFailure, FhirR4ResourcesHttpApiClient> => {
  const records = ImportedRecord.fromCopies(copies)
  const recordReferences = RecordReferences.of(records)
  return Effect.map(findStoredMatch(records, recordReferences.unresolved), (storedMatch) =>
    suggestPlan(records, recordReferences, storedMatch)
  )
}

export { planImport }

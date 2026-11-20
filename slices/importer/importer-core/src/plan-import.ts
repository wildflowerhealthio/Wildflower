/**
 * The import plan's stage work: an import's copies matched against the store
 * and suggested from what it holds.
 *
 * @packageDocumentation
 */
import type { FhirR4ResourcesHttpApiClient } from '@wildflowerhealthio/fhir-r4/clients'
import {
  FileCopy,
  type ImportPlan,
  RecordReferences,
  suggestPlan,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect } from 'effect'

import { findStoredMatch, type StoredMatchFailure } from './find-stored-match.ts'

/**
 * The import plan of `copies`: their records matched against the store
 * ({@link findStoredMatch}) and suggested from it ({@link suggestPlan}).
 *
 * @param copies - Every copy of every record of the import, in plan order
 */
const planImport = (
  copies: readonly FileCopy.Type[]
): Effect.Effect<ImportPlan.Type, StoredMatchFailure, FhirR4ResourcesHttpApiClient> => {
  const records = FileCopy.groupByRecord(copies)
  return Effect.map(
    findStoredMatch(records, RecordReferences.of(records).unresolved),
    (storedMatch) => suggestPlan(copies, storedMatch)
  )
}

export { planImport }

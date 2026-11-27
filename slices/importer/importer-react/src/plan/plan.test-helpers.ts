/**
 * Builders for the import plan page's tests: imported records, stored
 * resources and planned records, built from the model's own entities.
 *
 * @packageDocumentation
 */
import type { ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import {
  FhirResourceSchema,
  type FhirResourceWithId,
  StoredResourceSchema,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  type ImportedCopy,
  ImportedRecord,
  type ImportPlan,
  locateReferences,
  PlannedRecord,
  type RecordChoice,
  resolvePlan,
  StoredMatch,
  Suggestion,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, DateTime, Effect, Option, Schema } from 'effect'

import * as PlanDifferences from './plan-differences.ts'
import type * as PlanSections from './plan-sections.ts'

/** The one record the file `fileName` brings, a copy of the resource of the wire `fields`, titled `title`. */
const importedRecordOf = (
  fields: object,
  title: string,
  fileName = 'a.har'
): ImportedRecord.Type => {
  const resource: ImportedCopy.Type['resource'] = {
    ...Schema.decodeUnknownSync(FhirResourceSchema)({ id: 'stage-id', ...fields }),
    id: null,
  }
  const copy: ImportedCopy.Type = {
    origin: {
      format: 'har',
      pickedFiles: [{ id: `0:${fileName}`, fileName, bytes: new Uint8Array() }],
    },
    reviewKey: `0:${fileName}/${title}`,
    title,
    isImplied: false,
    resource,
    sourceUrl: Option.none(),
    stageId: { _tag: 'Minted', id: 'stage-id' },
  }
  return Option.getOrThrow(Arr.head(ImportedRecord.fromCopies([copy])))
}

/** A stored resource of the wire `fields`, decoded. */
const storedOf = (fields: object): FhirResourceWithId =>
  Schema.decodeUnknownSync(StoredResourceSchema)(fields)

/** `resource` as a `probable` match found by name. */
const probableMatch = (resource: FhirResourceWithId): ResourceMatch.Candidate => ({
  resource,
  grade: 'probable',
  by: 'name',
})

/**
 * `record` as it needs a decision: matched by name to `candidates`, others
 * referencing it, and suggested `suggested` (`None` to leave it undecided).
 */
const needingDecision = (
  record: ImportedRecord.Type,
  candidates: readonly ResourceMatch.Candidate[],
  suggested: Option.Option<RecordChoice.Type> = Option.none()
): PlannedRecord.Type =>
  PlannedRecord.make({
    record,
    storedMatch: StoredMatch.makeEntry(candidates, Option.none()),
    suggestion: Suggestion.make(suggested, Suggestion.NameMatchReferenced()),
  })

/** Tyra Banks's Patient wire, born 1990-01-02, with `fields` over it. */
const tyraWire = (fields: object = {}): object => ({
  resourceType: 'Patient',
  name: [{ family: 'Banks', given: ['Tyra'] }],
  birthDate: '1990-01-02',
  ...fields,
})

/** When the tests' plans are read: the instant a person's name in use is judged at. */
const READ_AT = DateTime.unsafeMake('2026-11-27T12:00:00Z')

/** `plan` resolved now and reviewed as the page hook reviews it, read at {@link READ_AT}. */
const reviewedPlanOf = (plan: ImportPlan.Type): PlanSections.ReviewedPlan => ({
  resolution: Effect.runSync(resolvePlan(plan)),
  differences: PlanDifferences.ofPlan(plan),
  recordReferences: locateReferences(plan.records.map(({ record }) => record)),
  readAt: READ_AT,
})

export {
  importedRecordOf,
  needingDecision,
  probableMatch,
  READ_AT,
  reviewedPlanOf,
  storedOf,
  tyraWire,
}

import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { MatchGrade, ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import { FhirResourceSchema, type FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Either, HashSet, Option } from 'effect'
import fc from 'fast-check'

import type * as PickedFile from '../picked-file.ts'
import { decoded } from '../stored-candidates.test-helpers.ts'
import * as ImportPlan from './entities/import-plan.ts'
import * as ImportedCopy from './entities/imported-copy.ts'
import * as ImportedRecord from './entities/imported-record.ts'
import * as PlannedRecord from './entities/planned-record.ts'
import * as RecordChoice from './entities/record-choice.ts'
import * as RecordKey from './entities/record-key.ts'
import * as StoredMatch from './entities/stored-match.ts'
import * as Suggestion from './entities/suggestion.ts'

/**
 * Builders for the import plan's tests, entities and operations alike:
 * detached and stored resources, the copies a file set brings, candidates,
 * stored matches, and the sample import with its plan as suggested, built
 * from entities alone.
 */

const SOURCE = 'https://source.example/id'
const OTHER_SOURCE = 'https://other.example/id'
const NAMES = 'https://pharmacy.example/practitioner-name'

/** A detached resource of the wire `fields`, decoded. */
const detached = (fields: object): DetachedResource.Type =>
  Either.getOrThrow(DetachedResource.decodeUnknownEither(FhirResourceSchema)(fields))

/** A stored resource of the wire `fields`, decoded. */
const stored = (fields: object): FhirResourceWithId => decoded(fields)

/** A picked file of `fileName`, its id its name. */
const pickedFile = (fileName: string): PickedFile.Type => ({
  id: fileName,
  fileName,
  bytes: new Uint8Array(),
})

/** The copy of `resource` the file `fileName` brings under `reviewKey`. */
const copyOf = (
  resource: DetachedResource.Type,
  reviewKey: string,
  fileName = 'a.har',
  overrides: Partial<ImportedCopy.Type> = {}
): ImportedCopy.Type => ({
  origin: { format: 'har', pickedFiles: [pickedFile(fileName)] },
  reviewKey: `${fileName}/${reviewKey}`,
  title: reviewKey,
  isImplied: false,
  resource,
  sourceUrl: Option.none(),
  stageId: { _tag: 'Minted', id: `minted/${fileName}/${reviewKey}` },
  ...overrides,
})

/**
 * The key of a record with no key identifier or source URL that the importer
 * assigned `importerAssignedKey`, for a record a test needs no copy of.
 */
const keyByImporterAssignedKey = (importerAssignedKey: string): RecordKey.Type =>
  RecordKey.make({
    resource: detached({ resourceType: 'Binary', contentType: 'text/plain' }),
    sourceUrl: Option.none(),
    importerAssignedKey,
  })

/** `resource` as a candidate of `grade`, found `by`. */
const candidate = (
  resource: FhirResourceWithId,
  grade: MatchGrade.Type,
  by: ResourceMatch.Evidence
): ResourceMatch.Candidate => ({ resource, grade, by })

/** Tyra's Patient wire, keyed by `value` under `system`, with `fields` over it. */
const tyraWire = (value: string, fields: object = {}, system: string = SOURCE): object => ({
  resourceType: 'Patient',
  identifier: [{ system, value }],
  name: [{ family: 'Ashford', given: ['Tyra'] }],
  birthDate: '1990-01-02',
  ...fields,
})

/** Dr. Brown's Practitioner as a pharmacy names him: keyed by his printed name, which is his only name. */
const drBrownWire = {
  resourceType: 'Practitioner',
  identifier: [{ system: NAMES, value: 'Dr. Brown' }],
  name: [{ text: 'Dr. Brown' }],
}

/** A MedicationRequest keyed by `value`, for Tyra, naming its requester by `requester`'s first identifier. */
const prescriptionWire = (
  value: string,
  requester: { readonly system: string; readonly value: string }
): object => ({
  resourceType: 'MedicationRequest',
  identifier: [{ system: SOURCE, value }],
  status: 'active',
  intent: 'order',
  medicationCodeableConcept: { text: 'Metformin' },
  subject: { type: 'Patient', identifier: { system: SOURCE, value: 'tyra' } },
  requester: { type: 'Practitioner', identifier: requester, display: 'Dr. Brown' },
})

/** A stored match giving each key its candidates and nothing under its derived id, no reference any. */
const matchOf = (
  entries: readonly (readonly [RecordKey.Type, readonly ResourceMatch.Candidate[]])[]
): StoredMatch.Type =>
  StoredMatch.make({
    records: entries.map(
      ([key, candidates]) => [key, StoredMatch.makeEntry(candidates, Option.none())] as const
    ),
    references: [],
  })

/** Tyra's Patient from `a.har`, as the sample import's first file holds her. */
const tyraA = copyOf(detached(tyraWire('tyra')), 'tyra', 'a.har')
/** Tyra's Patient from `b.pdf`, which states her gender. */
const tyraB = copyOf(detached(tyraWire('tyra', { gender: 'female' })), 'tyra', 'b.pdf')
/** Tyra's prescription from `a.har`, its requester Dr. Brown by his printed name. */
const prescription = copyOf(
  detached(prescriptionWire('rx-1', { system: NAMES, value: 'Dr. Brown' })),
  'rx-1',
  'a.har'
)
/** The Dr. Brown the prescription implies. */
const drBrown = copyOf(detached(drBrownWire), 'rx-1#implied', 'a.har', { isImplied: true })

/** Tyra as the store holds her. */
const storedTyra = stored({ ...tyraWire('tyra'), id: 'p-1' })
/** A stored Dr. Brown, who matches the implied one by name. */
const storedBrown = stored({
  resourceType: 'Practitioner',
  id: 'pr-1',
  name: [{ family: 'Brown', given: ['Jonathan'] }],
})

/** The sample import's copies, in plan order: Tyra from two files, a prescription, and the Dr. Brown it implies. */
const SAMPLE_COPIES: readonly ImportedCopy.Type[] = [tyraA, prescription, drBrown, tyraB]

/** What the store holds of the sample import: Tyra by identifier, Dr. Brown by name. */
const sampleMatch = (): StoredMatch.Type =>
  matchOf([
    [ImportedCopy.recordKeyOf(tyraA), [candidate(storedTyra, 'certain', 'identifier')]],
    [ImportedCopy.recordKeyOf(drBrown), [candidate(storedBrown, 'probable', 'name')]],
  ])

/** The planned record of `copies`, one record's copies, suggested `suggestion`. */
const plannedOf = (
  copies: readonly ImportedCopy.Type[],
  suggestion: Suggestion.Type
): PlannedRecord.Type => {
  const [record] = ImportedRecord.fromCopies(copies)
  if (record === undefined) throw new Error('A planned record needs a copy')
  return PlannedRecord.make({
    record,
    storedMatch: StoredMatch.ofRecord(sampleMatch(), record.key),
    suggestion,
  })
}

/**
 * The sample import's plan as `suggestPlan` suggests it, built from entities
 * alone: Tyra merges into her stored record taking her gender, the
 * prescription is new, and Dr. Brown, referenced and matched by name, is in
 * Needs a decision with his one candidate.
 */
const samplePlan = (): ImportPlan.Type =>
  ImportPlan.make(
    [
      plannedOf(
        [tyraA, tyraB],
        Suggestion.make(
          Option.some(
            RecordChoice.MergeIntoExistingRecord({
              existing: storedTyra,
              fieldsTaken: HashSet.make('gender'),
            })
          ),
          Suggestion.OneIdentifierMatch()
        )
      ),
      plannedOf(
        [prescription],
        Suggestion.make(Option.some(RecordChoice.SaveAsNewRecord()), Suggestion.NoMatch())
      ),
      plannedOf(
        [drBrown],
        Suggestion.make(
          Option.some(
            RecordChoice.MergeIntoExistingRecord({
              existing: storedBrown,
              fieldsTaken: HashSet.empty(),
            })
          ),
          Suggestion.NameMatchReferenced()
        )
      ),
    ],
    sampleMatch()
  )

/** A reviewer's step: a choice for the record at `index`, or a reset of it by `null`. */
interface ReviewerStep {
  readonly index: number
  readonly choice: RecordChoice.Type | null
}

/** A reviewer's step over the sample plan's three records. */
const reviewerStepArbitrary: fc.Arbitrary<ReviewerStep> = fc.record({
  index: fc.nat({ max: 2 }),
  choice: fc.option(
    fc.constantFrom(
      RecordChoice.SaveAsNewRecord(),
      RecordChoice.DontAdd(),
      RecordChoice.MergeIntoExistingRecord({ existing: storedTyra, fieldsTaken: HashSet.empty() }),
      RecordChoice.MergeIntoExistingRecord({
        existing: storedTyra,
        fieldsTaken: HashSet.make('gender'),
      })
    ),
    { nil: null }
  ),
})

/** `plan` after the reviewer's `steps`, each choosing for or resetting one record. */
const afterSteps = (plan: ImportPlan.Type, steps: readonly ReviewerStep[]): ImportPlan.Type =>
  steps.reduce((reviewed, { index, choice }) => {
    const keys = reviewed.records.slice(index, index + 1).map(({ record }) => record.key)
    return choice === null
      ? ImportPlan.reset(reviewed, keys)
      : ImportPlan.choose(reviewed, keys, choice)
  }, plan)

export {
  afterSteps,
  candidate,
  copyOf,
  detached,
  drBrown,
  drBrownWire,
  keyByImporterAssignedKey,
  matchOf,
  plannedOf,
  NAMES,
  OTHER_SOURCE,
  prescription,
  prescriptionWire,
  reviewerStepArbitrary,
  SAMPLE_COPIES,
  sampleMatch,
  samplePlan,
  SOURCE,
  stored,
  storedBrown,
  storedTyra,
  tyraA,
  tyraWire,
}

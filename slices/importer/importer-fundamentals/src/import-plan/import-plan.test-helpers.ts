import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { MatchGrade, ResourceMatch } from '@wildflowerhealthio/fhir-r4/clients'
import { FhirResourceSchema, type FhirResourceWithId } from '@wildflowerhealthio/fhir-r4/resources'
import { Either, Option } from 'effect'

import type * as PickedFile from '../picked-file.ts'
import { decoded } from '../stored-candidates.test-helpers.ts'
import type * as FileCopy from './file-copy.ts'

/**
 * Builders for the import plan's tests: detached and stored resources, the
 * copies a file set brings, and candidates.
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
  overrides: Partial<FileCopy.Type> = {}
): FileCopy.Type => ({
  format: 'har',
  pickedFiles: [pickedFile(fileName)],
  reviewKey: `${fileName}/${reviewKey}`,
  title: reviewKey,
  isImplied: false,
  resource,
  sourceUrl: Option.none(),
  derivedId: Option.none(),
  ...overrides,
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

export {
  candidate,
  copyOf,
  detached,
  drBrownWire,
  NAMES,
  OTHER_SOURCE,
  pickedFile,
  prescriptionWire,
  SOURCE,
  stored,
  tyraWire,
}

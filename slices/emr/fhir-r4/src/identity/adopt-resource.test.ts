import { Arbitrary, FastCheck as fc, type Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'

import type {
  IdentifierType,
  ReferenceType,
} from '../data-types/complex/identifier-and-reference.ts'
import {
  Binary,
  DocumentReference,
  type FhirResource,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
} from '../resources/index.ts'
import { adoptResource, originalIdOf, type SourceIdentity } from './adopt-resource.ts'
import { localResourceId } from './local-resource-id.ts'

/**
 * Covers adoption of a single resource: the derived id, the injected source
 * identifier, and the reference rewrite. Three failure modes this suite exists
 * to catch, each of which loses data silently:
 *
 * - identifiers the source already carried being clobbered (asserted by value,
 *   never by reference);
 * - fields outside the reference table being blanked or invented (asserted by
 *   diffing everything the table does *not* name);
 * - the rewrite accepting reference strings that are not relative references
 *   (a `#fragment`, a `urn:uuid:`, an id with a space).
 *
 * Resources come from each schema's own arbitrary rather than hand-rolled
 * shapes, so every field is populated with something — a hand-built shell would
 * leave the "did adoption blank it?" question unasked for whatever the author
 * forgot to fill in.
 */

const SOURCE: SourceIdentity = {
  system: 'https://source.example/baseR4',
  baseUrl: 'https://source.example/baseR4',
}

/** A source whose references are always relative — no `baseUrl`. */
const RELATIVE_SOURCE: SourceIdentity = {
  system: 'https://wildflowerhealth.io/fhir/sid/example-portal',
}

const adopt = adoptResource(SOURCE)

const reference = (overrides: Partial<ReferenceType> = {}): ReferenceType => ({
  id: null,
  extension: [],
  display: null,
  identifier: null,
  reference: null,
  type: null,
  ...overrides,
})

const identifier = (overrides: Partial<IdentifierType> = {}): IdentifierType => ({
  id: null,
  extension: [],
  assigner: null,
  period: null,
  system: null,
  type: null,
  use: null,
  value: null,
  ...overrides,
})

/** One deterministic, schema-valid resource of the given type. */
const sample = <A, I>(schema: Schema.Schema<A, I>, seed: number): A => {
  const [value] = fc.sample(Arbitrary.make(schema), { numRuns: 1, seed })
  if (value === undefined) throw new Error('unreachable: one sample requested')
  return value
}

/**
 * Every field adoption is permitted to touch, per resource type. This table is
 * the contract; the "no collateral change" property below diffs everything
 * *not* named here.
 */
const ADOPTED_FIELDS = {
  Binary: ['id', 'securityContext'],
  Patient: ['id', 'identifier', 'generalPractitioner', 'managingOrganization', 'link', 'contact'],
  Observation: [
    'id',
    'identifier',
    'subject',
    'encounter',
    'device',
    'specimen',
    'basedOn',
    'derivedFrom',
    'focus',
    'hasMember',
    'partOf',
    'performer',
  ],
  MedicationRequest: [
    'id',
    'identifier',
    'subject',
    'encounter',
    'requester',
    'performer',
    'recorder',
    'priorPrescription',
    'reportedReference',
    'medicationReference',
    'supportingInformation',
    'reasonReference',
    'basedOn',
    'insurance',
    'detectedIssue',
    'eventHistory',
    'dispenseRequest',
  ],
  MedicationDispense: [
    'id',
    'identifier',
    'subject',
    'context',
    'location',
    'destination',
    'statusReasonReference',
    'medicationReference',
    'partOf',
    'supportingInformation',
    'authorizingPrescription',
    'receiver',
    'detectedIssue',
    'eventHistory',
    'performer',
    'substitution',
  ],
  DocumentReference: [
    'id',
    'identifier',
    'subject',
    'authenticator',
    'custodian',
    'author',
    'relatesTo',
    'context',
  ],
} as const satisfies Record<FhirResource['resourceType'], readonly string[]>

/** Every own field of `resource` except the ones adoption may rewrite. */
const untouchedFields = (resource: FhirResource): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(resource).filter(
      ([key]) => !ADOPTED_FIELDS[resource.resourceType].some((field) => field === key)
    )
  )

/** One generated resource per type in the closed union, with a known id. */
const resources: readonly FhirResource[] = [
  { ...sample(Binary.Schema, 11), id: 'src-1' },
  { ...sample(Patient.Schema, 12), id: 'src-1' },
  { ...sample(Observation.Schema, 13), id: 'src-1' },
  { ...sample(MedicationRequest.Schema, 14), id: 'src-1' },
  { ...sample(MedicationDispense.Schema, 15), id: 'src-1' },
  { ...sample(DocumentReference.Schema, 16), id: 'src-1' },
]

describe('adoptResource', () => {
  for (const resource of resources) {
    const { resourceType } = resource

    test(`${resourceType}: derives the local id`, () => {
      expect(adopt(resource).id).toBe(localResourceId(SOURCE.system, resourceType, 'src-1'))
    })

    // The whole point of diffing the complement of the table: a rewrite that
    // spread a stale copy, or blanked a field it did not mean to name, shows up
    // here rather than passing unnoticed because no assertion mentioned it.
    test(`${resourceType}: changes nothing outside the reference table`, () => {
      const adopted = adopt(resource)
      expect(Object.keys(adopted).toSorted()).toEqual(Object.keys(resource).toSorted())
      expect(untouchedFields(adopted)).toEqual(untouchedFields(resource))
    })

    test(`${resourceType}: leaves contained byte-untouched`, () => {
      // `contained` is raw passthrough JSON — a decoded Identifier injected in
      // there would write `null`s onto the wire.
      const adopted = adopt(resource)
      if ('contained' in adopted && 'contained' in resource) {
        expect(adopted.contained).toBe(resource.contained)
      }
    })

    test(`${resourceType}: passes a null-id resource straight through`, () => {
      const idLess = { ...resource, id: null }
      expect(adopt(idLess)).toBe(idLess)
    })
  }

  test('keeps every identifier the source already carried, and prepends its own', () => {
    const existing = [
      identifier({ value: 'mrn-9', system: new URL('https://source.example/sid/mrn') }),
      identifier({ value: 'ohip-4' }),
    ]
    const adopted = adopt({ ...sample(Patient.Schema, 12), id: 'src-1', identifier: existing })
    if (adopted.resourceType !== 'Patient') throw new Error('unreachable: adopted a Patient')

    expect(adopted.identifier[0]).toEqual(
      identifier({ value: 'src-1', system: new URL(SOURCE.system) })
    )
    // Compared by value. Adoption necessarily builds a new array, so there is
    // no reference to assert on — and an implementation that rebuilt it from a
    // stale copy of the resource would be caught only by the contents.
    expect(adopted.identifier.slice(1)).toEqual(existing)
  })

  test('Binary is adopted but gets no identifier — R4 gives it none', () => {
    const binary = { ...sample(Binary.Schema, 11), id: 'src-1' }
    const adopted = adopt(binary)
    expect(adopted.id).toBe(localResourceId(SOURCE.system, 'Binary', 'src-1'))
    expect('identifier' in adopted).toBe(false)
    expect(originalIdOf(SOURCE, adopted)).toBeNull()
  })

  test('round-trips the source id back off every non-Binary resource', () => {
    for (const resource of resources) {
      if (resource.resourceType === 'Binary') continue
      expect(originalIdOf(SOURCE, adopt(resource))).toBe('src-1')
    }
  })

  test('reads no source id off a resource adopted under a different source', () => {
    const adopted = adopt({ ...sample(Observation.Schema, 13), id: 'src-1' })
    expect(originalIdOf(RELATIVE_SOURCE, adopted)).toBeNull()
  })

  test('reads no source id off a resource that was never adopted', () => {
    const raw = { ...sample(Observation.Schema, 13), id: 'src-1', identifier: [] }
    expect(originalIdOf(SOURCE, raw)).toBeNull()
  })
})

describe('reference rewriting', () => {
  const observationWith = (subject: ReferenceType): typeof Observation.Schema.Type => ({
    ...sample(Observation.Schema, 13),
    id: 'obs-1',
    subject,
  })

  const subjectOf = (source: SourceIdentity, subject: ReferenceType): ReferenceType | null => {
    const adopted = adoptResource(source)(observationWith(subject))
    if (adopted.resourceType !== 'Observation') throw new Error('unreachable: adopted Observation')
    return adopted.subject
  }

  // The cornerstone: a reference has to land on exactly the id its target gets,
  // or `$everything` (`?subject=Patient/{id}`) stops resolving.
  test('a subject reference lands on the id its Patient is adopted to', () => {
    const patient = adopt({ ...sample(Patient.Schema, 12), id: 'pat-7' })
    expect(subjectOf(SOURCE, reference({ reference: 'Patient/pat-7' }))?.reference).toBe(
      `Patient/${patient.id}`
    )
  })

  // Rexall's shape: a MedicationRequest and its MedicationDispense share one
  // source id, and the dispense links back to the request.
  test('a cross-type link resolves even when both sides share a source id', () => {
    const request = adopt({ ...sample(MedicationRequest.Schema, 14), id: 'rx-1' })
    const dispense = adopt({
      ...sample(MedicationDispense.Schema, 15),
      id: 'rx-1',
      authorizingPrescription: [reference({ reference: 'MedicationRequest/rx-1' })],
    })
    if (dispense.resourceType !== 'MedicationDispense') {
      throw new Error('unreachable: adopted a MedicationDispense')
    }
    expect(dispense.id).not.toBe(request.id)
    expect(dispense.authorizingPrescription[0]?.reference).toBe(`MedicationRequest/${request.id}`)
  })

  test('records the original target id on the reference when the slot is free', () => {
    expect(subjectOf(SOURCE, reference({ reference: 'Patient/pat-7' }))?.identifier).toEqual(
      identifier({ value: 'pat-7', system: new URL(SOURCE.system) })
    )
  })

  // `Reference.identifier` is 0..1 and some dialects already fill it with a
  // vendor id. Stealing that slot would discard a real identifier; the original
  // `Type/id` stays recoverable through the rewritten target instead.
  test('never steals a Reference.identifier the source already filled', () => {
    const vendor = identifier({ value: 'pharmacy-4821' })
    const rewritten = subjectOf(
      SOURCE,
      reference({ reference: 'Patient/pat-7', identifier: vendor })
    )
    expect(rewritten?.identifier).toEqual(vendor)
    expect(rewritten?.reference).not.toBe('Patient/pat-7')
  })

  test('rewrites an absolute self-reference exactly as its relative spelling', () => {
    const relative = subjectOf(SOURCE, reference({ reference: 'Patient/pat-7' }))
    const absolute = subjectOf(
      SOURCE,
      reference({ reference: 'https://source.example/baseR4/Patient/pat-7' })
    )
    expect(absolute).toEqual(relative)
  })

  test('leaves an absolute reference alone when the source declares no baseUrl', () => {
    const target = 'https://source.example/baseR4/Patient/pat-7'
    expect(subjectOf(RELATIVE_SOURCE, reference({ reference: target }))?.reference).toBe(target)
  })

  for (const [label, target] of [
    ['a contained-resource fragment', '#med-1'],
    ['a urn:uuid reference', 'urn:uuid:5a3b2c1d-0000-4000-8000-000000000000'],
    ['a foreign absolute URL', 'https://elsewhere.example/fhir/Patient/pat-7'],
    ['a version-specific reference', 'Patient/pat-7/_history/2'],
    ['an id carrying a space', 'Patient/pat 7'],
    ['a hyphenated type token', 'rexall-pharmacy-location/pharmacy-4821'],
    ['an empty string', ''],
  ] as const) {
    test(`leaves ${label} untouched`, () => {
      const original = reference({ reference: target })
      expect(subjectOf(SOURCE, original)).toEqual(original)
    })
  }

  test('leaves an identifier-only reference untouched', () => {
    const original = reference({ identifier: identifier({ value: 'only-an-identifier' }) })
    expect(subjectOf(SOURCE, original)).toEqual(original)
  })

  test('rewrites a type this package does not store, so the link resolves if it is ever imported', () => {
    expect(subjectOf(SOURCE, reference({ reference: 'Practitioner/prac-3' }))?.reference).toBe(
      `Practitioner/${localResourceId(SOURCE.system, 'Practitioner', 'prac-3')}`
    )
  })
})

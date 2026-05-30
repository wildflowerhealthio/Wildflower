import { makeAdapter } from '@livestore/adapter-node'
import { createStorePromise } from '@livestore/livestore'
import { Arbitrary, Either, LogLevel, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { events, queries, schema, Patient } from './index.ts'

const PatientSchema = Patient.RowSchema

// ---------------------------------------------------------------------------
// Decomposed round-trip.
//
// Round-tripping `Arbitrary.make(PatientSchema)` walked the entire Patient
// graph (HumanName[], Address[], Identifier[], Reference[], …) every
// iteration, blowing the 60s timeout. Each per-column property below picks
// ONE column out via `RowSchema.pick(name)` and round-trips just that
// sub-schema, so generation cost drops to O(field) per iteration.
//
// `Schema.Struct.pick(...)` doesn't always propagate the no-context
// constraint when columns reach `Schema.suspend(...)` (e.g. Reference
// →Identifier). At runtime every column schema is no-context, so the cast
// to `Schema.Schema.AnyNoContext` is sound and isolated to this helper.
//
// Reference-bearing columns walk a Reference→Identifier cycle each
// iteration. The cycle is exercised exhaustively in `cycles.test.ts`, so
// these columns get a smaller `numRuns` here purely to fit under 5s.
// ---------------------------------------------------------------------------

const REFERENCE_NUM_RUNS = numRunsFor({ base: 25 })

const roundTripColumn = (name: keyof typeof PatientSchema.Type, numRuns?: number): void => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see file header
  const sub = PatientSchema.pick(name) as unknown as Schema.Schema.AnyNoContext
  fc.assert(
    fc.property(Arbitrary.make(sub), (value) => {
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- AnyNoContext typing erasure (test-only)
      const encoded = Schema.encodeSync(sub)(value)
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- AnyNoContext typing erasure (test-only)
      const decoded = Schema.decodeSync(sub)(encoded)
      expect(decoded).toSchemaEqual(sub, value)
    }),
    { numRuns }
  )
}

interface ColumnCase {
  readonly name: keyof typeof PatientSchema.Type
  readonly numRuns?: number
}

const columnCases: readonly ColumnCase[] = [
  { name: 'name' },
  { name: 'address' },
  { name: 'telecom' },
  { name: 'photo' },
  { name: 'maritalStatus' },
  // PatientLink carries a Reference; falls under the cycle budget.
  { name: 'link', numRuns: REFERENCE_NUM_RUNS },
  { name: 'identifier', numRuns: REFERENCE_NUM_RUNS },
  { name: 'generalPractitioner', numRuns: REFERENCE_NUM_RUNS },
  { name: 'communication', numRuns: REFERENCE_NUM_RUNS },
  { name: 'contact', numRuns: REFERENCE_NUM_RUNS },
  { name: 'managingOrganization', numRuns: REFERENCE_NUM_RUNS },
  { name: 'active' },
  { name: 'birthDate' },
  { name: 'deceasedBoolean' },
  { name: 'deceasedDateTime' },
  { name: 'gender' },
  { name: 'multipleBirthBoolean' },
  { name: 'multipleBirthInteger' },
  { name: 'language' },
  { name: 'implicitRules' },
  { name: 'meta' },
  { name: 'resourceType' },
]

describe('Patient model', () => {
  test.each(columnCases)(
    'property: $name column round-trips',
    ({ name, numRuns }) => roundTripColumn(name, numRuns),
    10_000
  )

  test('decodes a realistic FHIR R4 Patient JSON payload', () => {
    const wirePayload: typeof PatientSchema.Encoded = {
      resourceType: 'Patient',
      id: 'example-patient-001',
      active: 1,
      name: JSON.stringify([
        {
          id: null,
          extension: [],
          use: 'official',
          family: 'Chalmers',
          given: ['Peter', 'James'],
          text: null,
          prefix: [],
          suffix: [],
          period: null,
        },
        {
          id: null,
          extension: [],
          use: 'usual',
          family: null,
          given: ['Jim'],
          text: null,
          prefix: [],
          suffix: [],
          period: null,
        },
      ]),
      gender: 'male',
      birthDate: '1974-12-25',
      address: JSON.stringify([
        {
          id: null,
          extension: [],
          use: 'home',
          type: 'both',
          text: '534 Erewhon St PeasantVille',
          line: ['534 Erewhon St'],
          city: 'PleasantVille',
          district: 'Rainbow',
          state: 'Vic',
          postalCode: '3999',
          country: 'Australia',
          period: null,
        },
      ]),
      telecom: JSON.stringify([
        {
          id: null,
          extension: [],
          system: 'phone',
          value: '(03) 5555 6473',
          use: 'work',
          rank: 1,
          period: null,
        },
        {
          id: null,
          extension: [],
          system: 'email',
          value: 'Jim@example.org',
          use: 'home',
          rank: null,
          period: null,
        },
      ]),
      identifier: JSON.stringify([
        {
          id: null,
          extension: [],
          use: 'usual',
          system: 'urn:oid:1.2.36.146.595.217.0.1',
          value: '12345',
          type: null,
          period: null,
          assigner: null,
        },
      ]),
      communication: '[]',
      contact: '[]',
      deceasedBoolean: null,
      deceasedDateTime: null,
      generalPractitioner: '[]',
      link: '[]',
      managingOrganization: null,
      maritalStatus: null,
      multipleBirthBoolean: null,
      multipleBirthInteger: null,
      photo: '[]',
      text: null,
      contained: '[]',
      extension: '[]',
      modifierExtension: '[]',
      meta: null,
      implicitRules: null,
      language: null,
    }

    const patient = Schema.decodeUnknownSync(PatientSchema)(wirePayload)
    expect(patient.resourceType).toBe('Patient')
    expect(patient.id).toBe('example-patient-001')
    expect(patient.active).toBe(true)
    expect(patient.gender).toBe('male')
    expect(patient.name[0]?.family).toBe('Chalmers')
    expect(patient.name[0]?.given).toEqual(['Peter', 'James'])
    expect(patient.address[0]?.city).toBe('PleasantVille')
    expect(patient.telecom[0]?.system).toBe('phone')
    expect(patient.telecom[0]?.rank).toBe(1)
    expect(patient.identifier[0]?.value).toBe('12345')
  })

  test('PatientSchema decodes successfully when id is present', () => {
    const result = Schema.decodeSync(PatientSchema)({
      resourceType: 'Patient',
      id: 'pat-001',
      name: JSON.stringify([
        {
          id: null,
          extension: [],
          family: 'Smith',
          given: ['John'],
          use: null,
          text: null,
          prefix: [],
          suffix: [],
          period: null,
        },
      ]),
      active: null,
      address: '[]',
      birthDate: null,
      communication: '[]',
      contact: '[]',
      deceasedBoolean: null,
      deceasedDateTime: null,
      gender: null,
      generalPractitioner: '[]',
      identifier: '[]',
      link: '[]',
      managingOrganization: null,
      maritalStatus: null,
      multipleBirthBoolean: null,
      multipleBirthInteger: null,
      photo: '[]',
      telecom: '[]',
      text: null,
      contained: '[]',
      extension: '[]',
      modifierExtension: '[]',
      meta: null,
      implicitRules: null,
      language: null,
    })

    expect(result.id).toBe('pat-001')
  })

  test('PatientSchema fails when id is missing', () => {
    const payload = { resourceType: 'Patient' }
    const result = Schema.decodeUnknownEither(PatientSchema)(payload)
    expect(Either.isLeft(result)).toBe(true)
  })

  test('commits Patient upsert with boolean active', async () => {
    const store = await createStorePromise({
      adapter: makeAdapter({ storage: { type: 'in-memory' } }),
      schema,
      storeId: `patient-active-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      // LiveStore defaults to LogLevel.Debug in a non-production env, emitting
      // a `LiveStore shutdown complete` line on teardown. Pin to Info to keep
      // genuine warnings/errors visible without the debug noise.
      logLevel: LogLevel.Info,
    })

    try {
      const patient = Schema.decodeSync(PatientSchema)({
        resourceType: 'Patient',
        id: 'pat-active-001',
        active: 1,
        address: '[]',
        birthDate: null,
        communication: '[]',
        contact: '[]',
        deceasedBoolean: null,
        deceasedDateTime: null,
        gender: null,
        generalPractitioner: '[]',
        identifier: '[]',
        link: '[]',
        managingOrganization: null,
        maritalStatus: null,
        multipleBirthBoolean: null,
        multipleBirthInteger: null,
        name: '[]',
        photo: '[]',
        telecom: '[]',
        text: null,
        contained: '[]',
        extension: '[]',
        modifierExtension: '[]',
        meta: null,
        implicitRules: null,
        language: null,
      })

      store.commit(events.patientUpsert({ resource: patient }))
      const persisted = store.query(queries.patientGetById$('pat-active-001'))

      expect(persisted?.id).toBe('pat-active-001')
      expect(persisted?.active).toBe(true)
    } finally {
      await store.shutdownPromise().catch(() => undefined)
    }
  })

  test('property: missing required fields always fail', () => {
    fc.assert(
      fc.property(
        fc.oneof(
          // Wrong resourceType
          fc.record({
            resourceType: fc.constant('Practitioner' as const),
          })
        ),
        (incomplete) => {
          const decode = Schema.decodeUnknownEither(PatientSchema)
          const result = decode(incomplete)
          expect(Either.isLeft(result)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

import {
  FhirResourceSchema,
  MedicationDispense,
  MedicationRequest,
  Observation,
  Patient,
  type FhirResource,
} from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, FastCheck as fc, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import * as PatientIdentity from './patient-identity.ts'

/**
 * The patient-identity steps are pure functions over decoded resources, so
 * they are driven directly: properties over generated Patients and resources,
 * and a household fixture modelled on the Shoppers two-person account
 * (`customer-response-kind.test.ts`) as adoption leaves it.
 */

// Schema-generated resources at fast-check's default size run to hundreds of
// kilobytes each; the properties are about structure, which the smallest size
// still exercises.
beforeAll(() => {
  fc.configureGlobal({ baseSize: 'xsmall' })
})
afterAll(() => {
  fc.resetConfigureGlobal()
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const decodePatient = Schema.decodeUnknownSync(Patient.Schema)
const decodeRequest = Schema.decodeUnknownSync(MedicationRequest.Schema)
const decodeDispense = Schema.decodeUnknownSync(MedicationDispense.Schema)
const encodeResource = Schema.encodeSync(FhirResourceSchema)
const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

/** A resource as its wire JSON text: what "byte-identical" compares. */
const wireOf = (resource: FhirResource): string => JSON.stringify(encodeResource(resource))

/** A person: a stored Patient, so one with an `id`. */
const person = (id: string, identifier: readonly object[] = []): PatientIdentity.Person => ({
  ...decodePatient({ resourceType: 'Patient', id, identifier }),
  id,
})

/** Generated Patients with no `contained` (raw JSON the walk is not about). */
const patientArbitrary = Arbitrary.make(Patient.Schema).map((patient): Patient.Type => ({
  ...patient,
  contained: [],
}))

/** A Patient whose identifiers are a set by `system` + `value`, as a stored person's are. */
const personArbitrary = patientArbitrary.map((patient): PatientIdentity.Person => ({
  ...PatientIdentity.mergeIntoPatient({ ...patient, identifier: [] }, patient),
  id: patient.id ?? 'person',
}))

/** The `system|value` keys of a Patient's identifiers. */
const identifierKeys = (patient: Patient.Type): readonly string[] =>
  patient.identifier.map((identifier) => `${identifier.system?.href ?? ''}|${identifier.value}`)

/** Generated resources of the types that carry references, with no `contained`. */
const resourceArbitrary: fc.Arbitrary<FhirResource> = fc.oneof(
  patientArbitrary,
  Arbitrary.make(Observation.Schema).map((observation): FhirResource => ({
    ...observation,
    contained: [],
  })),
  Arbitrary.make(MedicationRequest.Schema).map((request): FhirResource => ({
    ...request,
    contained: [],
  })),
  Arbitrary.make(MedicationDispense.Schema).map((dispense): FhirResource => ({
    ...dispense,
    contained: [],
  }))
)

/**
 * Every `reference` string the wire form of `resource` carries on a
 * Reference-shaped object — an oracle independent of the decoded-side walk.
 */
const wireReferences = (resource: FhirResource): readonly string[] => {
  const found: string[] = []
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const element of value) visit(element)
    } else if (typeof value === 'object' && value !== null) {
      for (const [key, field] of Object.entries(value)) {
        if (key === 'reference' && typeof field === 'string') found.push(field)
        else visit(field)
      }
    }
  }
  visit(encodeResource(resource))
  return found
}

/** A target reference no generated resource carries. */
const TO: PatientIdentity.PatientReference = 'Patient/wf-merge-target-0000'

// ---------------------------------------------------------------------------
// mergeIntoPatient
// ---------------------------------------------------------------------------

describe('PatientIdentity.mergeIntoPatient', () => {
  it('appends the identifiers the target does not carry, after its own', () => {
    const target = person('p', [{ system: 'https://a.example/id', value: '1' }])
    const source = decodePatient({
      resourceType: 'Patient',
      identifier: [
        { system: 'https://a.example/id', value: '1' },
        { system: 'https://b.example/id', value: '2' },
      ],
    })

    expect(identifierKeys(PatientIdentity.mergeIntoPatient(target, source))).toEqual([
      'https://a.example/id|1',
      'https://b.example/id|2',
    ])
  })

  it('property: is idempotent', () => {
    fc.assert(
      fc.property(personArbitrary, patientArbitrary, (target, source) => {
        const once = PatientIdentity.mergeIntoPatient(target, source)
        expect(wireOf(PatientIdentity.mergeIntoPatient(once, source))).toBe(wireOf(once))
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it('property: keeps the identifiers a set by system + value', () => {
    fc.assert(
      fc.property(personArbitrary, patientArbitrary, (target, source) => {
        const keys = identifierKeys(PatientIdentity.mergeIntoPatient(target, source))
        expect(new Set(keys).size).toBe(keys.length)
        expect(new Set(keys)).toEqual(
          new Set([...identifierKeys(target), ...identifierKeys(source)])
        )
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })

  it("property: leaves the target's demographics byte-identical", () => {
    fc.assert(
      fc.property(personArbitrary, patientArbitrary, (target, source) => {
        const merged = PatientIdentity.mergeIntoPatient(target, source)
        expect(wireOf({ ...merged, identifier: [] })).toBe(wireOf({ ...target, identifier: [] }))
      }),
      { numRuns: numRunsFor({ base: 30 }) }
    )
  })
})

// ---------------------------------------------------------------------------
// rewriteSubjects
// ---------------------------------------------------------------------------

describe('PatientIdentity.rewriteSubjects', () => {
  const FROM: PatientIdentity.PatientReference = 'Patient/wf-merge-source-0000'
  /** The references a generated resource is re-spelled with, so matches are common. */
  const REFERENCE_POOL = [FROM, 'Patient/wf-another-0000', 'Observation/wf-obs-0000'] as const

  /** Generated resources whose every wire `reference` is drawn from {@link REFERENCE_POOL}. */
  const pooledResourceArbitrary = fc
    .tuple(resourceArbitrary, fc.array(fc.constantFrom(...REFERENCE_POOL), { minLength: 1 }))
    .map(([resource, picks]) => {
      let next = 0
      const respell = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(respell)
        if (typeof value !== 'object' || value === null) return value
        return Object.fromEntries(
          Object.entries(value).map(([key, field]) => {
            if (key !== 'reference' || typeof field !== 'string') return [key, respell(field)]
            const pick = picks[next % picks.length]
            next += 1
            return [key, pick]
          })
        )
      }
      return decodeResource(respell(encodeResource(resource)))
    })

  it('property: rewrites exactly the references that match, and counts them', () => {
    fc.assert(
      fc.property(pooledResourceArbitrary, (resource) => {
        const before = wireReferences(resource)

        const { resources, rewrittenCount } = PatientIdentity.rewriteSubjects([resource], FROM, TO)

        const after = resources.flatMap(wireReferences)
        expect(rewrittenCount).toBe(before.filter((reference) => reference === FROM).length)
        expect(after).toEqual(before.map((reference) => (reference === FROM ? TO : reference)))
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('property: rewriting there and back leaves the structure unchanged', () => {
    fc.assert(
      fc.property(pooledResourceArbitrary, (resource) => {
        const there = PatientIdentity.rewriteSubjects([resource], FROM, TO)
        const back = PatientIdentity.rewriteSubjects(there.resources, TO, FROM)

        expect(back.rewrittenCount).toBe(there.rewrittenCount)
        expect(back.resources.map(wireOf)).toEqual([wireOf(resource)])
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('property: a resource with no matching reference comes back as itself', () => {
    fc.assert(
      fc.property(resourceArbitrary, (resource) => {
        const { resources, rewrittenCount } = PatientIdentity.rewriteSubjects([resource], FROM, TO)

        expect(rewrittenCount).toBe(0)
        expect(resources[0]).toBe(resource)
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('keeps the rewritten reference’s identifier and display', () => {
    const dispense = decodeDispense({
      resourceType: 'MedicationDispense',
      status: 'completed',
      subject: {
        reference: 'Patient/src',
        display: 'Ada',
        identifier: { system: 'https://a.example/id', value: '1' },
      },
    })

    const { resources } = PatientIdentity.rewriteSubjects([dispense], 'Patient/src', TO)

    expect(resources[0]?.resourceType === 'MedicationDispense' && resources[0].subject).toEqual({
      ...dispense.subject,
      reference: TO,
    })
  })
})

// ---------------------------------------------------------------------------
// referencesNotRewrittenCount
// ---------------------------------------------------------------------------

describe('PatientIdentity.referencesNotRewrittenCount', () => {
  const sourcePatient = decodePatient({
    resourceType: 'Patient',
    id: 'src',
    identifier: [{ system: 'https://a.example/id', value: '1' }],
  })
  const filedOn = (subject: object): FhirResource =>
    decodeDispense({ resourceType: 'MedicationDispense', status: 'completed', subject })

  it('counts an absolute reference and an identifier-only reference to the source Patient', () => {
    const resources = [
      filedOn({ reference: 'https://fhir.example/Patient/src' }),
      filedOn({ identifier: { system: 'https://a.example/id', value: '1' } }),
    ]

    expect(PatientIdentity.referencesNotRewrittenCount(resources, [sourcePatient])).toBe(2)
  })

  it('does not count a relative reference, another Patient, or another identifier', () => {
    const resources = [
      filedOn({ reference: 'Patient/src' }),
      filedOn({ reference: 'https://fhir.example/Patient/other' }),
      filedOn({ identifier: { system: 'https://a.example/id', value: '2' } }),
    ]

    expect(PatientIdentity.referencesNotRewrittenCount(resources, [sourcePatient])).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// mergeSourcePatients
// ---------------------------------------------------------------------------

describe('PatientIdentity.mergeSourcePatients', () => {
  const rexallPatient = decodePatient({
    resourceType: 'Patient',
    id: 'rexall-ada',
    identifier: [{ system: 'https://rexall.example/sid', value: 'ada' }],
  })
  const shoppersPatient = decodePatient({
    resourceType: 'Patient',
    id: 'shoppers-ada',
    identifier: [{ system: 'https://shoppers.example/sid', value: 'ada' }],
  })
  const dispenseOn = (id: string, reference: string): FhirResource =>
    decodeDispense({
      resourceType: 'MedicationDispense',
      id,
      status: 'completed',
      subject: { reference },
    })
  const subjectsOf = (resources: readonly FhirResource[]): readonly (string | null)[] =>
    resources.flatMap((resource) =>
      resource.resourceType === 'MedicationDispense' ? [resource.subject?.reference ?? null] : []
    )

  it('writes the person once, carrying every merged source’s identifiers, and files everything on it', () => {
    const ada = person('ada', [{ system: 'https://wildflower.example/id', value: 'ada' }])

    const written = PatientIdentity.mergeSourcePatients(
      [dispenseOn('d1', 'Patient/rexall-ada'), dispenseOn('d2', 'Patient/shoppers-ada')],
      [
        { sourcePatient: rexallPatient, person: ada },
        { sourcePatient: shoppersPatient, person: ada },
      ]
    )

    const patients = written.flatMap((resource) =>
      resource.resourceType === 'Patient' ? [resource] : []
    )
    expect(patients.map((patient) => patient.id)).toEqual(['ada'])
    expect(patients.flatMap(identifierKeys)).toEqual([
      'https://wildflower.example/id|ada',
      'https://rexall.example/sid|ada',
      'https://shoppers.example/sid|ada',
    ])
    expect(subjectsOf(written)).toEqual(['Patient/ada', 'Patient/ada'])
  })

  it('folds into the copy the write set already holds rather than writing the person twice', () => {
    const written = PatientIdentity.mergeSourcePatients(
      [rexallPatient, dispenseOn('d2', 'Patient/shoppers-ada')],
      [{ sourcePatient: shoppersPatient, person: { ...rexallPatient, id: 'rexall-ada' } }]
    )

    expect(written.map((resource) => resource.id)).toEqual(['rexall-ada', 'd2'])
    expect(
      identifierKeys(written[0]?.resourceType === 'Patient' ? written[0] : rexallPatient)
    ).toEqual(['https://rexall.example/sid|ada', 'https://shoppers.example/sid|ada'])
    expect(subjectsOf(written)).toEqual(['Patient/rexall-ada'])
  })
})

// ---------------------------------------------------------------------------
// Household accounts — modelled on the Shoppers two-person account
// ---------------------------------------------------------------------------

const PC_ID_SYSTEM = 'https://mypharmacy.shoppersdrugmart.ca/fhir/identifier/pc-id'
const PATIENT_ID_SYSTEM = 'https://mypharmacy.shoppersdrugmart.ca/fhir/identifier/patient-id'
const SID = 'https://wildflowerhealth.io/fhir/sid/shoppers-drugmart'

/** One managed person's demographic Patient, as adoption leaves it. */
const managedPerson = (id: string): Patient.Type =>
  decodePatient({
    resourceType: 'Patient',
    id: `wf-${id}`,
    identifier: [
      { system: SID, value: id },
      { system: PATIENT_ID_SYSTEM, value: id },
    ],
  })

/** The account Patient, keyed by its `pcid`, `link.seealso`-ing each person it manages. */
const account = (managed: readonly Patient.Type[]): Patient.Type =>
  decodePatient({
    resourceType: 'Patient',
    id: 'wf-acct',
    identifier: [
      { system: SID, value: 'acct' },
      { system: PC_ID_SYSTEM, value: 'acct' },
    ],
    link: managed.map((patient) => ({
      other: { reference: `Patient/${patient.id}` },
      type: 'seealso',
    })),
  })

/** A status-feed request, filed on the person it was prescribed for. */
const request = (id: string, patient: Patient.Type): FhirResource =>
  decodeRequest({
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    subject: { reference: `Patient/${patient.id}` },
  })

/** A history-feed fill, filed on the account, linked to the request it fills. */
const historyFill = (id: string, requestId: string): MedicationDispense.Type =>
  decodeDispense({
    resourceType: 'MedicationDispense',
    id,
    status: 'completed',
    subject: { reference: 'Patient/wf-acct', identifier: { system: PC_ID_SYSTEM, value: 'acct' } },
    authorizingPrescription: [{ reference: `MedicationRequest/${requestId}` }],
  })

const dana = managedPerson('pt-uuid-1')
const sam = managedPerson('pt-uuid-2')
const household = account([dana, sam])

const subjectOf = (resources: readonly FhirResource[], id: string): string | null | undefined => {
  const found = resources.find((resource) => resource.id === id)
  return found?.resourceType === 'MedicationDispense' ? found.subject?.reference : undefined
}

describe('PatientIdentity household accounts', () => {
  it('reads an account that links its people as a household account, and one that links nobody as a person', () => {
    expect(PatientIdentity.isHouseholdAccount(household)).toBe(true)
    expect(PatientIdentity.isHouseholdAccount(account([]))).toBe(false)
  })

  it('moves a history dispense whose request is in the import to that request’s subject', () => {
    const imported = [dana, sam, household, request('rx-sam', sam), historyFill('fill', 'rx-sam')]

    const written = PatientIdentity.attributeHouseholdDispenses(imported, imported)

    expect(subjectOf(written, 'fill')).toBe(`Patient/${sam.id}`)
    expect(PatientIdentity.dispensesLeftOnAccountCount(written, imported)).toBe(0)
  })

  it('leaves a dispense whose request is missing on the account, and counts it', () => {
    const imported = [dana, sam, household, historyFill('fill', 'rx-missing')]

    const written = PatientIdentity.attributeHouseholdDispenses(imported, imported)

    expect(subjectOf(written, 'fill')).toBe('Patient/wf-acct')
    expect(PatientIdentity.dispensesLeftOnAccountCount(written, imported)).toBe(1)
  })

  it('attributes from a request the import decoded even when it is not written', () => {
    const imported = [household, request('rx-dana', dana), historyFill('fill', 'rx-dana')]
    const written = [household, historyFill('fill', 'rx-dana')]

    expect(subjectOf(PatientIdentity.attributeHouseholdDispenses(written, imported), 'fill')).toBe(
      `Patient/${dana.id}`
    )
  })

  it('leaves a dispense on an account that links nobody alone: that account is the person', () => {
    const solo = account([])
    const imported = [solo, historyFill('fill', 'rx-missing')]

    const written = PatientIdentity.attributeHouseholdDispenses(imported, imported)

    expect(written).toBe(imported)
    expect(PatientIdentity.dispensesLeftOnAccountCount(written, imported)).toBe(0)
  })

  it('searches no identifier of a household account, and every identifier of an account that links nobody', () => {
    expect(PatientIdentity.searchedIdentifiers(household)).toEqual([])
    expect(
      PatientIdentity.searchedIdentifiers(account([])).map((identifier) => identifier.value)
    ).toEqual(['acct', 'acct'])
  })

  it('merges an account that links nobody like any other source Patient', () => {
    const solo = account([])
    const ada = person('ada')

    const written = PatientIdentity.mergeSourcePatients(
      [historyFill('fill', 'rx-missing')],
      [{ sourcePatient: solo, person: ada }]
    )

    expect(subjectOf(written, 'fill')).toBe('Patient/ada')
    expect(written.find((resource) => resource.id === 'ada')).toMatchObject({
      identifier: solo.identifier,
    })
  })
})

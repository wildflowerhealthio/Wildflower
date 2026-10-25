import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
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
 * and fixtures shaped as adoption leaves a source's Patients.
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

  /** Generated source Patients that {@link FROM} names, with or without identifiers. */
  const sourcePatientArbitrary = patientArbitrary.map((patient): Patient.Type => ({
    ...patient,
    id: 'wf-merge-source-0000',
  }))

  const encodeIdentifier = Schema.encodeSync(IdentifierAndReference.IdentifierSchema)

  /**
   * The wire form of `resource` with the rewrite applied by hand: every
   * Reference-shaped object whose `reference` is {@link FROM} names {@link TO},
   * and carries `sourceIdentifier` when it carried no `identifier`.
   */
  const expectedWireOf = (resource: FhirResource, sourcePatient: Patient.Type): unknown => {
    const [first] = sourcePatient.identifier
    const sourceIdentifier = first === undefined ? undefined : encodeIdentifier(first)
    const rewrite = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(rewrite)
      if (typeof value !== 'object' || value === null) return value
      const fields = Object.fromEntries(
        Object.entries(value).map(([key, field]) => [key, rewrite(field)])
      )
      if (fields['reference'] !== FROM) return fields
      return {
        ...fields,
        reference: TO,
        ...(fields['identifier'] === undefined && sourceIdentifier !== undefined
          ? { identifier: sourceIdentifier }
          : {}),
      }
    }
    return rewrite(encodeResource(resource))
  }

  it('property: changes nothing but the references that match, and counts them', () => {
    fc.assert(
      fc.property(pooledResourceArbitrary, sourcePatientArbitrary, (resource, sourcePatient) => {
        const before = wireReferences(resource)

        const { resources, rewrittenCount } = PatientIdentity.rewriteSubjects(
          [resource],
          sourcePatient,
          TO
        )

        expect(rewrittenCount).toBe(before.filter((reference) => reference === FROM).length)
        expect(resources.map((rewritten) => encodeResource(rewritten))).toEqual([
          expectedWireOf(resource, sourcePatient),
        ])
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('property: a resource with no matching reference comes back as itself', () => {
    fc.assert(
      fc.property(resourceArbitrary, sourcePatientArbitrary, (resource, sourcePatient) => {
        const { resources, rewrittenCount } = PatientIdentity.rewriteSubjects(
          [resource],
          sourcePatient,
          TO
        )

        expect(rewrittenCount).toBe(0)
        expect(resources[0]).toBe(resource)
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  const sourcePatient = decodePatient({
    resourceType: 'Patient',
    id: 'src',
    identifier: [
      { system: 'https://source.example/sid', value: 'src-key' },
      { system: 'https://source.example/other', value: 'other' },
    ],
  })
  const filedOn = (subject: object): MedicationDispense.Type =>
    decodeDispense({ resourceType: 'MedicationDispense', status: 'completed', subject })
  const rewrittenSubjectOf = (
    dispense: MedicationDispense.Type,
    from: Patient.Type
  ): MedicationDispense.Type['subject'] | undefined => {
    const [rewritten] = PatientIdentity.rewriteSubjects([dispense], from, TO).resources
    return rewritten?.resourceType === 'MedicationDispense' ? rewritten.subject : undefined
  }

  it("gives a rewritten reference with no identifier the source Patient's first identifier", () => {
    const dispense = filedOn({ reference: 'Patient/src', display: 'Ada' })

    expect(rewrittenSubjectOf(dispense, sourcePatient)).toEqual({
      ...dispense.subject,
      reference: TO,
      identifier: sourcePatient.identifier[0],
    })
  })

  it('keeps the rewritten reference’s own identifier and display', () => {
    const dispense = filedOn({
      reference: 'Patient/src',
      display: 'Ada',
      identifier: { system: 'https://a.example/id', value: '1' },
    })

    expect(rewrittenSubjectOf(dispense, sourcePatient)).toEqual({
      ...dispense.subject,
      reference: TO,
    })
  })

  it('leaves the identifier null when the source Patient has none', () => {
    const dispense = filedOn({ reference: 'Patient/src' })

    expect(
      rewrittenSubjectOf(dispense, decodePatient({ resourceType: 'Patient', id: 'src' }))
    ).toEqual({ ...dispense.subject, reference: TO, identifier: null })
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
  /** Each dispense's subject as `reference value`, the value its identifier carries. */
  const subjectsOf = (resources: readonly FhirResource[]): readonly string[] =>
    resources.flatMap((resource) =>
      resource.resourceType === 'MedicationDispense'
        ? [`${resource.subject?.reference ?? null} ${resource.subject?.identifier?.value ?? null}`]
        : []
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
    expect(subjectsOf(written)).toEqual(['Patient/ada ada', 'Patient/ada ada'])
    expect(
      written.flatMap((resource) =>
        resource.resourceType === 'MedicationDispense'
          ? [resource.subject?.identifier?.system?.href]
          : []
      )
    ).toEqual(['https://rexall.example/sid', 'https://shoppers.example/sid'])
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
    expect(subjectsOf(written)).toEqual(['Patient/rexall-ada ada'])
  })

  it('keeps what the stored person carries when the write set also holds a copy of it', () => {
    const stored: PatientIdentity.Person = {
      ...rexallPatient,
      id: 'rexall-ada',
      birthDate: decodePatient({ resourceType: 'Patient', birthDate: '1990-01-02' }).birthDate,
      identifier: [
        ...rexallPatient.identifier,
        ...person('x', [{ system: 'https://earlier.example/sid', value: 'ada' }]).identifier,
      ],
    }

    const written = PatientIdentity.mergeSourcePatients(
      [rexallPatient],
      [{ sourcePatient: shoppersPatient, person: stored }]
    )

    const [merged] = written
    expect(written).toHaveLength(1)
    expect(merged?.resourceType === 'Patient' && merged.birthDate).toEqual(stored.birthDate)
    expect(identifierKeys(merged?.resourceType === 'Patient' ? merged : rexallPatient)).toEqual([
      'https://rexall.example/sid|ada',
      'https://earlier.example/sid|ada',
      'https://shoppers.example/sid|ada',
    ])
  })

  it('leaves every resource as itself when a source Patient merges into the stored Patient of the same id', () => {
    const resources = [dispenseOn('d1', 'Patient/rexall-ada')]

    const written = PatientIdentity.mergeSourcePatients(resources, [
      { sourcePatient: rexallPatient, person: { ...rexallPatient, id: 'rexall-ada' } },
    ])

    expect(written[0]).toBe(resources[0])
  })
})

import { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import type {
  FhirResource,
  MedicationDispense,
  Patient,
} from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { FastCheck as fc, Schema } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import * as SubjectRewrite from './subject-rewrite.ts'
import {
  decodeDispense,
  decodePatient,
  decodeResource,
  encodeResource,
  patientArbitrary,
  resourceArbitrary,
  wireReferences,
} from './test-resources.ts'

// Schema-generated resources at fast-check's default size run to hundreds of
// kilobytes each; the properties are about structure, which the smallest size
// still exercises.
beforeAll(() => {
  fc.configureGlobal({ baseSize: 'xsmall' })
})
afterAll(() => {
  fc.resetConfigureGlobal()
})

/** A target reference no generated resource carries. */
const TO: SubjectRewrite.PatientReference = 'Patient/wf-merge-target-0000'

describe('SubjectRewrite.rewrite', () => {
  const FROM: SubjectRewrite.PatientReference = 'Patient/wf-merge-source-0000'
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

        const { resources, rewrittenCount } = SubjectRewrite.rewrite({
          resources: [resource],
          moves: [{ sourcePatient: sourcePatient, to: TO }],
        })

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
        const { resources, rewrittenCount } = SubjectRewrite.rewrite({
          resources: [resource],
          moves: [{ sourcePatient: sourcePatient, to: TO }],
        })

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
    const [rewritten] = SubjectRewrite.rewrite({
      resources: [dispense],
      moves: [{ sourcePatient: from, to: TO }],
    }).resources
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

describe('SubjectRewrite.notRewrittenCount', () => {
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

    expect(
      SubjectRewrite.notRewrittenCount({ resources: resources, sourcePatients: [sourcePatient] })
    ).toBe(2)
  })

  it('does not count a relative reference, another Patient, or another identifier', () => {
    const resources = [
      filedOn({ reference: 'Patient/src' }),
      filedOn({ reference: 'https://fhir.example/Patient/other' }),
      filedOn({ identifier: { system: 'https://a.example/id', value: '2' } }),
    ]

    expect(
      SubjectRewrite.notRewrittenCount({ resources: resources, sourcePatients: [sourcePatient] })
    ).toBe(0)
  })
})

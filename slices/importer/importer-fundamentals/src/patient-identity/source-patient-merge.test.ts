import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { describe, expect, it } from 'vite-plus/test'

import type * as Person from './person.ts'
import * as SourcePatientMerge from './source-patient-merge.ts'
import { decodeDispense, decodePatient, identifierKeys, person } from './test-resources.ts'

describe('SourcePatientMerge.applyTo', () => {
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

    const written = SourcePatientMerge.applyTo({
      resources: [dispenseOn('d1', 'Patient/rexall-ada'), dispenseOn('d2', 'Patient/shoppers-ada')],
      merges: [
        { sourcePatient: rexallPatient, person: ada },
        { sourcePatient: shoppersPatient, person: ada },
      ],
    })

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
    const written = SourcePatientMerge.applyTo({
      resources: [rexallPatient, dispenseOn('d2', 'Patient/shoppers-ada')],
      merges: [{ sourcePatient: shoppersPatient, person: { ...rexallPatient, id: 'rexall-ada' } }],
    })

    expect(written.map((resource) => resource.id)).toEqual(['rexall-ada', 'd2'])
    expect(
      identifierKeys(written[0]?.resourceType === 'Patient' ? written[0] : rexallPatient)
    ).toEqual(['https://rexall.example/sid|ada', 'https://shoppers.example/sid|ada'])
    expect(subjectsOf(written)).toEqual(['Patient/rexall-ada ada'])
  })

  it('keeps what the stored person carries when the write set also holds a copy of it', () => {
    const stored: Person.Type = {
      ...rexallPatient,
      id: 'rexall-ada',
      birthDate: decodePatient({ resourceType: 'Patient', birthDate: '1990-01-02' }).birthDate,
      identifier: [
        ...rexallPatient.identifier,
        ...person('x', [{ system: 'https://earlier.example/sid', value: 'ada' }]).identifier,
      ],
    }

    const written = SourcePatientMerge.applyTo({
      resources: [rexallPatient],
      merges: [{ sourcePatient: shoppersPatient, person: stored }],
    })

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

    const written = SourcePatientMerge.applyTo({
      resources,
      merges: [{ sourcePatient: rexallPatient, person: { ...rexallPatient, id: 'rexall-ada' } }],
    })

    expect(written[0]).toBe(resources[0])
  })
})

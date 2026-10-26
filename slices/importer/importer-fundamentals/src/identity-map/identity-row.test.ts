import { Practitioner, type FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { FastCheck as fc } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import * as DecodedFile from '../decoded-file.ts'
import {
  CUSTOMER,
  SOURCE_PATIENT,
  SOURCE_PRACTITIONER,
  customerSubject,
  fileArbitrary,
  fileOf,
  literalSubject,
  namedRequester,
  observation,
  patient,
  practitioner,
  request,
  wireFieldsOf,
} from './identity-map.test-helpers.ts'
import * as IdentityRow from './identity-row.ts'

// Schema-generated resources at fast-check's default size run to hundreds of
// kilobytes each; the properties are about structure, which the smallest size
// still exercises.
beforeAll(() => {
  fc.configureGlobal({ baseSize: 'xsmall' })
})
afterAll(() => {
  fc.resetConfigureGlobal()
})

/**
 * The row keys a resource's wire form names: its own `identifier[0]` for a
 * Patient or Practitioner, and each `subject`, `requester` and `performer` (or
 * `performer[].actor`) that names a system and value and no literal.
 */
const wireKeys = (resource: FhirResource): readonly string[] => {
  const wire = wireFieldsOf(resource)
  const keyOf = (
    type: string,
    identifier: { readonly system?: string; readonly value?: string } | undefined
  ): readonly string[] =>
    identifier?.system === undefined || identifier.value === undefined || identifier.value === ''
      ? []
      : [`${type}|${new URL(identifier.system).href}|${identifier.value}`]
  const own =
    wire.resourceType === 'Patient' || wire.resourceType === 'Practitioner'
      ? keyOf(wire.resourceType, wire.identifier?.[0])
      : []
  const slots = [
    ...[wire.subject].map((slot) => ['Patient', slot] as const),
    ...[wire.requester, wire.performer ?? []]
      .flat()
      .map(
        (slot) =>
          ['Practitioner', slot !== undefined && 'actor' in slot ? slot.actor : slot] as const
      ),
  ]
  return [
    ...own,
    ...slots.flatMap(([type, reference]) =>
      reference === undefined || reference.reference !== undefined
        ? []
        : keyOf(type, reference.identifier)
    ),
  ]
}

describe('IdentityRow.discover', () => {
  it('finds the Shoppers shapes: a person, the account id and a named prescriber', () => {
    const file = fileOf(
      patient({ id: 'p-1' }),
      request('rx-1', literalSubject('p-1'), namedRequester('Dr. A Smith')),
      request('rx-2', customerSubject('c-9')),
      request('rx-3', customerSubject('c-9'))
    )

    expect(
      IdentityRow.discover(file).map((row) => [row._tag, IdentityRow.key(row), row.label])
    ).toEqual([
      ['resource', `Patient|${SOURCE_PATIENT}|p-1`, 'Tyra Banks · 1990-01-02'],
      [
        'reference',
        `Practitioner|${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`,
        'Dr. A Smith',
      ],
      ['reference', `Patient|${CUSTOMER}|c-9`, 'c-9'],
    ])
  })

  it('gives a resource-backed row its own identifiers and the derived one', () => {
    const [patientRow, practitionerRow] = IdentityRow.discover(
      fileOf(patient({ id: 'p-1' }), practitioner('pr-1', '  Dr.  B   Jones '))
    )

    const systemsAndValues = (row: IdentityRow.Type | undefined): readonly unknown[] =>
      row?._tag === 'resource'
        ? row.identifiers.map((identifier) => [identifier.system?.href, identifier.value])
        : []
    expect(systemsAndValues(patientRow)).toEqual([
      [SOURCE_PATIENT, 'p-1'],
      [
        'https://wildflowerhealth.io/fhir/identifier/patient-name-birth-date',
        'banks;tyra;1990-01-02',
      ],
    ])
    expect(systemsAndValues(practitionerRow)).toEqual([
      [SOURCE_PRACTITIONER, 'pr-1'],
      [Practitioner.NAME_IDENTIFIER_SYSTEM, 'Dr. B Jones'],
    ])
    expect(practitionerRow?.label).toBe('Dr.  B   Jones')
  })

  it('makes no row of a display-only performer, a literal, or a prior prescription number', () => {
    const file = fileOf(
      observation('o-1', literalSubject('p-elsewhere'), [{ display: 'LifeLabs' }]),
      request('rx-1', { reference: 'Patient/p-2' })
    )

    expect(IdentityRow.discover(file)).toEqual([])
  })

  it('makes no row of a Patient with no identifier, and labels a nameless one by its id', () => {
    const rows = IdentityRow.discover(
      fileOf(patient({ id: 'p-1', family: null, birthDate: null }), {
        ...patient({ id: 'p-2' }),
        identifier: [],
      })
    )

    expect(rows.map((row) => row.label)).toEqual(['p-1'])
  })

  it('property: finds every Patient, Practitioner and identifier-only slot, once each, and nothing else', () => {
    fc.assert(
      fc.property(fileArbitrary, (file) => {
        const keys = IdentityRow.discover(file).map(IdentityRow.key)
        const expected = DecodedFile.resources(file).flatMap(({ resource }) => wireKeys(resource))

        expect(new Set(keys).size).toBe(keys.length)
        expect(new Set(keys)).toEqual(new Set(expected))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

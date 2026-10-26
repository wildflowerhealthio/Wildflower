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
import * as Referent from './referent.ts'

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
 * The referent keys a resource's wire form names: its own `identifier[0]` for a
 * Patient or Practitioner, and each `subject`, `requester` and `performer` (or
 * `performer[].actor`) that names a system and value and no literal, typed by
 * its own `type` when it states one.
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
  const mentions = [
    ...[wire.subject].map((reference) => ['Patient', reference] as const),
    ...[wire.requester, wire.performer ?? []]
      .flat()
      .map(
        (performer) =>
          [
            'Practitioner',
            performer !== undefined && 'actor' in performer ? performer.actor : performer,
          ] as const
      ),
  ]
  const typeOf = (fieldType: string, stated: string | undefined): readonly string[] => {
    if (stated === undefined) return [fieldType]
    return stated === 'Patient' || stated === 'Practitioner' ? [stated] : []
  }
  return [
    ...own,
    ...mentions.flatMap(([fieldType, reference]) =>
      reference === undefined || reference.reference !== undefined
        ? []
        : typeOf(fieldType, reference.type).flatMap((type) => keyOf(type, reference.identifier))
    ),
  ]
}

describe('Referent.discover', () => {
  it('finds the Shoppers shapes: a person, the account id and a named prescriber', () => {
    const file = fileOf(
      patient({ id: 'p-1' }),
      request('rx-1', literalSubject('p-1'), namedRequester('Dr. A Smith')),
      request('rx-2', customerSubject('c-9')),
      request('rx-3', customerSubject('c-9'))
    )

    expect(
      Referent.discover(file).map((referent) => [
        referent._tag,
        Referent.key(referent),
        referent.label,
      ])
    ).toEqual([
      ['WithResource', `Patient|${SOURCE_PATIENT}|p-1`, 'Tyra Banks · 1990-01-02'],
      [
        'ByMentionOnly',
        `Practitioner|${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`,
        'Dr. A Smith',
      ],
      ['ByMentionOnly', `Patient|${CUSTOMER}|c-9`, 'c-9'],
    ])
  })

  it('gives a referent with a resource its own identifiers and the derived one', () => {
    const [patientReferent, practitionerReferent] = Referent.discover(
      fileOf(patient({ id: 'p-1' }), practitioner('pr-1', '  Dr.  B   Jones '))
    )

    const systemsAndValues = (referent: Referent.Type | undefined): readonly unknown[] =>
      referent === undefined
        ? []
        : Referent.match(referent, {
            WithResource: ({ identifiers }) =>
              identifiers.map((identifier) => [identifier.system?.href, identifier.value]),
            ByMentionOnly: () => [],
          })
    expect(systemsAndValues(patientReferent)).toEqual([
      [SOURCE_PATIENT, 'p-1'],
      [
        'https://wildflowerhealth.io/fhir/identifier/patient-name-birth-date',
        'banks;tyra;1990-01-02',
      ],
    ])
    expect(systemsAndValues(practitionerReferent)).toEqual([
      [SOURCE_PRACTITIONER, 'pr-1'],
      [Practitioner.NAME_IDENTIFIER_SYSTEM, 'Dr. B Jones'],
    ])
    expect(practitionerReferent?.label).toBe('Dr.  B   Jones')
  })

  it('makes no referent of a display-only performer, an organization, a literal, or a prior prescription number', () => {
    const file = fileOf(
      observation('o-1', literalSubject('p-elsewhere'), [
        { display: 'LifeLabs' },
        { type: 'Organization', identifier: { system: SOURCE_PRACTITIONER, value: 'lab-1' } },
      ]),
      request('rx-1', { reference: 'Patient/p-2' })
    )

    expect(Referent.discover(file)).toEqual([])
  })

  it('makes no referent of a Patient with no identifier, and labels a nameless one by its id', () => {
    const referents = Referent.discover(
      fileOf(patient({ id: 'p-1', family: null, birthDate: null }), {
        ...patient({ id: 'p-2' }),
        identifier: [],
      })
    )

    expect(referents.map((referent) => referent.label)).toEqual(['p-1'])
  })

  it('property: finds every Patient, Practitioner and identifier-only mention, once each, and nothing else', () => {
    fc.assert(
      fc.property(fileArbitrary, (file) => {
        const keys = Referent.discover(file).map(Referent.key)
        const expected = DecodedFile.resources(file).flatMap(({ resource }) => wireKeys(resource))

        expect(new Set(keys).size).toBe(keys.length)
        expect(new Set(keys)).toEqual(new Set(expected))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

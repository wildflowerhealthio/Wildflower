import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, FastCheck as fc } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import type * as DecodedFile from '../decoded-file.ts'
import * as Section from '../section.ts'
import * as SectionedList from '../sectioned-list.ts'
import {
  SOURCE_PATIENT,
  SOURCE_PRACTITIONER,
  customerSubject,
  discoverOnTestClock,
  fileArbitrary,
  fileOf,
  literalSubject,
  namedRequester,
  observation,
  patient,
  practitioner,
  request,
  untypedSubject,
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

/** The key a qualified wire identifier makes to `type`, if it is one. */
const wireKeyOf = (
  type: string,
  identifier: { readonly system?: string; readonly value?: string } | undefined
): readonly string[] =>
  identifier?.system === undefined || identifier.value === undefined || identifier.value === ''
    ? []
    : [JSON.stringify([type, new URL(identifier.system).href, identifier.value])]

/**
 * The referent keys a file's wire form names: each Patient's and
 * Practitioner's own `identifier[0]`, of two copies under one key, the first.
 */
const wireKeysOf = (file: DecodedFile.DecodedFile): readonly string[] => [
  ...new Set(
    SectionedList.rows(file.rows)
      .map(({ resource }) => wireFieldsOf(resource))
      .filter((wire) => wire.resourceType === 'Patient' || wire.resourceType === 'Practitioner')
      .flatMap((wire) => wireKeyOf(wire.resourceType, wire.identifier?.[0]))
  ),
]

describe('Referent.discover', () => {
  it('finds the records of a person and a provider, and no mention', () => {
    const file = fileOf(
      patient({ id: 'p-1' }),
      practitioner('pr-1', 'Dr. A Smith'),
      request('rx-1', literalSubject('p-1'), namedRequester('Dr. B Jones')),
      request('rx-2', customerSubject('c-9'))
    )

    expect(
      discoverOnTestClock(file).map((referent) => [Referent.key(referent), referent.label])
    ).toEqual([
      [JSON.stringify(['Patient', SOURCE_PATIENT, 'p-1']), 'Tyra Banks · 1990-01-02'],
      [JSON.stringify(['Practitioner', SOURCE_PRACTITIONER, 'pr-1']), 'Dr. A Smith'],
    ])
  })

  it('gives a referent its own identifiers and the one its demographics derive', () => {
    const [patientReferent, practitionerReferent] = discoverOnTestClock(
      fileOf(patient({ id: 'p-1' }), practitioner('pr-1', '  Dr.  B   Jones '))
    )

    const systemsAndValues = (referent: Referent.Type | undefined): readonly unknown[] =>
      (referent?.identifiers ?? []).map((identifier) => [identifier.system?.href, identifier.value])
    expect(systemsAndValues(patientReferent)).toEqual([
      [SOURCE_PATIENT, 'p-1'],
      [
        'https://wildflowerhealth.io/fhir/identifier/patient-name-birth-date',
        'banks;tyra;1990-01-02',
      ],
    ])
    expect(systemsAndValues(practitionerReferent)).toEqual([[SOURCE_PRACTITIONER, 'pr-1']])
    expect(practitionerReferent?.label).toBe('Dr.  B   Jones')
  })

  it('makes no referent of a display-only performer, an organization, a literal, an untyped identifier, or a prior prescription number', () => {
    const file = fileOf(
      observation('o-1', literalSubject('p-elsewhere'), [
        { display: 'LifeLabs' },
        { type: 'Organization', identifier: { system: SOURCE_PRACTITIONER, value: 'lab-1' } },
      ]),
      request('rx-1', { reference: 'Patient/p-2' }),
      request('rx-2', untypedSubject('p-3'))
    )

    expect(discoverOnTestClock(file)).toEqual([])
  })

  it('makes no referent of a Patient with no identifier, and labels a nameless one by its id', () => {
    const referents = discoverOnTestClock(
      fileOf(patient({ id: 'p-1', family: null, birthDate: null }), {
        ...patient({ id: 'p-2' }),
        identifier: [],
      })
    )

    expect(referents.map((referent) => referent.label)).toEqual(['p-1'])
  })

  it('takes a record a file decoded over the copy another file set implied under its id', () => {
    const implied = practitioner('pr-1', 'Dr. A Smith')
    const served = { ...practitioner('pr-1', 'Dr. A Smith'), gender: 'female' as const }
    const impliedFile: DecodedFile.DecodedFile = {
      rows: SectionedList.make([
        Section.make('Resources', [
          {
            reviewable: { key: 'k-0', title: 'implied', origin: 'Implied' },
            resource: implied,
          },
        ]),
      ]),
      notes: [],
    }

    const referents = Effect.runSync(Referent.discover([impliedFile, fileOf(served)]))

    expect(referents.map(({ reviewable, resource }) => [reviewable.key, resource])).toEqual([
      ['k-0', served],
    ])
  })

  it('property: finds every keyed Patient and Practitioner, once each, and nothing else', () => {
    fc.assert(
      fc.property(fileArbitrary, (file) => {
        const keys = discoverOnTestClock(file).map(Referent.key)

        expect(new Set(keys).size).toBe(keys.length)
        expect(new Set(keys)).toEqual(new Set(wireKeysOf(file)))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

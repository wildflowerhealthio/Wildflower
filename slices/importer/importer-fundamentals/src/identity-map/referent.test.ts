import { Practitioner } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { FastCheck as fc } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import * as DecodedFile from '../decoded-file.ts'
import {
  CUSTOMER,
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
    : [`${type}|${new URL(identifier.system).href}|${identifier.value}`]

/**
 * The referent keys a file's wire form names: each Patient's and
 * Practitioner's own `identifier[0]`, then each `subject`, `requester` and
 * `performer` (or `performer[].actor`) that is a logical reference (a stated
 * `type`, a system and value, and no literal) unless it is a resource's key or
 * exactly one resource answers to it, by an identifier it carries or, for a
 * Practitioner, by its printed name; of two copies under one key, the first.
 */
const wireKeysOf = (file: DecodedFile.DecodedFile): readonly string[] => {
  const wires = DecodedFile.resources(file).map(({ resource }) => wireFieldsOf(resource))
  const linkable = wires.filter(
    (wire) => wire.resourceType === 'Patient' || wire.resourceType === 'Practitioner'
  )
  const ownKeys = new Set(
    linkable.flatMap((wire) => wireKeyOf(wire.resourceType, wire.identifier?.[0]))
  )
  const answeringByKey = new Map<string, Set<string>>()
  const answeringOwnKeys = new Set<string>()
  for (const wire of linkable) {
    const [own] = wireKeyOf(wire.resourceType, wire.identifier?.[0])
    // A resource decoded twice under one key answers as its first copy.
    if (own === undefined || answeringOwnKeys.has(own)) continue
    answeringOwnKeys.add(own)
    const printedName = wire.resourceType === 'Practitioner' ? wire.name?.[0]?.text : undefined
    const answered = [
      ...(wire.identifier ?? []).flatMap((identifier) => wireKeyOf(wire.resourceType, identifier)),
      ...wireKeyOf('Practitioner', {
        system: printedName === undefined ? undefined : Practitioner.NAME_IDENTIFIER_SYSTEM,
        value: printedName,
      }),
    ]
    for (const key of answered)
      answeringByKey.set(key, (answeringByKey.get(key) ?? new Set()).add(own))
  }
  const typeOf = (stated: string | undefined): readonly string[] =>
    stated === 'Patient' || stated === 'Practitioner' ? [stated] : []
  const mentionKeys = wires
    .flatMap((wire) => [wire.subject, wire.requester, wire.performer ?? []].flat())
    .map((mention) => (mention !== undefined && 'actor' in mention ? mention.actor : mention))
    .flatMap((reference) =>
      reference === undefined || reference.reference !== undefined
        ? []
        : typeOf(reference.type).flatMap((type) => wireKeyOf(type, reference.identifier))
    )
    .filter((key) => !ownKeys.has(key) && answeringByKey.get(key)?.size !== 1)
  return [...ownKeys, ...new Set(mentionKeys)]
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
      discoverOnTestClock(file).map((referent) => [
        referent._tag,
        Referent.key(referent),
        referent.label,
      ])
    ).toEqual([
      ['AsResource', `Patient|${SOURCE_PATIENT}|p-1`, 'Tyra Banks · 1990-01-02'],
      [
        'ByMentionOnly',
        `Practitioner|${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`,
        'Dr. A Smith',
      ],
      ['ByMentionOnly', `Patient|${CUSTOMER}|c-9`, 'c-9'],
    ])
  })

  it('gives a referent with a resource its own identifiers and the derived one', () => {
    const [patientReferent, practitionerReferent] = discoverOnTestClock(
      fileOf(patient({ id: 'p-1' }), practitioner('pr-1', '  Dr.  B   Jones '))
    )

    const systemsAndValues = (referent: Referent.Type | undefined): readonly unknown[] =>
      referent === undefined
        ? []
        : Referent.match(referent, {
            AsResource: ({ identifiers }) =>
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

  it('folds a mention of a provider’s printed name into the one decoded Practitioner of that name', () => {
    const file = fileOf(
      practitioner('pr-1', 'Dr. A Smith'),
      request('rx-1', literalSubject('p-1'), namedRequester('Dr. A Smith')),
      request('rx-2', literalSubject('p-1'), namedRequester('Dr. B Jones'))
    )

    expect(discoverOnTestClock(file).map(Referent.key)).toEqual([
      `Practitioner|${SOURCE_PRACTITIONER}|pr-1`,
      `Practitioner|${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. B Jones`,
    ])
  })

  it('property: finds every Patient, Practitioner and identifier-only mention no one resource answers to, once each, and nothing else', () => {
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

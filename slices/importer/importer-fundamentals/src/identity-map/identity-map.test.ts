import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import { Practitioner, type FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { FastCheck as fc } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import * as DecodedFile from '../decoded-file.ts'
import * as Destination from './destination.ts'
import {
  ABSOLUTE,
  CUSTOMER,
  DEVICE,
  SOURCE_PATIENT,
  STORED,
  STORED_JAN,
  STORED_SMITH,
  STORED_TYRA,
  customerSubject,
  fileArbitrary,
  fileOf,
  fileWireOf,
  literalSubject,
  choicesArbitrary,
  namedRequester,
  observation,
  patient,
  request,
  unrelatedArbitrary,
  wireFieldsOf,
  wireOf,
} from './identity-map.test-helpers.ts'
import * as IdentityMap from './identity-map.ts'
import * as LinkChoice from './link-choice.ts'
import * as Placement from './placement.ts'
import * as Referent from './referent.ts'
import * as Resolution from './resolution.ts'
import type * as UnlinkedMention from './unlinked-mention.ts'

// Schema-generated resources at fast-check's default size run to hundreds of
// kilobytes each; the properties are about structure, which the smallest size
// still exercises.
beforeAll(() => {
  fc.configureGlobal({ baseSize: 'xsmall' })
})
afterAll(() => {
  fc.resetConfigureGlobal()
})

const RUNS = numRunsFor({ base: 50 })

const PERSON = `Patient|${SOURCE_PATIENT}|p-1`
const ACCOUNT = `Patient|${CUSTOMER}|c-9`
const PRESCRIBER = `Practitioner|${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`
const NAME_BIRTH_DATE = 'https://wildflowerhealth.io/fhir/identifier/patient-name-birth-date'

const at = (file: DecodedFile.DecodedFile, key: string): FhirResource | undefined =>
  DecodedFile.resources(file).find((entry) => entry.key === key)?.resource

/** A resource's identifiers as `system|value`. */
const identifiersOf = (resource: FhirResource | undefined): readonly string[] =>
  resource !== undefined && 'identifier' in resource
    ? resource.identifier.map((identifier) => `${identifier.system?.href}|${identifier.value}`)
    : []

/** The path an unlinked mention reports: `subject` for a missing one. */
const pathOf = (unlinked: UnlinkedMention.Type): string =>
  unlinked._tag === 'MissingSubject' ? 'subject' : unlinked.mentionPath

/** A destination as `<tag> <id>`, the id for one with a resource on the device. */
const describeDestination = (destination: Destination.Type): string =>
  Destination.match(destination, {
    OnStoredResource: ({ resource }) => `OnStoredResource ${resource.id}`,
    OnProvisionalResource: ({ resource }) => `OnProvisionalResource ${resource.id}`,
    OnOwnResource: () => 'OnOwnResource',
    Unlinked: () => 'Unlinked',
  })

/** A resource's `subject` and `requester`, as `apply` left them. */
const slotsOf = (
  resource: FhirResource | undefined
): Record<'subject' | 'requester', IdentifierAndReference.ReferenceType | null> => ({
  subject: resource !== undefined && 'subject' in resource ? resource.subject : null,
  requester: resource !== undefined && 'requester' in resource ? resource.requester : null,
})

describe('IdentityMap.apply', () => {
  it('puts a stored person in the source Patient’s place and re-points every reference to it', () => {
    const file = fileOf(
      patient({ id: 'p-1' }),
      request('rx-1', { ...literalSubject('p-1'), display: 'Tyra' }),
      observation('o-1', { identifier: { system: SOURCE_PATIENT, value: 'p-1' } })
    )

    const applied = IdentityMap.apply(
      file,
      new Map([[PERSON, LinkChoice.ToStored({ resource: STORED_TYRA })]])
    )

    expect(applied.sections.map((section) => section.resources.map((entry) => entry.key))).toEqual([
      ['k-0', 'k-1', 'k-2'],
    ])
    expect(at(applied, 'k-0')?.id).toBe('s-1')
    expect(identifiersOf(at(applied, 'k-0'))).toEqual([
      `${DEVICE}|s-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
      `${SOURCE_PATIENT}|p-1`,
    ])
    const { subject } = slotsOf(at(applied, 'k-1'))
    expect([subject?.reference, subject?.display, subject?.identifier?.value]).toEqual([
      'Patient/s-1',
      'Tyra',
      'p-1',
    ])
    expect(slotsOf(at(applied, 'k-2')).subject?.reference).toBe('Patient/s-1')
  })

  it('links an account id to a stored person and writes the person, with the id, in a Linked section', () => {
    const file = fileOf(
      request('rx-1', customerSubject('c-9')),
      request('rx-2', customerSubject('c-9'))
    )

    const applied = IdentityMap.apply(
      file,
      new Map([[ACCOUNT, LinkChoice.ToStored({ resource: STORED_JAN })]])
    )

    expect(slotsOf(at(applied, 'k-0')).subject?.reference).toBe('Patient/s-2')
    expect(slotsOf(at(applied, 'k-1')).subject?.identifier?.value).toBe('c-9')
    expect(applied.sections.map((section) => section.title)).toEqual([
      'Resources',
      Placement.LINKED_SECTION_TITLE,
    ])
    expect(applied.sections[1]?.resources.map((entry) => [entry.key, entry.title])).toEqual([
      ['linked:Patient/s-2', 'Jan Doe'],
    ])
    expect(identifiersOf(at(applied, 'linked:Patient/s-2'))).toEqual([
      `${DEVICE}|s-2`,
      `${CUSTOMER}|c-9`,
    ])
  })

  it('links an account id to the person another referent writes, which assumes the id', () => {
    const file = fileOf(patient({ id: 'p-1' }), request('rx-1', customerSubject('c-9')))

    const applied = IdentityMap.apply(
      file,
      new Map([[ACCOUNT, LinkChoice.SameAs({ referentKey: PERSON })]])
    )

    expect(slotsOf(at(applied, 'k-1')).subject?.reference).toBe('Patient/p-1')
    expect(identifiersOf(at(applied, 'k-0'))).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
      `${CUSTOMER}|c-9`,
    ])
    expect(applied.sections).toHaveLength(1)
  })

  it('writes a new person as it is plus its derived identifier, and leaves unlinked references alone', () => {
    const unlinked = request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith'))
    const file = fileOf(patient({ id: 'p-1' }), unlinked)

    const applied = IdentityMap.apply(file, new Map([[ACCOUNT, LinkChoice.DontLink()]]))

    expect(identifiersOf(at(applied, 'k-0'))).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
    ])
    expect(at(applied, 'k-1')).toBe(unlinked)
  })

  it('re-points a second copy of a linked person, under another id, at the stored person', () => {
    const file = fileOf(
      patient({ id: 'p-1' }),
      { ...patient({ id: 'p-1' }), id: 'p-1-again' },
      request('rx-1', { reference: 'Patient/p-1-again' })
    )

    const applied = IdentityMap.apply(
      file,
      new Map([[PERSON, LinkChoice.ToStored({ resource: STORED_TYRA })]])
    )

    expect([at(applied, 'k-0')?.id, at(applied, 'k-1')?.id]).toEqual(['s-1', 's-1'])
    expect(slotsOf(at(applied, 'k-2')).subject?.reference).toBe('Patient/s-1')
  })

  it('links a named prescriber to a stored practitioner', () => {
    const file = fileOf(request('rx-1', literalSubject('p-1'), namedRequester('Dr. A Smith')))

    const applied = IdentityMap.apply(
      file,
      new Map([[PRESCRIBER, LinkChoice.ToStored({ resource: STORED_SMITH })]])
    )

    const { requester } = slotsOf(at(applied, 'k-0'))
    expect([requester?.reference, requester?.display]).toEqual(['Practitioner/sp-1', 'Dr. A Smith'])
  })
})

describe('IdentityMap.apply on a printed name set to New', () => {
  const PROVISIONAL_ID = localResourceId(
    Practitioner.NAME_IDENTIFIER_SYSTEM,
    'Practitioner',
    'Dr. A Smith'
  )
  const file = fileOf(
    request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith')),
    request('rx-2', customerSubject('c-9'), namedRequester('Dr. A Smith'))
  )
  const map: IdentityMap.Type = new Map<string, LinkChoice.Type>([[PRESCRIBER, LinkChoice.New()]])

  it('creates one provisional Practitioner for the name in the Linked section and points every requester at it', () => {
    const applied = IdentityMap.apply(file, map)

    expect(applied.sections.map((section) => section.title)).toEqual([
      'Resources',
      Placement.LINKED_SECTION_TITLE,
    ])
    expect(applied.sections[1]?.resources.map((entry) => entry.key)).toEqual([
      `linked:Practitioner/${PROVISIONAL_ID}`,
    ])
    const provisional = at(applied, `linked:Practitioner/${PROVISIONAL_ID}`)
    expect(provisional?.resourceType).toBe('Practitioner')
    expect(provisional?.id).toBe(PROVISIONAL_ID)
    expect(identifiersOf(provisional)).toEqual([
      `${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`,
    ])
    expect(
      provisional?.resourceType === 'Practitioner' ? provisional.name.map((name) => name.text) : []
    ).toEqual(['Dr. A Smith'])
    for (const key of ['k-0', 'k-1']) {
      const { requester } = slotsOf(at(applied, key))
      expect([requester?.reference, requester?.display]).toEqual([
        `Practitioner/${PROVISIONAL_ID}`,
        'Dr. A Smith',
      ])
    }
    expect(IdentityMap.unlinkedMentions(file, map).map(pathOf)).toEqual(['subject', 'subject'])
  })

  it('changes nothing when applied again', () => {
    const once = IdentityMap.apply(file, map)

    expect(fileWireOf(IdentityMap.apply(once, map))).toBe(fileWireOf(once))
  })

  it('defaults a name referent to Don’t link, is provisional only for a name, and out of a cycle', () => {
    const jones = `Practitioner|${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. B Jones`
    const referents = Referent.discover(
      fileOf(
        ...file.sections.flatMap((section) => section.resources.map((entry) => entry.resource)),
        request('rx-3', customerSubject('c-9'), namedRequester('Dr. B Jones'))
      )
    )
    const destinationOf = (choices: IdentityMap.Type, key: string): string => {
      const referent = referents.find((candidate) => Referent.key(candidate) === key)
      if (referent === undefined) throw new Error(`no referent ${key}`)
      return describeDestination(
        Resolution.destinationOf(choices, Referent.index(referents), referent)
      )
    }
    const cycle: IdentityMap.Type = new Map<string, LinkChoice.Type>([
      [PRESCRIBER, LinkChoice.SameAs({ referentKey: jones })],
      [jones, LinkChoice.SameAs({ referentKey: PRESCRIBER })],
    ])

    expect(
      referents
        .filter((referent) => Referent.key(referent) === PRESCRIBER)
        .map((referent) => LinkChoice.forReferent(new Map(), referent)._tag)
    ).toEqual(['DontLink'])
    expect(destinationOf(map, PRESCRIBER)).toBe(`OnProvisionalResource ${PROVISIONAL_ID}`)
    expect(destinationOf(new Map([[ACCOUNT, LinkChoice.New()]]), ACCOUNT)).toBe('Unlinked')
    expect(destinationOf(cycle, PRESCRIBER)).toBe(`OnProvisionalResource ${PROVISIONAL_ID}`)
  })
})

describe('Resolution.destinationOf', () => {
  const file = fileOf(
    patient({ id: 'p-1' }),
    request('rx-1', customerSubject('c-1')),
    request('rx-2', customerSubject('c-2')),
    request('rx-3', customerSubject('c-3'))
  )
  const referents = Referent.discover(file)
  const referentOf = (key: string): Referent.Type | undefined =>
    referents.find((referent) => Referent.key(referent) === key)
  const destinationOf = (choices: IdentityMap.Type, key: string): string => {
    const referent = referentOf(key)
    if (referent === undefined) throw new Error(`no referent ${key}`)
    return Resolution.destinationOf(choices, Referent.index(referents), referent)._tag
  }
  const account = (n: number): string => `Patient|${CUSTOMER}|c-${n}`

  it('follows a chain of referents to its end', () => {
    const choices: IdentityMap.Type = new Map<string, LinkChoice.Type>([
      [account(1), LinkChoice.SameAs({ referentKey: account(2) })],
      [account(2), LinkChoice.SameAs({ referentKey: account(3) })],
      [account(3), LinkChoice.SameAs({ referentKey: PERSON })],
    ])

    expect(destinationOf(choices, account(1))).toBe('OnOwnResource')
    expect(
      destinationOf(
        new Map([...choices, [PERSON, LinkChoice.ToStored({ resource: STORED_TYRA })]]),
        account(1)
      )
    ).toBe('OnStoredResource')
  })

  it('reads a cycle, a missing referent and an impossible choice as the referent kind’s default', () => {
    const cycle: IdentityMap.Type = new Map<string, LinkChoice.Type>([
      [account(1), LinkChoice.SameAs({ referentKey: account(2) })],
      [account(2), LinkChoice.SameAs({ referentKey: account(1) })],
      [account(3), LinkChoice.SameAs({ referentKey: 'Patient|https://nowhere.example|x' })],
    ])

    expect(destinationOf(cycle, account(1))).toBe('Unlinked')
    expect(destinationOf(cycle, account(3))).toBe('Unlinked')
    expect(destinationOf(new Map([[account(1), LinkChoice.New()]]), account(1))).toBe('Unlinked')
    expect(
      destinationOf(
        new Map([[account(1), LinkChoice.ToStored({ resource: STORED_SMITH })]]),
        account(1)
      )
    ).toBe('Unlinked')
    expect(destinationOf(new Map([[PERSON, LinkChoice.DontLink()]]), PERSON)).toBe('OnOwnResource')
    expect(
      destinationOf(new Map([[PERSON, LinkChoice.SameAs({ referentKey: account(1) })]]), PERSON)
    ).toBe('OnOwnResource')
    expect(
      destinationOf(new Map([[PERSON, LinkChoice.ToStored({ resource: STORED_SMITH })]]), PERSON)
    ).toBe('OnOwnResource')
  })

  it('reads a referent of another type as unlinked: a subject never lands on a practitioner', () => {
    const withPrescriber = fileOf(
      request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith'))
    )
    const prescriberReferents = Referent.discover(withPrescriber)
    const accountReferent = prescriberReferents.find(
      (referent) => Referent.key(referent) === ACCOUNT
    )
    if (accountReferent === undefined) throw new Error(`no referent ${ACCOUNT}`)
    const choices: IdentityMap.Type = new Map<string, LinkChoice.Type>([
      [ACCOUNT, LinkChoice.SameAs({ referentKey: PRESCRIBER })],
      [PRESCRIBER, LinkChoice.ToStored({ resource: STORED_SMITH })],
    ])

    expect(
      Resolution.destinationOf(choices, Referent.index(prescriberReferents), accountReferent)._tag
    ).toBe('Unlinked')
    expect(slotsOf(at(IdentityMap.apply(withPrescriber, choices), 'k-0')).subject?.reference).toBe(
      null
    )
  })

  it('defaults a referent with a resource to New and one only mentions name to Don’t link', () => {
    expect(LinkChoice.forReferent(new Map(), referentOf(PERSON) ?? referents[0])._tag).toBe('New')
    expect(LinkChoice.forReferent(new Map(), referentOf(account(1)) ?? referents[0])._tag).toBe(
      'DontLink'
    )
  })
})

describe('IdentityMap.unlinkedMentions', () => {
  const file = fileOf(
    observation('o-1'),
    observation('o-2', { reference: ABSOLUTE }),
    request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith')),
    observation('o-3', literalSubject('p-1'), [{ display: 'LifeLabs' }])
  )
  const listed = (choices: IdentityMap.Type): readonly string[] =>
    IdentityMap.unlinkedMentions(file, choices).map(
      (unlinked) => `${unlinked.mentioningResourceKey} ${pathOf(unlinked)}`
    )

  it('lists a missing subject, an absolute URL and every identity the map leaves unlinked', () => {
    expect(listed(new Map())).toEqual([
      'k-0 subject',
      'k-1 subject',
      'k-2 subject',
      'k-2 requester',
    ])
  })

  it('drops what the map links', () => {
    const choices = new Map<string, LinkChoice.Type>([
      [ACCOUNT, LinkChoice.ToStored({ resource: STORED_JAN })],
      [PRESCRIBER, LinkChoice.ToStored({ resource: STORED_SMITH })],
    ])

    expect(listed(choices)).toEqual(['k-0 subject', 'k-1 subject'])
  })
})

describe('IdentityMap properties', () => {
  it('property: applying the same choices again changes nothing', () => {
    fc.assert(
      fc.property(fileArbitrary, choicesArbitrary, (file, map) => {
        const once = IdentityMap.apply(file, map)
        expect(fileWireOf(IdentityMap.apply(once, map))).toBe(fileWireOf(once))
      }),
      { numRuns: RUNS }
    )
  })

  it('property: keeps the file’s sections and keys, adding at most a Linked section', () => {
    fc.assert(
      fc.property(fileArbitrary, choicesArbitrary, (file, map) => {
        const applied = IdentityMap.apply(file, map)
        const shape = (sections: readonly DecodedFile.Section[]): readonly unknown[] =>
          sections.map((section) => [section.title, section.resources.map((entry) => entry.key)])

        expect(shape(applied.sections.slice(0, file.sections.length))).toEqual(shape(file.sections))
        expect(
          applied.sections.slice(file.sections.length).map((section) => section.title)
        ).toEqual(
          applied.sections.length > file.sections.length ? [Placement.LINKED_SECTION_TITLE] : []
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('property: a resource with no reference to a mapped identity comes back as itself', () => {
    fc.assert(
      fc.property(
        fileArbitrary,
        fc.array(unrelatedArbitrary, { maxLength: 3 }),
        choicesArbitrary,
        (file, unrelated, map) => {
          const withUnrelated = {
            ...file,
            sections: [...file.sections, ...fileOf(...unrelated).sections],
          }
          const applied = IdentityMap.apply(withUnrelated, map)

          expect(
            applied.sections[file.sections.length]?.resources.map((entry) => entry.resource)
          ).toEqual(unrelated)
          applied.sections[file.sections.length]?.resources.forEach((entry, index) => {
            expect(entry.resource).toBe(unrelated[index])
          })
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('property: a stored resource keeps its demographics byte for byte, and its identifiers stay a set', () => {
    fc.assert(
      fc.property(fileArbitrary, choicesArbitrary, (file, map) => {
        for (const { resource } of DecodedFile.resources(IdentityMap.apply(file, map))) {
          const stored = STORED.find((candidate) => candidate.id === resource.id)
          const identifiers = identifiersOf(resource)
          expect(new Set(identifiers).size).toBe(identifiers.length)
          if (stored === undefined || !('identifier' in resource)) continue
          expect(wireOf({ ...resource, identifier: [] })).toBe(
            wireOf({ ...stored, identifier: [] })
          )
          expect(identifiers.slice(0, stored.identifier.length)).toEqual(identifiersOf(stored))
        }
      }),
      { numRuns: RUNS }
    )
  })

  it('property: lists a subject exactly when the applied resource names no one by a relative literal', () => {
    fc.assert(
      fc.property(fileArbitrary, choicesArbitrary, (file, map) => {
        const listedSubjects = IdentityMap.unlinkedMentions(file, map)
          .filter((unlinked) => pathOf(unlinked) === 'subject')
          .map((unlinked) => unlinked.mentioningResourceKey)
        const unfiled = DecodedFile.resources(IdentityMap.apply(file, map))
          .filter(({ resource }) => {
            const literal = wireFieldsOf(resource).subject?.reference
            return 'subject' in resource && (literal === undefined || URL.parse(literal) !== null)
          })
          .map((entry) => entry.key)

        expect(listedSubjects).toEqual(unfiled)
      }),
      { numRuns: RUNS }
    )
  })
})

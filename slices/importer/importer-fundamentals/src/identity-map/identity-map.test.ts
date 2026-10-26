import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import { Practitioner, type FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { FastCheck as fc } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import * as DecodedFile from '../decoded-file.ts'
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
  mapArbitrary,
  namedRequester,
  observation,
  patient,
  request,
  unrelatedArbitrary,
  wireFieldsOf,
  wireOf,
} from './identity-map.test-helpers.ts'
import * as IdentityMap from './identity-map.ts'
import * as IdentityRow from './identity-row.ts'
import * as Target from './target.ts'

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

    const applied = IdentityMap.apply(file, new Map([[PERSON, Target.stored(STORED_TYRA)]]))

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

    const applied = IdentityMap.apply(file, new Map([[ACCOUNT, Target.stored(STORED_JAN)]]))

    expect(slotsOf(at(applied, 'k-0')).subject?.reference).toBe('Patient/s-2')
    expect(slotsOf(at(applied, 'k-1')).subject?.identifier?.value).toBe('c-9')
    expect(applied.sections.map((section) => section.title)).toEqual([
      'Resources',
      IdentityMap.LINKED_SECTION_TITLE,
    ])
    expect(applied.sections[1]?.resources.map((entry) => [entry.key, entry.title])).toEqual([
      ['linked:Patient/s-2', 'Jan Doe'],
    ])
    expect(identifiersOf(at(applied, 'linked:Patient/s-2'))).toEqual([
      `${DEVICE}|s-2`,
      `${CUSTOMER}|c-9`,
    ])
  })

  it('links an account id to the person another row writes, which learns the id', () => {
    const file = fileOf(patient({ id: 'p-1' }), request('rx-1', customerSubject('c-9')))

    const applied = IdentityMap.apply(file, new Map([[ACCOUNT, Target.row(PERSON)]]))

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

    const applied = IdentityMap.apply(file, new Map([[ACCOUNT, 'dontLink']]))

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

    const applied = IdentityMap.apply(file, new Map([[PERSON, Target.stored(STORED_TYRA)]]))

    expect([at(applied, 'k-0')?.id, at(applied, 'k-1')?.id]).toEqual(['s-1', 's-1'])
    expect(slotsOf(at(applied, 'k-2')).subject?.reference).toBe('Patient/s-1')
  })

  it('links a named prescriber to a stored practitioner', () => {
    const file = fileOf(request('rx-1', literalSubject('p-1'), namedRequester('Dr. A Smith')))

    const applied = IdentityMap.apply(file, new Map([[PRESCRIBER, Target.stored(STORED_SMITH)]]))

    const { requester } = slotsOf(at(applied, 'k-0'))
    expect([requester?.reference, requester?.display]).toEqual(['Practitioner/sp-1', 'Dr. A Smith'])
  })
})

describe('IdentityMap.apply on a printed name set to new', () => {
  const MINTED_ID = localResourceId(
    Practitioner.NAME_IDENTIFIER_SYSTEM,
    'Practitioner',
    'Dr. A Smith'
  )
  const file = fileOf(
    request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith')),
    request('rx-2', customerSubject('c-9'), namedRequester('Dr. A Smith'))
  )
  const map: IdentityMap.Type = new Map<string, Target.Type>([[PRESCRIBER, 'new']])

  it('mints one Practitioner for the name in the Linked section and points every requester at it', () => {
    const applied = IdentityMap.apply(file, map)

    expect(applied.sections.map((section) => section.title)).toEqual([
      'Resources',
      IdentityMap.LINKED_SECTION_TITLE,
    ])
    expect(applied.sections[1]?.resources.map((entry) => entry.key)).toEqual([
      `linked:Practitioner/${MINTED_ID}`,
    ])
    const minted = at(applied, `linked:Practitioner/${MINTED_ID}`)
    expect(minted?.resourceType).toBe('Practitioner')
    expect(minted?.id).toBe(MINTED_ID)
    expect(identifiersOf(minted)).toEqual([`${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`])
    expect(
      minted?.resourceType === 'Practitioner' ? minted.name.map((name) => name.text) : []
    ).toEqual(['Dr. A Smith'])
    for (const key of ['k-0', 'k-1']) {
      const { requester } = slotsOf(at(applied, key))
      expect([requester?.reference, requester?.display]).toEqual([
        `Practitioner/${MINTED_ID}`,
        'Dr. A Smith',
      ])
    }
    expect(IdentityMap.unresolved(file, map).map((entry) => entry.path)).toEqual([
      'subject',
      'subject',
    ])
  })

  it('changes nothing when applied again', () => {
    const once = IdentityMap.apply(file, map)

    expect(fileWireOf(IdentityMap.apply(once, map))).toBe(fileWireOf(once))
  })

  it('keeps a name row’s default at don’t link, mints only for a name, and mints out of a cycle', () => {
    const jones = `Practitioner|${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. B Jones`
    const rows = IdentityRow.discover(
      fileOf(
        ...file.sections.flatMap((section) => section.resources.map((entry) => entry.resource)),
        request('rx-3', customerSubject('c-9'), namedRequester('Dr. B Jones'))
      )
    )
    const resolved = (targets: IdentityMap.Type, key: string): string => {
      const row = rows.find((candidate) => IdentityRow.key(candidate) === key)
      if (row === undefined) throw new Error(`no row ${key}`)
      const target = IdentityMap.resolve(targets, rows, row)
      return target === 'dontLink'
        ? target
        : `${target._tag} ${target._tag === 'newFromRow' ? '' : target.resource.id}`
    }
    const cycle: IdentityMap.Type = new Map<string, Target.Type>([
      [PRESCRIBER, Target.row(jones)],
      [jones, Target.row(PRESCRIBER)],
    ])

    expect(
      rows
        .filter((row) => IdentityRow.key(row) === PRESCRIBER)
        .map((row) => IdentityMap.targetOf(new Map(), row))
    ).toEqual(['dontLink'])
    expect(resolved(map, PRESCRIBER)).toBe(`minted ${MINTED_ID}`)
    expect(resolved(new Map([[ACCOUNT, 'new']]), ACCOUNT)).toBe('dontLink')
    expect(resolved(cycle, PRESCRIBER)).toBe(`minted ${MINTED_ID}`)
  })
})

describe('IdentityMap.resolve', () => {
  const file = fileOf(
    patient({ id: 'p-1' }),
    request('rx-1', customerSubject('c-1')),
    request('rx-2', customerSubject('c-2')),
    request('rx-3', customerSubject('c-3'))
  )
  const rows = IdentityRow.discover(file)
  const rowOf = (key: string): IdentityRow.Type | undefined =>
    rows.find((row) => IdentityRow.key(row) === key)
  const resolved = (map: IdentityMap.Type, key: string): string => {
    const row = rowOf(key)
    if (row === undefined) throw new Error(`no row ${key}`)
    const target = IdentityMap.resolve(map, rows, row)
    return typeof target === 'string' ? target : target._tag
  }
  const account = (n: number): string => `Patient|${CUSTOMER}|c-${n}`

  it('follows a chain of rows to its end', () => {
    const map: IdentityMap.Type = new Map<string, Target.Type>([
      [account(1), Target.row(account(2))],
      [account(2), Target.row(account(3))],
      [account(3), Target.row(PERSON)],
    ])

    expect(resolved(map, account(1))).toBe('newFromRow')
    expect(resolved(new Map([...map, [PERSON, Target.stored(STORED_TYRA)]]), account(1))).toBe(
      'stored'
    )
  })

  it('reads a cycle, a missing row and an impossible target as the row kind’s fallback', () => {
    const cycle: IdentityMap.Type = new Map<string, Target.Type>([
      [account(1), Target.row(account(2))],
      [account(2), Target.row(account(1))],
      [account(3), Target.row('Patient|https://nowhere.example|x')],
    ])

    expect(resolved(cycle, account(1))).toBe('dontLink')
    expect(resolved(cycle, account(3))).toBe('dontLink')
    expect(resolved(new Map([[account(1), 'new']]), account(1))).toBe('dontLink')
    expect(resolved(new Map([[account(1), Target.stored(STORED_SMITH)]]), account(1))).toBe(
      'dontLink'
    )
    expect(resolved(new Map([[PERSON, 'dontLink']]), PERSON)).toBe('newFromRow')
    expect(resolved(new Map([[PERSON, Target.row(account(1))]]), PERSON)).toBe('newFromRow')
    expect(resolved(new Map([[PERSON, Target.stored(STORED_SMITH)]]), PERSON)).toBe('newFromRow')
  })

  it('reads a row of another type as don’t link: a subject never lands on a practitioner', () => {
    const withPrescriber = fileOf(
      request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith'))
    )
    const prescriberRows = IdentityRow.discover(withPrescriber)
    const accountRow = prescriberRows.find((row) => IdentityRow.key(row) === ACCOUNT)
    if (accountRow === undefined) throw new Error(`no row ${ACCOUNT}`)
    const map: IdentityMap.Type = new Map<string, Target.Type>([
      [ACCOUNT, Target.row(PRESCRIBER)],
      [PRESCRIBER, Target.stored(STORED_SMITH)],
    ])

    expect(IdentityMap.resolve(map, prescriberRows, accountRow)).toBe('dontLink')
    expect(slotsOf(at(IdentityMap.apply(withPrescriber, map), 'k-0')).subject?.reference).toBe(null)
  })

  it('defaults a resource-backed row to new and an id-only row to don’t link', () => {
    expect(IdentityMap.targetOf(new Map(), rowOf(PERSON) ?? rows[0])).toBe('new')
    expect(IdentityMap.targetOf(new Map(), rowOf(account(1)) ?? rows[0])).toBe('dontLink')
  })
})

describe('IdentityMap.unresolved', () => {
  const file = fileOf(
    observation('o-1'),
    observation('o-2', { reference: ABSOLUTE }),
    request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith')),
    observation('o-3', literalSubject('p-1'), [{ display: 'LifeLabs' }])
  )
  const listed = (map: IdentityMap.Type): readonly string[] =>
    IdentityMap.unresolved(file, map).map(({ reviewKey, path }) => `${reviewKey} ${path}`)

  it('lists a missing subject, an absolute URL and every identity the map leaves unlinked', () => {
    expect(listed(new Map())).toEqual([
      'k-0 subject',
      'k-1 subject',
      'k-2 subject',
      'k-2 requester',
    ])
  })

  it('drops what the map links', () => {
    const map = new Map<string, Target.Type>([
      [ACCOUNT, Target.stored(STORED_JAN)],
      [PRESCRIBER, Target.stored(STORED_SMITH)],
    ])

    expect(listed(map)).toEqual(['k-0 subject', 'k-1 subject'])
  })
})

describe('IdentityMap properties', () => {
  it('property: applying the same map again changes nothing', () => {
    fc.assert(
      fc.property(fileArbitrary, mapArbitrary, (file, map) => {
        const once = IdentityMap.apply(file, map)
        expect(fileWireOf(IdentityMap.apply(once, map))).toBe(fileWireOf(once))
      }),
      { numRuns: RUNS }
    )
  })

  it('property: keeps the file’s sections and keys, adding at most a Linked section', () => {
    fc.assert(
      fc.property(fileArbitrary, mapArbitrary, (file, map) => {
        const applied = IdentityMap.apply(file, map)
        const shape = (sections: readonly DecodedFile.Section[]): readonly unknown[] =>
          sections.map((section) => [section.title, section.resources.map((entry) => entry.key)])

        expect(shape(applied.sections.slice(0, file.sections.length))).toEqual(shape(file.sections))
        expect(
          applied.sections.slice(file.sections.length).map((section) => section.title)
        ).toEqual(
          applied.sections.length > file.sections.length ? [IdentityMap.LINKED_SECTION_TITLE] : []
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
        mapArbitrary,
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
      fc.property(fileArbitrary, mapArbitrary, (file, map) => {
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
      fc.property(fileArbitrary, mapArbitrary, (file, map) => {
        const listedSubjects = IdentityMap.unresolved(file, map)
          .filter((entry) => entry.path === 'subject')
          .map((entry) => entry.reviewKey)
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

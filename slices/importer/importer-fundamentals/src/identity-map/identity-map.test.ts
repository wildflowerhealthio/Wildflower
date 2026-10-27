import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import { Patient, Practitioner, type FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import {
  Array,
  DateTime,
  Effect,
  Either,
  FastCheck as fc,
  HashMap,
  Option,
  Schema,
  TestClock,
  TestContext,
} from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import {
  DecodedFile,
  IdentityMap,
  LinkChoice,
  LinkTarget,
  Placement,
  Referent,
  type ReferentLinkChoices,
  UnlinkedMention,
} from '../index.ts'
import {
  ABSOLUTE,
  CUSTOMER,
  DEVICE,
  SOURCE_PATIENT,
  SOURCE_PRACTITIONER,
  STORED,
  STORED_JAN,
  STORED_SMITH,
  STORED_TYRA,
  anyChoicesArbitrary,
  applyAcrossOnTestClock,
  applyOnTestClock,
  customerSubject,
  discoverOnTestClock,
  fileOf,
  fileWireOf,
  fileWithChoicesArbitrary,
  fileWithReapplicableChoicesArbitrary,
  literalSubject,
  namedRequester,
  observation,
  patient,
  request,
  runOnTestClock,
  storedOf,
  unrelatedArbitrary,
  untypedSubject,
  wireFieldsOf,
  wireOf,
} from './identity-map.test-helpers.ts'
import * as Resolution from './resolution.ts'

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

/** The resource keyed `key` in `file`; throws when there is none. */
const resourceAt = (file: DecodedFile.DecodedFile, key: string): FhirResource => {
  const resource = at(file, key)
  if (resource === undefined) throw new Error(`no resource keyed ${key}`)
  return resource
}

/** A decoded Patient keyed `p-<id>` that also carries the account id `c-9`. */
const patientWithAccount = (id: string): FhirResource =>
  Schema.decodeUnknownSync(Patient.Schema)({
    resourceType: 'Patient',
    id,
    identifier: [
      { system: SOURCE_PATIENT, value: id },
      { system: CUSTOMER, value: 'c-9' },
    ],
    name: [{ family: 'Banks', given: ['Tyra'] }],
    birthDate: '1990-01-02',
  })

/** A resource's identifiers as `system|value`. */
const identifiersOf = (resource: FhirResource | undefined): readonly string[] =>
  resource !== undefined && 'identifier' in resource
    ? resource.identifier.map((identifier) => `${identifier.system?.href}|${identifier.value}`)
    : []

/** The path an unlinked mention reports: `subject` for a resource outside every patient's compartment. */
const pathOf = (unlinked: UnlinkedMention.Type): string =>
  UnlinkedMention.match(unlinked, {
    OutsidePatientCompartment: () => 'subject',
    Dangling: ({ mentionPath }) => mentionPath,
  })

/** A link target as `<tag> <id>`, the id for one with a resource on the device. */
const describeLinkTarget = (destination: LinkTarget.Type): string =>
  LinkTarget.match(destination, {
    Stored: ({ resource }) => `Stored ${resource.id}`,
    Provisional: ({ resource }) => `Provisional ${resource.id}`,
    Decoded: () => 'Decoded',
    Unlinked: () => 'Unlinked',
  })

/**
 * The link target `choices` resolve the referent keyed `referentKey` of
 * `referents` to, described; or why resolving fails.
 */
const resolvedFor = (
  choices: ReferentLinkChoices.Type,
  referents: readonly Referent.Type[],
  referentKey: string
): string =>
  Either.match(Resolution.linksOf(choices, referents), {
    onLeft: ({ referentKey: invalidKey, reason }) => `Invalid ${invalidKey} ${reason}`,
    onRight: (links) => {
      const link = links.find(({ referent }) => Referent.key(referent) === referentKey)
      return link === undefined ? `no referent ${referentKey}` : describeLinkTarget(link.target)
    },
  })

/** How `IdentityMap.apply` fails on `files` under `choices`, as the failure's tag and fields. */
const failureAcrossOf = (
  files: Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile>,
  choices: ReferentLinkChoices.Type
): Either.Either<
  readonly DecodedFile.DecodedFile[],
  Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice
> => runOnTestClock(Effect.either(IdentityMap.apply(files, choices)))

/** How `IdentityMap.apply` fails on a batch of one `file` under `choices`. */
const failureOf = (
  file: DecodedFile.DecodedFile,
  choices: ReferentLinkChoices.Type
): Either.Either<
  readonly DecodedFile.DecodedFile[],
  Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice
> => failureAcrossOf(Array.of(file), choices)

/** A resource's `subject` and `requester` references, as `apply` left them. */
const subjectAndRequesterOf = (
  resource: FhirResource | undefined
): Record<'subject' | 'requester', IdentifierAndReference.ReferenceType | null> => ({
  subject: resource !== undefined && 'subject' in resource ? resource.subject : null,
  requester: resource !== undefined && 'requester' in resource ? resource.requester : null,
})

describe('IdentityMap.apply on one file', () => {
  it('puts a stored person in the source Patient’s place and redirects every typed mention of it', () => {
    const file = fileOf(
      patient({ id: 'p-1' }),
      request('rx-1', { ...literalSubject('p-1'), display: 'Tyra' }),
      observation('o-1', { type: 'Patient', identifier: { system: SOURCE_PATIENT, value: 'p-1' } }),
      observation('o-2', untypedSubject('p-1'))
    )

    const applied = applyOnTestClock(
      file,
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })])
    )

    expect(applied.sections.map((section) => section.resources.map((entry) => entry.key))).toEqual([
      ['k-0', 'k-1', 'k-2', 'k-3'],
    ])
    expect(at(applied, 'k-0')?.id).toBe('s-1')
    expect(identifiersOf(at(applied, 'k-0'))).toEqual([
      `${DEVICE}|s-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
      `${SOURCE_PATIENT}|p-1`,
    ])
    const { subject } = subjectAndRequesterOf(at(applied, 'k-1'))
    expect([subject?.reference, subject?.display, subject?.identifier?.value]).toEqual([
      'Patient/s-1',
      'Tyra',
      'p-1',
    ])
    expect(subjectAndRequesterOf(at(applied, 'k-2')).subject?.reference).toBe('Patient/s-1')
    expect(subjectAndRequesterOf(at(applied, 'k-3')).subject?.reference).toBe(null)
  })

  it('links an account id to a stored person and writes the person, with the id, in a Linked section', () => {
    const file = fileOf(
      request('rx-1', customerSubject('c-9')),
      request('rx-2', customerSubject('c-9'))
    )

    const applied = applyOnTestClock(
      file,
      HashMap.make([ACCOUNT, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })])
    )

    expect(subjectAndRequesterOf(at(applied, 'k-0')).subject?.reference).toBe('Patient/s-2')
    expect(subjectAndRequesterOf(at(applied, 'k-1')).subject?.identifier?.value).toBe('c-9')
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

    const applied = applyOnTestClock(
      file,
      HashMap.make([ACCOUNT, LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })])
    )

    expect(subjectAndRequesterOf(at(applied, 'k-1')).subject?.reference).toBe('Patient/p-1')
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

    const applied = applyOnTestClock(file, HashMap.make([ACCOUNT, LinkChoice.DontLink()]))

    expect(identifiersOf(at(applied, 'k-0'))).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
    ])
    expect(at(applied, 'k-1')).toBe(unlinked)
  })

  it('refuses a file with one person decoded twice under two ids, naming both review keys', () => {
    const file = fileOf(
      patient({ id: 'p-1' }),
      { ...patient({ id: 'p-1' }), id: 'p-1-again' },
      request('rx-1', { reference: 'Patient/p-1-again' })
    )

    for (const choices of [
      HashMap.empty<string, LinkChoice.Type>(),
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })]),
    ]) {
      expect(failureOf(file, choices)).toMatchObject({
        _tag: 'Left',
        left: {
          _tag: 'DuplicateReferent',
          logicalReference: { type: 'Patient', identifier: { value: 'p-1' } },
          reviewKeys: ['k-0', 'k-1'],
        },
      })
    }
  })

  it('reads one person decoded twice under one id as one referent', () => {
    const file = fileOf(patient({ id: 'p-1' }), patient({ id: 'p-1' }))

    const applied = applyOnTestClock(
      file,
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })])
    )

    expect([at(applied, 'k-0')?.id, at(applied, 'k-1')?.id]).toEqual(['s-1', 's-1'])
  })

  it('names a stored person standing in for a decoded one by its own label, and keeps every other title', () => {
    const file = fileOf(
      { ...patient({ id: 'p-1', family: 'Bnaks' }) },
      patient({ id: 'p-2', value: 'p-2', family: 'Doe', given: 'Jan' }),
      request('rx-1', literalSubject('p-1'))
    )

    const applied = applyOnTestClock(
      file,
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })])
    )

    expect(DecodedFile.resources(applied).map(({ key, title }) => [key, title])).toEqual([
      ['k-0', 'Tyra Banks · 1990-01-02'],
      ['k-1', 'Patient/p-2'],
      ['k-2', 'MedicationRequest/rx-1'],
    ])
  })

  it('redirects a mention by any identifier a decoded person carries, not only its first', () => {
    const file = fileOf(patientWithAccount('p-1'), request('rx-1', customerSubject('c-9')))

    expect(discoverOnTestClock(file).map(Referent.key)).toEqual([PERSON])
    const applied = applyOnTestClock(file, HashMap.empty())
    expect(subjectAndRequesterOf(at(applied, 'k-1')).subject?.reference).toBe('Patient/p-1')
    expect(UnlinkedMention.collect(applied)).toEqual([])
  })

  it('reads a mention two decoded people answer to, by neither one’s key, as a referent of its own', () => {
    const file = fileOf(
      patientWithAccount('p-1'),
      patientWithAccount('p-2'),
      request('rx-1', customerSubject('c-9'))
    )

    expect(discoverOnTestClock(file).map(Referent.key)).toEqual([
      PERSON,
      `Patient|${SOURCE_PATIENT}|p-2`,
      ACCOUNT,
    ])
    expect(
      subjectAndRequesterOf(at(applyOnTestClock(file, HashMap.empty()), 'k-2')).subject?.reference
    ).toBe(null)
  })

  it('folds a printed name into the decoded Practitioner it names, so a provisional one never stands in for it', () => {
    const PROVISIONAL_ID = localResourceId(
      Practitioner.NAME_IDENTIFIER_SYSTEM,
      'Practitioner',
      'Dr. A Smith'
    )
    const decodedSmith = Schema.decodeUnknownSync(Practitioner.Schema)({
      resourceType: 'Practitioner',
      id: PROVISIONAL_ID,
      identifier: [
        { system: SOURCE_PRACTITIONER, value: 'pr-1' },
        { system: Practitioner.NAME_IDENTIFIER_SYSTEM, value: 'Dr. A Smith' },
      ],
      name: [{ text: 'Dr. A Smith' }],
      qualification: [{ code: { text: 'MD' } }],
    })
    const file = fileOf(
      decodedSmith,
      request('rx-1', literalSubject('p-1'), namedRequester('Dr. A Smith'))
    )

    expect(discoverOnTestClock(file).map(Referent.key)).toEqual([
      `Practitioner|${SOURCE_PRACTITIONER}|pr-1`,
    ])
    const applied = applyOnTestClock(file, HashMap.empty())
    expect(at(applied, 'k-0')).toBe(decodedSmith)
    expect(subjectAndRequesterOf(at(applied, 'k-1')).requester?.reference).toBe(
      `Practitioner/${PROVISIONAL_ID}`
    )
  })

  it('links a named prescriber to a stored practitioner', () => {
    const file = fileOf(request('rx-1', literalSubject('p-1'), namedRequester('Dr. A Smith')))

    const applied = applyOnTestClock(
      file,
      HashMap.make([PRESCRIBER, LinkChoice.LinkToStoredResource({ resource: STORED_SMITH })])
    )

    const { requester } = subjectAndRequesterOf(at(applied, 'k-0'))
    expect([requester?.reference, requester?.display]).toEqual(['Practitioner/sp-1', 'Dr. A Smith'])
  })
})

describe('IdentityMap.apply on a re-import', () => {
  // The first import writes the person, who assumes the two account ids mentions link to them.
  const firstImport = applyOnTestClock(
    fileOf(
      patient({ id: 'p-1' }),
      request('rx-1', customerSubject('c-9')),
      request('rx-0', customerSubject('c-8'))
    ),
    HashMap.make(
      [ACCOUNT, LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })],
      [`Patient|${CUSTOMER}|c-8`, LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })]
    )
  )
  const storedCopy = storedOf(resourceAt(firstImport, 'k-0'))
  // The same person decoded again, with what the source says of them now, and only one account mentioned.
  const decodedAgain = Schema.decodeUnknownSync(Patient.Schema)({
    resourceType: 'Patient',
    id: 'p-1',
    meta: { source: 'https://source.example/visit-2' },
    identifier: [{ system: SOURCE_PATIENT, value: 'p-1' }],
    name: [{ family: 'Banks', given: ['Tyra'] }],
    telecom: [{ system: 'phone', value: '555-0100' }],
    birthDate: '1990-01-02',
  })
  const reimport = fileOf(decodedAgain, request('rx-2', customerSubject('c-9')))
  // What `ReferentSearch.defaultChoices` gives: both searches find the stored copy.
  const defaultChoices: ReferentLinkChoices.Type = HashMap.make(
    [PERSON, LinkChoice.UpdateStoredResource({ resource: storedCopy })],
    [ACCOUNT, LinkChoice.LinkToStoredResource({ resource: storedCopy })]
  )

  it('lands the person decoded and the account on the stored copy, under one literal reference', () => {
    const referents = discoverOnTestClock(reimport)

    expect(identifiersOf(storedCopy)).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
      `${CUSTOMER}|c-9`,
      `${CUSTOMER}|c-8`,
    ])
    expect(resolvedFor(defaultChoices, referents, PERSON)).toBe('Decoded')
    expect(resolvedFor(defaultChoices, referents, ACCOUNT)).toBe('Stored p-1')
  })

  it('writes the new decode, not the stored copy, having assumed every identifier the stored copy carries', () => {
    const placed = applyOnTestClock(reimport, defaultChoices)

    expect(wireOf(resourceAt(placed, 'k-0'))).toBe(
      wireOf({ ...decodedAgain, identifier: storedCopy.identifier })
    )
    expect(subjectAndRequesterOf(at(placed, 'k-1')).subject?.reference).toBe('Patient/p-1')
    expect(placed.sections.map((section) => section.title)).toEqual(['Resources'])
  })

  it('keeps what the stored copy assumed when the re-import mentions none of it', () => {
    const placed = applyOnTestClock(
      fileOf(decodedAgain),
      HashMap.make([PERSON, LinkChoice.UpdateStoredResource({ resource: storedCopy })])
    )

    expect(wireOf(resourceAt(placed, 'k-0'))).toBe(
      wireOf({ ...decodedAgain, identifier: storedCopy.identifier })
    )
  })

  it('writes the decode as new, without what the copy assumed, when the reviewer chooses New', () => {
    const placed = applyOnTestClock(
      fileOf(decodedAgain),
      HashMap.make([PERSON, LinkChoice.CreateResource()])
    )

    expect(identifiersOf(resourceAt(placed, 'k-0'))).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
    ])
  })

  it('writes the stored copy when the reviewer links the person to it too', () => {
    const placed = applyOnTestClock(
      reimport,
      HashMap.set(defaultChoices, PERSON, LinkChoice.LinkToStoredResource({ resource: storedCopy }))
    )

    expect(wireOf(resourceAt(placed, 'k-0'))).toBe(wireOf(storedCopy))
  })

  it('appends the stored copy a mention links to when the decode moves to another stored record', () => {
    const placed = applyOnTestClock(
      reimport,
      HashMap.make(
        [PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })],
        [ACCOUNT, LinkChoice.LinkToStoredResource({ resource: storedCopy })]
      )
    )

    expect(resourceAt(placed, 'k-0').id).toBe('s-1')
    expect(placed.sections.map((section) => section.title)).toEqual([
      'Resources',
      Placement.LINKED_SECTION_TITLE,
    ])
    expect(wireOf(resourceAt(placed, 'linked:Patient/p-1'))).toBe(wireOf(storedCopy))
    expect(subjectAndRequesterOf(at(placed, 'k-1')).subject?.reference).toBe('Patient/p-1')
  })

  it('refuses to update a stored resource under another id, or for a referent named only by mentions', () => {
    const referents = discoverOnTestClock(reimport)
    const invalid = (referentKey: string, choice: LinkChoice.Type): string =>
      resolvedFor(HashMap.make([referentKey, choice]), referents, referentKey)

    expect(invalid(PERSON, LinkChoice.UpdateStoredResource({ resource: STORED_TYRA }))).toBe(
      `Invalid ${PERSON} StoredResourceUnderAnotherId`
    )
    expect(invalid(ACCOUNT, LinkChoice.UpdateStoredResource({ resource: storedCopy }))).toBe(
      `Invalid ${ACCOUNT} NotAllowedForReferent`
    )
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
  const map: ReferentLinkChoices.Type = HashMap.make([PRESCRIBER, LinkChoice.CreateResource()])

  it('changes nothing when applied again', () => {
    const once = applyOnTestClock(file, map)

    expect(fileWireOf(applyOnTestClock(once, map))).toBe(fileWireOf(once))
  })

  it('creates one provisional Practitioner for the name in the Linked section and points every requester at it', () => {
    const applied = applyOnTestClock(file, map)

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
      const { requester } = subjectAndRequesterOf(at(applied, key))
      expect([requester?.reference, requester?.display]).toEqual([
        `Practitioner/${PROVISIONAL_ID}`,
        'Dr. A Smith',
      ])
    }
    expect(UnlinkedMention.collect(applyOnTestClock(file, map)).map(pathOf)).toEqual([
      'subject',
      'subject',
    ])
  })

  it('defaults a name referent to Don’t link, refuses New for anything but a name, and makes one record for a whole cycle', () => {
    const jones = `Practitioner|${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. B Jones`
    const referents = discoverOnTestClock(
      fileOf(
        ...file.sections.flatMap((section) => section.resources.map((entry) => entry.resource)),
        request('rx-3', customerSubject('c-9'), namedRequester('Dr. B Jones'))
      )
    )
    const cycle: ReferentLinkChoices.Type = HashMap.make(
      [PRESCRIBER, LinkChoice.LinkToDecodedReferent({ referentKey: jones })],
      [jones, LinkChoice.LinkToDecodedReferent({ referentKey: PRESCRIBER })]
    )

    expect(
      referents
        .filter((referent) => Referent.key(referent) === PRESCRIBER)
        .map((referent) => LinkChoice.forReferent(HashMap.empty(), referent)._tag)
    ).toEqual(['DontLink'])
    expect(resolvedFor(map, referents, PRESCRIBER)).toBe(`Provisional ${PROVISIONAL_ID}`)
    expect(
      resolvedFor(HashMap.make([ACCOUNT, LinkChoice.CreateResource()]), referents, ACCOUNT)
    ).toBe(`Invalid ${ACCOUNT} NotAllowedForReferent`)
    expect(resolvedFor(cycle, referents, PRESCRIBER)).toBe(`Provisional ${PROVISIONAL_ID}`)
    expect(resolvedFor(cycle, referents, jones)).toBe(`Provisional ${PROVISIONAL_ID}`)
  })
})

describe('Resolution.linksOf', () => {
  const file = fileOf(
    patient({ id: 'p-1' }),
    request('rx-1', customerSubject('c-1')),
    request('rx-2', customerSubject('c-2')),
    request('rx-3', customerSubject('c-3'))
  )
  const referents = discoverOnTestClock(file)
  const account = (n: number): string => `Patient|${CUSTOMER}|c-${n}`

  it('follows a chain of referents to its end', () => {
    const choices: ReferentLinkChoices.Type = HashMap.make(
      [account(1), LinkChoice.LinkToDecodedReferent({ referentKey: account(2) })],
      [account(2), LinkChoice.LinkToDecodedReferent({ referentKey: account(3) })],
      [account(3), LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })]
    )

    expect(resolvedFor(choices, referents, account(1))).toBe('Decoded')
    expect(
      resolvedFor(
        HashMap.set(choices, PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })),
        referents,
        account(1)
      )
    ).toBe('Stored s-1')
  })

  it('reads a cycle with nothing to create as unlinked', () => {
    const cycle: ReferentLinkChoices.Type = HashMap.make(
      [account(1), LinkChoice.LinkToDecodedReferent({ referentKey: account(2) })],
      [account(2), LinkChoice.LinkToDecodedReferent({ referentKey: account(1) })],
      [account(3), LinkChoice.LinkToDecodedReferent({ referentKey: account(1) })]
    )

    expect(resolvedFor(cycle, referents, account(1))).toBe('Unlinked')
    expect(resolvedFor(cycle, referents, account(3))).toBe('Unlinked')
  })

  it('fails on a choice it cannot follow, naming the referent and why', () => {
    const invalid = (referentKey: string, choice: LinkChoice.Type): string =>
      resolvedFor(HashMap.make([referentKey, choice]), referents, referentKey)

    expect(invalid(account(1), LinkChoice.CreateResource())).toBe(
      `Invalid ${account(1)} NotAllowedForReferent`
    )
    expect(invalid(PERSON, LinkChoice.DontLink())).toBe(`Invalid ${PERSON} NotAllowedForReferent`)
    expect(invalid(PERSON, LinkChoice.LinkToDecodedReferent({ referentKey: account(1) }))).toBe(
      `Invalid ${PERSON} NotAllowedForReferent`
    )
    expect(invalid(account(1), LinkChoice.LinkToStoredResource({ resource: STORED_SMITH }))).toBe(
      `Invalid ${account(1)} StoredResourceOfAnotherType`
    )
    expect(invalid(PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_SMITH }))).toBe(
      `Invalid ${PERSON} StoredResourceOfAnotherType`
    )
    expect(
      invalid(
        account(1),
        LinkChoice.LinkToDecodedReferent({ referentKey: 'Patient|https://nowhere.example/|x' })
      )
    ).toBe(`Invalid ${account(1)} LinkedReferentNotInBatch`)
  })

  it('fails on a link to a referent of another type: a subject never lands on a practitioner', () => {
    const withPrescriber = fileOf(
      request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith'))
    )
    const choices: ReferentLinkChoices.Type = HashMap.make(
      [ACCOUNT, LinkChoice.LinkToDecodedReferent({ referentKey: PRESCRIBER })],
      [PRESCRIBER, LinkChoice.LinkToStoredResource({ resource: STORED_SMITH })]
    )

    expect(resolvedFor(choices, discoverOnTestClock(withPrescriber), ACCOUNT)).toBe(
      `Invalid ${ACCOUNT} LinkedReferentOfAnotherType`
    )
    expect(failureOf(withPrescriber, choices)).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'InvalidLinkChoice', referentKey: ACCOUNT },
    })
  })

  it('fails a choice that leads to one it cannot follow', () => {
    const choices: ReferentLinkChoices.Type = HashMap.make(
      [account(1), LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })],
      [PERSON, LinkChoice.DontLink()]
    )

    expect(resolvedFor(choices, referents, account(1))).toBe(
      `Invalid ${PERSON} NotAllowedForReferent`
    )
  })

  it('defaults a referent with a resource to New and one named only by mentions to Don’t link', () => {
    const defaultsByKey = referents.map((referent) => [
      Referent.key(referent),
      LinkChoice.forReferent(HashMap.empty(), referent)._tag,
    ])

    expect(defaultsByKey).toEqual([
      [PERSON, 'CreateResource'],
      [account(1), 'DontLink'],
      [account(2), 'DontLink'],
      [account(3), 'DontLink'],
    ])
    expect(resolvedFor(HashMap.empty(), referents, PERSON)).toBe('Decoded')
  })
})

describe('UnlinkedMention.collect on a placed file', () => {
  const file = fileOf(
    observation('o-1'),
    observation('o-2', { reference: ABSOLUTE }),
    request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith')),
    observation('o-3', literalSubject('p-1'), [{ display: 'LifeLabs' }]),
    observation('o-4', { display: 'Tyra' }),
    observation('o-5', untypedSubject('p-1')),
    observation('o-6', literalSubject('p-1'), [{ reference: ABSOLUTE }]),
    observation('o-7', { reference: '#p-1' }),
    observation('o-8', { reference: 'Patient p-1' })
  )
  const listed = (choices: ReferentLinkChoices.Type): readonly string[] =>
    UnlinkedMention.collect(applyOnTestClock(file, choices)).map(
      (unlinked) => `${unlinked._tag} ${unlinked.mentioningResourceKey} ${pathOf(unlinked)}`
    )

  it('lists a resource outside every patient compartment and every logical reference the map leaves unlinked, and no absolute URL', () => {
    expect(listed(HashMap.empty())).toEqual([
      'OutsidePatientCompartment k-0 subject',
      'OutsidePatientCompartment k-1 subject',
      'Dangling k-2 subject',
      'Dangling k-2 requester',
      'OutsidePatientCompartment k-4 subject',
      'OutsidePatientCompartment k-5 subject',
      'OutsidePatientCompartment k-7 subject',
      'OutsidePatientCompartment k-8 subject',
    ])
  })

  it('drops what the map links', () => {
    const choices = HashMap.make(
      [ACCOUNT, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })],
      [PRESCRIBER, LinkChoice.LinkToStoredResource({ resource: STORED_SMITH })]
    )

    expect(listed(choices)).toEqual([
      'OutsidePatientCompartment k-0 subject',
      'OutsidePatientCompartment k-1 subject',
      'OutsidePatientCompartment k-4 subject',
      'OutsidePatientCompartment k-5 subject',
      'OutsidePatientCompartment k-7 subject',
      'OutsidePatientCompartment k-8 subject',
    ])
  })
})

describe('IdentityMap.apply across files', () => {
  /** How many resources of `files` are written under `literalReference`. */
  const countWrittenAt = (
    files: readonly DecodedFile.DecodedFile[],
    literalReference: string
  ): number =>
    files
      .flatMap(DecodedFile.resources)
      .filter(({ resource }) => `${resource.resourceType}/${resource.id}` === literalReference)
      .length

  /** The resource keyed `key` in the file at `index` of `files`. */
  const atFile = (
    files: readonly DecodedFile.DecodedFile[],
    index: number,
    key: string
  ): FhirResource | undefined =>
    Array.get(files, index).pipe(
      Option.flatMapNullable((file) => at(file, key)),
      Option.getOrUndefined
    )

  it('links a mention in one file to the person another file holds, which assumes its id', () => {
    const placed = applyAcrossOnTestClock(
      Array.make(fileOf(patient({ id: 'p-1' })), fileOf(request('rx-1', customerSubject('c-9')))),
      HashMap.make([ACCOUNT, LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })])
    )

    expect(subjectAndRequesterOf(atFile(placed, 1, 'k-0')).subject?.reference).toBe('Patient/p-1')
    expect(identifiersOf(atFile(placed, 0, 'k-0'))).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
      `${CUSTOMER}|c-9`,
    ])
  })

  it('reads a person one file decodes and another only mentions as one referent, with the resource', () => {
    const referents = runOnTestClock(
      Referent.discover([
        fileOf(
          observation('o-1', {
            type: 'Patient',
            identifier: { system: SOURCE_PATIENT, value: 'p-1' },
          })
        ),
        fileOf(patient({ id: 'p-1' }), request('rx-1', customerSubject('c-9'))),
        fileOf(request('rx-2', customerSubject('c-9'))),
      ])
    )

    expect(referents.map((referent) => [referent._tag, Referent.key(referent)])).toEqual([
      ['AsResource', PERSON],
      ['ByMentionOnly', ACCOUNT],
    ])
  })

  it('writes a stored person two files only mention once, in the first file’s Linked section', () => {
    const otherAccount = `Patient|${CUSTOMER}|c-8`

    const placed = applyAcrossOnTestClock(
      Array.make(
        fileOf(request('rx-1', customerSubject('c-9'))),
        fileOf(request('rx-2', customerSubject('c-8')))
      ),
      HashMap.make(
        [ACCOUNT, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })],
        [otherAccount, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })]
      )
    )

    expect(placed.map((file) => file.sections.map((section) => section.title))).toEqual([
      ['Resources', Placement.LINKED_SECTION_TITLE],
      ['Resources'],
    ])
    expect(countWrittenAt(placed, 'Patient/s-2')).toBe(1)
    expect(identifiersOf(atFile(placed, 0, 'linked:Patient/s-2'))).toEqual([
      `${DEVICE}|s-2`,
      `${CUSTOMER}|c-9`,
      `${CUSTOMER}|c-8`,
    ])
    expect(placed.map((file) => subjectAndRequesterOf(at(file, 'k-0')).subject?.reference)).toEqual(
      ['Patient/s-2', 'Patient/s-2']
    )
  })

  it('appends no Linked copy of a stored person another file holds, whose copy assumes the ids', () => {
    const placed = applyAcrossOnTestClock(
      Array.make(fileOf(request('rx-1', customerSubject('c-9'))), fileOf(STORED_JAN)),
      HashMap.make([ACCOUNT, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })])
    )

    expect(placed.map((file) => file.sections.length)).toEqual([1, 1])
    expect(countWrittenAt(placed, 'Patient/s-2')).toBe(1)
    expect(identifiersOf(atFile(placed, 1, 'k-0'))).toEqual([`${DEVICE}|s-2`, `${CUSTOMER}|c-9`])
  })

  it('refuses a batch with one person decoded under two ids in two files', () => {
    expect(
      failureAcrossOf(
        Array.make(
          fileOf(patient({ id: 'p-1' })),
          fileOf({ ...patient({ id: 'p-1' }), id: 'p-1-again' })
        ),
        HashMap.empty()
      )
    ).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'DuplicateReferent', reviewKeys: ['k-0', 'k-0'] },
    })
  })

  /** `file`'s two sections as a batch of two files of one section each. */
  const splitIntoFiles = (
    file: DecodedFile.DecodedFile
  ): Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile> =>
    Array.match(file.sections, {
      onEmpty: () => Array.of(file),
      onNonEmpty: (sections) =>
        Array.map(sections, (section) => ({ ...file, sections: [section] })),
    })

  it('property: placing a file’s sections as separate files is placing the file, the Linked section moved to the first', () => {
    fc.assert(
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
        const placedTogether = applyOnTestClock(file, choices)
        const placedApart = applyAcrossOnTestClock(splitIntoFiles(file), choices)
        const isLinked = (section: DecodedFile.Section): boolean =>
          section.title === Placement.LINKED_SECTION_TITLE

        const [firstApart, ...restApart] = placedApart
        expect(
          fileWireOf({
            ...file,
            sections: [
              ...firstApart.sections.filter((section) => !isLinked(section)),
              ...restApart.flatMap((placedFile) => placedFile.sections),
              ...firstApart.sections.filter(isLinked),
            ],
          })
        ).toBe(fileWireOf(placedTogether))
      }),
      { numRuns: RUNS }
    )
  })

  it('property: applying the same choices across the files again changes nothing, when the placed files have the decoded files’ referents', () => {
    fc.assert(
      fc.property(fileWithReapplicableChoicesArbitrary, ({ file, choices }) => {
        const once = applyAcrossOnTestClock(splitIntoFiles(file), choices)
        expect(applyAcrossOnTestClock(once, choices).map(fileWireOf)).toEqual(once.map(fileWireOf))
      }),
      { numRuns: RUNS }
    )
  })
})

describe('IdentityMap properties', () => {
  it('property: applying the same choices again changes nothing, when the placed file has the decoded file’s referents', () => {
    fc.assert(
      fc.property(fileWithReapplicableChoicesArbitrary, ({ file, choices }) => {
        const once = applyOnTestClock(file, choices)
        expect(fileWireOf(applyOnTestClock(once, choices))).toBe(fileWireOf(once))
      }),
      { numRuns: RUNS }
    )
  })

  it('property: places one decoded file under one set of choices the same way every time', () => {
    fc.assert(
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
        expect(fileWireOf(applyOnTestClock(file, choices))).toBe(
          fileWireOf(applyOnTestClock(file, choices))
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('property: keeps the file’s sections and keys, adding at most a Linked section', () => {
    fc.assert(
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
        const applied = applyOnTestClock(file, choices)
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
        fileWithChoicesArbitrary,
        fc.array(unrelatedArbitrary, { maxLength: 3 }),
        ({ file, choices }, unrelated) => {
          const withUnrelated = {
            ...file,
            sections: [...file.sections, ...fileOf(...unrelated).sections],
          }
          const applied = applyOnTestClock(withUnrelated, choices)

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
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
        for (const { resource } of DecodedFile.resources(applyOnTestClock(file, choices))) {
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
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
        const applied = applyOnTestClock(file, choices)
        const listedSubjects = UnlinkedMention.collect(applied)
          .filter((unlinked) => pathOf(unlinked) === 'subject')
          .map((unlinked) => unlinked.mentioningResourceKey)
        // The generated literals are `Patient/<id>` or an absolute URL into another system.
        const unlinkedSubjects = DecodedFile.resources(applied)
          .filter(({ resource }) => {
            const literal = wireFieldsOf(resource).subject?.reference
            return 'subject' in resource && literal?.startsWith('Patient/') !== true
          })
          .map((entry) => entry.key)

        expect(listedSubjects).toEqual(unlinkedSubjects)
      }),
      { numRuns: RUNS }
    )
  })

  it('property: succeeds on any choices, or fails naming a referent a choice was made for', () => {
    fc.assert(
      fc.property(fileWithChoicesArbitrary, anyChoicesArbitrary, ({ file }, choices) => {
        Either.match(failureOf(file, choices), {
          onRight: () => undefined,
          onLeft: (failure) => {
            expect(failure._tag).toBe('InvalidLinkChoice')
            if (failure._tag === 'InvalidLinkChoice') {
              expect(HashMap.has(choices, failure.referentKey)).toBe(true)
            }
          },
        })
      }),
      { numRuns: RUNS }
    )
  })
})

describe('IdentityMap.apply and the clock', () => {
  // A provider whose official name ended on 2026-10-31 and who goes by another since.
  const renamed = Schema.decodeUnknownSync(Practitioner.Schema)({
    resourceType: 'Practitioner',
    id: 'pr-1',
    identifier: [{ system: SOURCE_PRACTITIONER, value: 'pr-1' }],
    name: [
      { use: 'official', text: 'Dr. A Smith', period: { end: '2026-10-31' } },
      { text: 'Dr. A Jones' },
    ],
  })
  // Setting the test clock runs asynchronously, so these place the file through a promise.
  const appliedAt = (instant: string): Promise<DecodedFile.DecodedFile> =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.unsafeMake(instant).epochMillis)
        return Array.headNonEmpty(
          yield* IdentityMap.apply(Array.of(fileOf(renamed)), HashMap.empty())
        )
      }).pipe(Effect.provide(TestContext.TestContext))
    )

  it('derives a provider’s name identifier from the name current at the clock’s now', async () => {
    expect(identifiersOf(at(await appliedAt('2026-10-30T12:00:00Z'), 'k-0'))).toEqual([
      `${SOURCE_PRACTITIONER}|pr-1`,
      `${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`,
    ])
    expect(identifiersOf(at(await appliedAt('2026-11-02T12:00:00Z'), 'k-0'))).toEqual([
      `${SOURCE_PRACTITIONER}|pr-1`,
      `${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Jones`,
    ])
  })

  it('places a file the same way twice at one instant', async () => {
    expect(fileWireOf(await appliedAt('2026-11-02T12:00:00Z'))).toBe(
      fileWireOf(await appliedAt('2026-11-02T12:00:00Z'))
    )
  })
})

import {
  type IdentifierAndReference,
  withMandatoryId,
} from '@wildflowerhealthio/fhir-r4/data-types'
import { localResourceId } from '@wildflowerhealthio/fhir-r4/identity'
import {
  Patient,
  Practitioner,
  type FhirResource,
  type FhirResourceWithId,
} from '@wildflowerhealthio/fhir-r4/resources'
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
  FileResolution,
  Link,
  LinkChoice,
  LinkPlan,
  LinkTarget,
  MentionLinkChoiceSet,
  Referent,
  ReferentLinkChoiceSet,
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
  resolveAcrossOnTestClock,
  resolveOnTestClock,
  customerSubject,
  discoverOnTestClock,
  fileOf,
  fileWireOf,
  fileWithChoicesArbitrary,
  fileWithReapplicableChoicesArbitrary,
  linkedRecordsOnTestClock,
  literalSubject,
  resolveAcross,
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
  leftByReferentLinksOnTestClock,
} from './identity-map.test-helpers.ts'

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

const at = (file: DecodedFile.DecodedFile, key: string): FhirResourceWithId | undefined =>
  DecodedFile.resources(file).find((entry) => entry.key === key)?.resource

/** The resource keyed `key` in `file`; throws when there is none. */
const resourceAt = (file: DecodedFile.DecodedFile, key: string): FhirResourceWithId => {
  const resource = at(file, key)
  if (resource === undefined) throw new Error(`no resource keyed ${key}`)
  return resource
}

/** The linked record keyed `key`; throws when there is none. */
const linkedAt = (linked: readonly DecodedFile.Resource[], key: string): FhirResourceWithId => {
  const entry = linked.find((candidate) => candidate.key === key)
  if (entry === undefined) throw new Error(`no linked record keyed ${key}`)
  return entry.resource
}

/** A decoded Patient keyed `p-<id>` that also carries the account id `c-9`. */
const patientWithAccount = (id: string): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
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
 * The link target `choices` give the referent keyed `referentKey` of
 * `referents`, described; or why making the links fails.
 */
const linkTargetFor = (
  choices: ReferentLinkChoiceSet.Type,
  referents: readonly Referent.Type[],
  referentKey: string
): string =>
  Either.match(Link.fromChoices(referents, choices), {
    onLeft: ({ referentKey: invalidKey, reason }) => `Invalid ${invalidKey} ${reason}`,
    onRight: (links) => {
      const link = links.find(({ referent }) => Referent.key(referent) === referentKey)
      return link === undefined ? `no referent ${referentKey}` : describeLinkTarget(link.target)
    },
  })

/** How resolving `files` on `choices` fails, as the failure's tag and fields. */
const failureAcrossOf = (
  files: Array.NonEmptyReadonlyArray<DecodedFile.DecodedFile>,
  choices: ReferentLinkChoiceSet.Type
): Either.Either<
  Effect.Effect.Success<ReturnType<typeof resolveAcross>>,
  Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice
> => runOnTestClock(Effect.either(resolveAcross(files, choices)))

/** How resolving a batch of one `file` on `choices` fails. */
const failureOf = (
  file: DecodedFile.DecodedFile,
  choices: ReferentLinkChoiceSet.Type
): Either.Either<
  Effect.Effect.Success<ReturnType<typeof resolveAcross>>,
  Referent.DuplicateReferent | LinkChoice.InvalidLinkChoice
> => failureAcrossOf(Array.of(file), choices)

/** A resource's `subject` and `requester` references, as the identity map left them. */
const subjectAndRequesterOf = (
  resource: FhirResource | undefined
): Record<'subject' | 'requester', IdentifierAndReference.ReferenceType | null> => ({
  subject: resource !== undefined && 'subject' in resource ? resource.subject : null,
  requester: resource !== undefined && 'requester' in resource ? resource.requester : null,
})

describe('the identity map on one file', () => {
  it('puts a stored person in the source Patient’s place and redirects every typed mention of it', () => {
    const file = fileOf(
      patient({ id: 'p-1' }),
      request('rx-1', { ...literalSubject('p-1'), display: 'Tyra' }),
      observation('o-1', { type: 'Patient', identifier: { system: SOURCE_PATIENT, value: 'p-1' } }),
      observation('o-2', untypedSubject('p-1'))
    )

    const resolved = resolveOnTestClock(
      file,
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })])
    )

    expect(resolved.sections.map((section) => section.resources.map((entry) => entry.key))).toEqual(
      [['k-0', 'k-1', 'k-2', 'k-3']]
    )
    expect(at(resolved, 'k-0')?.id).toBe('s-1')
    expect(identifiersOf(at(resolved, 'k-0'))).toEqual([
      `${DEVICE}|s-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
      `${SOURCE_PATIENT}|p-1`,
    ])
    const { subject } = subjectAndRequesterOf(at(resolved, 'k-1'))
    expect([subject?.reference, subject?.display, subject?.identifier?.value]).toEqual([
      'Patient/s-1',
      'Tyra',
      'p-1',
    ])
    expect(subjectAndRequesterOf(at(resolved, 'k-2')).subject?.reference).toBe('Patient/s-1')
    expect(subjectAndRequesterOf(at(resolved, 'k-3')).subject?.reference).toBe(null)
  })

  it('links an account id to a stored person and writes the person, with the id, among the linked records', () => {
    const file = fileOf(
      request('rx-1', customerSubject('c-9')),
      request('rx-2', customerSubject('c-9'))
    )
    const choices = HashMap.make([
      ACCOUNT,
      LinkChoice.LinkToStoredResource({ resource: STORED_JAN }),
    ])

    const resolved = resolveOnTestClock(file, choices)
    const linked = linkedRecordsOnTestClock(file, choices)

    expect(subjectAndRequesterOf(at(resolved, 'k-0')).subject?.reference).toBe('Patient/s-2')
    expect(subjectAndRequesterOf(at(resolved, 'k-1')).subject?.identifier?.value).toBe('c-9')
    expect(resolved.sections.map((section) => section.title)).toEqual(['Resources'])
    expect(linked.map((entry) => [entry.key, entry.title, entry.origin])).toEqual([
      ['linked:Patient/s-2', 'Jan Doe', 'Stored'],
    ])
    expect(identifiersOf(linkedAt(linked, 'linked:Patient/s-2'))).toEqual([
      `${DEVICE}|s-2`,
      `${CUSTOMER}|c-9`,
    ])
  })

  it('links an account id to the person another referent writes, which assumes the id', () => {
    const file = fileOf(patient({ id: 'p-1' }), request('rx-1', customerSubject('c-9')))

    const resolved = resolveOnTestClock(
      file,
      HashMap.make([ACCOUNT, LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })])
    )

    expect(subjectAndRequesterOf(at(resolved, 'k-1')).subject?.reference).toBe('Patient/p-1')
    expect(identifiersOf(at(resolved, 'k-0'))).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
      `${CUSTOMER}|c-9`,
    ])
    expect(resolved.sections).toHaveLength(1)
  })

  it('writes a new person as it is plus its derived identifier, and leaves unlinked references alone', () => {
    const unlinked = request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith'))
    const file = fileOf(patient({ id: 'p-1' }), unlinked)

    const resolved = resolveOnTestClock(file, HashMap.make([ACCOUNT, LinkChoice.DontLink()]))

    expect(identifiersOf(at(resolved, 'k-0'))).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
    ])
    expect(at(resolved, 'k-1')).toBe(unlinked)
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

    const resolved = resolveOnTestClock(
      file,
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })])
    )

    expect([at(resolved, 'k-0')?.id, at(resolved, 'k-1')?.id]).toEqual(['s-1', 's-1'])
  })

  it('names a stored person standing in for a decoded one by its own label, and keeps every other title', () => {
    const file = fileOf(
      { ...patient({ id: 'p-1', family: 'Bnaks' }) },
      patient({ id: 'p-2', value: 'p-2', family: 'Doe', given: 'Jan' }),
      request('rx-1', literalSubject('p-1'))
    )

    const resolved = resolveOnTestClock(
      file,
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })])
    )

    expect(DecodedFile.resources(resolved).map(({ key, title }) => [key, title])).toEqual([
      ['k-0', 'Tyra Banks · 1990-01-02'],
      ['k-1', 'Patient/p-2'],
      ['k-2', 'MedicationRequest/rx-1'],
    ])
  })

  it('redirects a mention by any identifier a decoded person carries, not only its first', () => {
    const file = fileOf(patientWithAccount('p-1'), request('rx-1', customerSubject('c-9')))

    expect(discoverOnTestClock(file).map(Referent.key)).toEqual([PERSON])
    const resolved = resolveOnTestClock(file, HashMap.empty())
    expect(subjectAndRequesterOf(at(resolved, 'k-1')).subject?.reference).toBe('Patient/p-1')
    expect(leftByReferentLinksOnTestClock(file, HashMap.empty())).toEqual([])
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
      subjectAndRequesterOf(at(resolveOnTestClock(file, HashMap.empty()), 'k-2')).subject?.reference
    ).toBe(null)
  })

  it('folds a printed name into the decoded Practitioner it names, so a provisional one never stands in for it', () => {
    const PROVISIONAL_ID = localResourceId(
      Practitioner.NAME_IDENTIFIER_SYSTEM,
      'Practitioner',
      'Dr. A Smith'
    )
    const decodedSmith = Schema.decodeUnknownSync(withMandatoryId(Practitioner.Schema))({
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
    const resolved = resolveOnTestClock(file, HashMap.empty())
    expect(at(resolved, 'k-0')).toBe(decodedSmith)
    expect(subjectAndRequesterOf(at(resolved, 'k-1')).requester?.reference).toBe(
      `Practitioner/${PROVISIONAL_ID}`
    )
  })

  it('links a named prescriber to a stored practitioner', () => {
    const file = fileOf(request('rx-1', literalSubject('p-1'), namedRequester('Dr. A Smith')))

    const resolved = resolveOnTestClock(
      file,
      HashMap.make([PRESCRIBER, LinkChoice.LinkToStoredResource({ resource: STORED_SMITH })])
    )

    const { requester } = subjectAndRequesterOf(at(resolved, 'k-0'))
    expect([requester?.reference, requester?.display]).toEqual(['Practitioner/sp-1', 'Dr. A Smith'])
  })
})

describe('the identity map on a re-import', () => {
  // The first import writes the person, who assumes the two account ids mentions link to them.
  const firstImport = resolveOnTestClock(
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
  const decodedAgain = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
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
  const defaultChoices: ReferentLinkChoiceSet.Type = HashMap.make(
    [PERSON, LinkChoice.UpdateStoredResource({ resource: storedCopy })],
    [ACCOUNT, LinkChoice.LinkToStoredResource({ resource: storedCopy })]
  )

  it('redirects the person decoded and the account to the stored copy, under one literal reference', () => {
    const referents = discoverOnTestClock(reimport)

    expect(identifiersOf(storedCopy)).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
      `${CUSTOMER}|c-9`,
      `${CUSTOMER}|c-8`,
    ])
    expect(linkTargetFor(defaultChoices, referents, PERSON)).toBe('Decoded')
    expect(linkTargetFor(defaultChoices, referents, ACCOUNT)).toBe('Stored p-1')
  })

  it('writes the new decode, not the stored copy, having assumed every identifier the stored copy carries', () => {
    const resolved = resolveOnTestClock(reimport, defaultChoices)

    expect(wireOf(resourceAt(resolved, 'k-0'))).toBe(
      wireOf({ ...decodedAgain, identifier: storedCopy.identifier })
    )
    expect(subjectAndRequesterOf(at(resolved, 'k-1')).subject?.reference).toBe('Patient/p-1')
    expect(resolved.sections.map((section) => section.title)).toEqual(['Resources'])
  })

  it('keeps what the stored copy assumed when the re-import mentions none of it', () => {
    const resolved = resolveOnTestClock(
      fileOf(decodedAgain),
      HashMap.make([PERSON, LinkChoice.UpdateStoredResource({ resource: storedCopy })])
    )

    expect(wireOf(resourceAt(resolved, 'k-0'))).toBe(
      wireOf({ ...decodedAgain, identifier: storedCopy.identifier })
    )
  })

  it('writes the decode as new, without what the copy assumed, when the reviewer chooses New', () => {
    const resolved = resolveOnTestClock(
      fileOf(decodedAgain),
      HashMap.make([PERSON, LinkChoice.CreateResource()])
    )

    expect(identifiersOf(resourceAt(resolved, 'k-0'))).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
    ])
  })

  it('writes the stored copy when the reviewer links the person to it too', () => {
    const resolved = resolveOnTestClock(
      reimport,
      HashMap.set(defaultChoices, PERSON, LinkChoice.LinkToStoredResource({ resource: storedCopy }))
    )

    expect(wireOf(resourceAt(resolved, 'k-0'))).toBe(wireOf(storedCopy))
  })

  it('links the stored copy a mention links to as a linked record when the decode moves to another stored record', () => {
    const choices = HashMap.make(
      [PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })],
      [ACCOUNT, LinkChoice.LinkToStoredResource({ resource: storedCopy })]
    )

    const resolved = resolveOnTestClock(reimport, choices)
    const linked = linkedRecordsOnTestClock(reimport, choices)

    expect(resourceAt(resolved, 'k-0').id).toBe('s-1')
    expect(resolved.sections.map((section) => section.title)).toEqual(['Resources'])
    expect(linked.map((entry) => entry.key)).toEqual(['linked:Patient/p-1'])
    expect(wireOf(linkedAt(linked, 'linked:Patient/p-1'))).toBe(wireOf(storedCopy))
    expect(subjectAndRequesterOf(at(resolved, 'k-1')).subject?.reference).toBe('Patient/p-1')
  })

  it('refuses to update a stored resource under another id, or for a referent named only by mentions', () => {
    const referents = discoverOnTestClock(reimport)
    const invalid = (referentKey: string, choice: LinkChoice.Type): string =>
      linkTargetFor(HashMap.make([referentKey, choice]), referents, referentKey)

    expect(invalid(PERSON, LinkChoice.UpdateStoredResource({ resource: STORED_TYRA }))).toBe(
      `Invalid ${PERSON} StoredResourceUnderAnotherId`
    )
    expect(invalid(ACCOUNT, LinkChoice.UpdateStoredResource({ resource: storedCopy }))).toBe(
      `Invalid ${ACCOUNT} NotAllowedForReferent`
    )
  })
})

describe('the identity map on a printed name set to New', () => {
  const PROVISIONAL_ID = localResourceId(
    Practitioner.NAME_IDENTIFIER_SYSTEM,
    'Practitioner',
    'Dr. A Smith'
  )
  const file = fileOf(
    request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith')),
    request('rx-2', customerSubject('c-9'), namedRequester('Dr. A Smith'))
  )
  const map: ReferentLinkChoiceSet.Type = HashMap.make([PRESCRIBER, LinkChoice.CreateResource()])

  it('changes nothing when resolved again', () => {
    const once = resolveOnTestClock(file, map)

    expect(fileWireOf(resolveOnTestClock(once, map))).toBe(fileWireOf(once))
  })

  it('creates one provisional Practitioner for the name among the linked records and points every requester at it', () => {
    const resolved = resolveOnTestClock(file, map)
    const linked = linkedRecordsOnTestClock(file, map)

    expect(resolved.sections.map((section) => section.title)).toEqual(['Resources'])
    expect(linked.map((entry) => [entry.key, entry.origin])).toEqual([
      [`linked:Practitioner/${PROVISIONAL_ID}`, 'Provisional'],
    ])
    const provisional = linkedAt(linked, `linked:Practitioner/${PROVISIONAL_ID}`)
    expect(provisional.resourceType).toBe('Practitioner')
    expect(provisional.id).toBe(PROVISIONAL_ID)
    expect(identifiersOf(provisional)).toEqual([
      `${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`,
    ])
    expect(
      provisional?.resourceType === 'Practitioner' ? provisional.name.map((name) => name.text) : []
    ).toEqual(['Dr. A Smith'])
    for (const key of ['k-0', 'k-1']) {
      const { requester } = subjectAndRequesterOf(at(resolved, key))
      expect([requester?.reference, requester?.display]).toEqual([
        `Practitioner/${PROVISIONAL_ID}`,
        'Dr. A Smith',
      ])
    }
    expect(leftByReferentLinksOnTestClock(file, map).map(pathOf)).toEqual(['subject', 'subject'])
  })

  it('links the name on a re-import to the record the first import wrote there as Stored, keeping what it carries', () => {
    const storedProvisional = storedOf(
      Schema.decodeUnknownSync(withMandatoryId(Practitioner.Schema))({
        resourceType: 'Practitioner',
        id: PROVISIONAL_ID,
        identifier: [
          { system: Practitioner.NAME_IDENTIFIER_SYSTEM, value: 'Dr. A Smith' },
          { system: DEVICE, value: 'kept' },
        ],
        name: [{ text: 'Dr. A Smith' }],
      })
    )

    const linked = linkedRecordsOnTestClock(
      file,
      HashMap.make([PRESCRIBER, LinkChoice.LinkToStoredResource({ resource: storedProvisional })])
    )

    expect(linked.map((entry) => [entry.key, entry.origin])).toEqual([
      [`linked:Practitioner/${PROVISIONAL_ID}`, 'Stored'],
    ])
    expect(identifiersOf(linkedAt(linked, `linked:Practitioner/${PROVISIONAL_ID}`))).toEqual([
      `${Practitioner.NAME_IDENTIFIER_SYSTEM}|Dr. A Smith`,
      `${DEVICE}|kept`,
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
    const cycle: ReferentLinkChoiceSet.Type = HashMap.make(
      [PRESCRIBER, LinkChoice.LinkToDecodedReferent({ referentKey: jones })],
      [jones, LinkChoice.LinkToDecodedReferent({ referentKey: PRESCRIBER })]
    )

    expect(
      referents
        .filter((referent) => Referent.key(referent) === PRESCRIBER)
        .map((referent) => ReferentLinkChoiceSet.forReferent(HashMap.empty(), referent)._tag)
    ).toEqual(['DontLink'])
    expect(linkTargetFor(map, referents, PRESCRIBER)).toBe(`Provisional ${PROVISIONAL_ID}`)
    expect(
      linkTargetFor(HashMap.make([ACCOUNT, LinkChoice.CreateResource()]), referents, ACCOUNT)
    ).toBe(`Invalid ${ACCOUNT} NotAllowedForReferent`)
    expect(linkTargetFor(cycle, referents, PRESCRIBER)).toBe(`Provisional ${PROVISIONAL_ID}`)
    expect(linkTargetFor(cycle, referents, jones)).toBe(`Provisional ${PROVISIONAL_ID}`)
  })
})

describe('Link.fromChoices', () => {
  const file = fileOf(
    patient({ id: 'p-1' }),
    request('rx-1', customerSubject('c-1')),
    request('rx-2', customerSubject('c-2')),
    request('rx-3', customerSubject('c-3'))
  )
  const referents = discoverOnTestClock(file)
  const account = (n: number): string => `Patient|${CUSTOMER}|c-${n}`

  it('follows a chain of referents to its end', () => {
    const choices: ReferentLinkChoiceSet.Type = HashMap.make(
      [account(1), LinkChoice.LinkToDecodedReferent({ referentKey: account(2) })],
      [account(2), LinkChoice.LinkToDecodedReferent({ referentKey: account(3) })],
      [account(3), LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })]
    )

    expect(linkTargetFor(choices, referents, account(1))).toBe('Decoded')
    expect(
      linkTargetFor(
        HashMap.set(choices, PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })),
        referents,
        account(1)
      )
    ).toBe('Stored s-1')
  })

  it('reads a cycle with nothing to create as unlinked', () => {
    const cycle: ReferentLinkChoiceSet.Type = HashMap.make(
      [account(1), LinkChoice.LinkToDecodedReferent({ referentKey: account(2) })],
      [account(2), LinkChoice.LinkToDecodedReferent({ referentKey: account(1) })],
      [account(3), LinkChoice.LinkToDecodedReferent({ referentKey: account(1) })]
    )

    expect(linkTargetFor(cycle, referents, account(1))).toBe('Unlinked')
    expect(linkTargetFor(cycle, referents, account(3))).toBe('Unlinked')
  })

  it('fails on a choice it cannot follow, naming the referent and why', () => {
    const invalid = (referentKey: string, choice: LinkChoice.Type): string =>
      linkTargetFor(HashMap.make([referentKey, choice]), referents, referentKey)

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

  it('fails on a link to a referent of another type: a subject is never redirected to a practitioner', () => {
    const withPrescriber = fileOf(
      request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith'))
    )
    const choices: ReferentLinkChoiceSet.Type = HashMap.make(
      [ACCOUNT, LinkChoice.LinkToDecodedReferent({ referentKey: PRESCRIBER })],
      [PRESCRIBER, LinkChoice.LinkToStoredResource({ resource: STORED_SMITH })]
    )

    expect(linkTargetFor(choices, discoverOnTestClock(withPrescriber), ACCOUNT)).toBe(
      `Invalid ${ACCOUNT} LinkedReferentOfAnotherType`
    )
    expect(failureOf(withPrescriber, choices)).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'InvalidLinkChoice', referentKey: ACCOUNT },
    })
  })

  it('fails a choice that leads to one it cannot follow', () => {
    const choices: ReferentLinkChoiceSet.Type = HashMap.make(
      [account(1), LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })],
      [PERSON, LinkChoice.DontLink()]
    )

    expect(linkTargetFor(choices, referents, account(1))).toBe(
      `Invalid ${PERSON} NotAllowedForReferent`
    )
  })

  it('defaults a referent with a resource to New and one named only by mentions to Don’t link', () => {
    const defaultsByKey = referents.map((referent) => [
      Referent.key(referent),
      ReferentLinkChoiceSet.forReferent(HashMap.empty(), referent)._tag,
    ])

    expect(defaultsByKey).toEqual([
      [PERSON, 'CreateResource'],
      [account(1), 'DontLink'],
      [account(2), 'DontLink'],
      [account(3), 'DontLink'],
    ])
    expect(linkTargetFor(HashMap.empty(), referents, PERSON)).toBe('Decoded')
  })
})

describe('UnlinkedMention.leftByReferentLinks on a decoded file', () => {
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
  const listed = (choices: ReferentLinkChoiceSet.Type): readonly string[] =>
    leftByReferentLinksOnTestClock(file, choices).map(
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

describe('FileResolution.resolveEdit', () => {
  const decodedPerson = patient({ id: 'p-1' })
  const file = fileOf(decodedPerson, observation('o-1'))
  // The reviewer's edit of the Observation, naming the decoded person by its literal reference.
  const edited = observation('o-1-edited', literalSubject('p-1'))
  const planOn = (
    choices: ReferentLinkChoiceSet.Type,
    byMention: MentionLinkChoiceSet.Type = MentionLinkChoiceSet.empty
  ): LinkPlan.Type =>
    runOnTestClock(
      Effect.map(LinkPlan.make([file], choices), (plan) =>
        LinkPlan.withMentionLinkChoiceSet(plan, byMention)
      )
    )
  const subjectOfEdit = (plan: LinkPlan.Type): string | null | undefined =>
    subjectAndRequesterOf(FileResolution.resolveEdit(plan, 'k-1')(edited)).subject?.reference

  it('comes back as itself while the person it names is written where it was decoded', () => {
    expect(FileResolution.resolveEdit(planOn(HashMap.empty()), 'k-1')(edited)).toBe(edited)
  })

  it('names the stored person standing in for the decoded one it named', () => {
    expect(
      subjectOfEdit(
        planOn(HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })]))
      )
    ).toBe('Patient/s-1')
  })

  it('follows a mention link chosen for it, keeping the edit', () => {
    const plan = planOn(
      HashMap.empty(),
      MentionLinkChoiceSet.set(
        MentionLinkChoiceSet.empty,
        'k-1',
        'subject',
        LinkChoice.LinkToStoredResource({ resource: STORED_JAN })
      )
    )

    expect(FileResolution.resolveEdit(plan, 'k-1')(edited).id).toBe('o-1-edited')
    expect(subjectOfEdit(plan)).toBe('Patient/s-2')
  })
})

describe('the identity map across files', () => {
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
    const { resolvedFiles } = resolveAcrossOnTestClock(
      Array.make(fileOf(patient({ id: 'p-1' })), fileOf(request('rx-1', customerSubject('c-9')))),
      HashMap.make([ACCOUNT, LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })])
    )

    expect(subjectAndRequesterOf(atFile(resolvedFiles, 1, 'k-0')).subject?.reference).toBe(
      'Patient/p-1'
    )
    expect(identifiersOf(atFile(resolvedFiles, 0, 'k-0'))).toEqual([
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

  it('writes a stored person two files only mention once, as the batch’s linked record', () => {
    const otherAccount = `Patient|${CUSTOMER}|c-8`

    const resolved = resolveAcrossOnTestClock(
      Array.make(
        fileOf(request('rx-1', customerSubject('c-9'))),
        fileOf(request('rx-2', customerSubject('c-8')))
      ),
      HashMap.make(
        [ACCOUNT, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })],
        [otherAccount, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })]
      )
    )

    expect(
      resolved.resolvedFiles.map((file) => file.sections.map((section) => section.title))
    ).toEqual([['Resources'], ['Resources']])
    expect(countWrittenAt(resolved.resolvedFiles, 'Patient/s-2')).toBe(0)
    expect(resolved.linkedRecords.map((entry) => entry.key)).toEqual(['linked:Patient/s-2'])
    expect(identifiersOf(linkedAt(resolved.linkedRecords, 'linked:Patient/s-2'))).toEqual([
      `${DEVICE}|s-2`,
      `${CUSTOMER}|c-9`,
      `${CUSTOMER}|c-8`,
    ])
    expect(
      resolved.resolvedFiles.map(
        (file) => subjectAndRequesterOf(at(file, 'k-0')).subject?.reference
      )
    ).toEqual(['Patient/s-2', 'Patient/s-2'])
  })

  it('links no record for a stored person another file holds, whose copy assumes the ids', () => {
    const { resolvedFiles, linkedRecords } = resolveAcrossOnTestClock(
      Array.make(fileOf(request('rx-1', customerSubject('c-9'))), fileOf(STORED_JAN)),
      HashMap.make([ACCOUNT, LinkChoice.LinkToStoredResource({ resource: STORED_JAN })])
    )

    expect(linkedRecords).toEqual([])
    expect(countWrittenAt(resolvedFiles, 'Patient/s-2')).toBe(1)
    expect(identifiersOf(atFile(resolvedFiles, 1, 'k-0'))).toEqual([
      `${DEVICE}|s-2`,
      `${CUSTOMER}|c-9`,
    ])
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

  it('property: resolving a file’s sections as separate files is resolving the file, with the same linked records', () => {
    fc.assert(
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
        const together = resolveAcrossOnTestClock(Array.of(file), choices)
        const apart = resolveAcrossOnTestClock(splitIntoFiles(file), choices)
        const linkedWireOf = (linked: readonly DecodedFile.Resource[]): readonly string[] =>
          linked.map((entry) => `${entry.key} ${wireOf(entry.resource)}`)

        expect(
          fileWireOf({
            ...file,
            sections: apart.resolvedFiles.flatMap((resolvedFile) => resolvedFile.sections),
          })
        ).toBe(fileWireOf(Array.headNonEmpty(together.resolvedFiles)))
        expect(linkedWireOf(apart.linkedRecords)).toEqual(linkedWireOf(together.linkedRecords))
      }),
      { numRuns: RUNS }
    )
  })

  it('property: applying the same choices across the files again changes nothing, when the resolved files have the decoded files’ referents', () => {
    fc.assert(
      fc.property(fileWithReapplicableChoicesArbitrary, ({ file, choices }) => {
        const once = resolveAcrossOnTestClock(splitIntoFiles(file), choices)
        const again = resolveAcrossOnTestClock(once.resolvedFiles, choices)
        expect(again.resolvedFiles.map(fileWireOf)).toEqual(once.resolvedFiles.map(fileWireOf))
      }),
      { numRuns: RUNS }
    )
  })
})

describe('identity map properties', () => {
  it('property: applying the same choices again changes nothing, when the resolved file has the decoded file’s referents', () => {
    fc.assert(
      fc.property(fileWithReapplicableChoicesArbitrary, ({ file, choices }) => {
        const once = resolveOnTestClock(file, choices)
        expect(fileWireOf(resolveOnTestClock(once, choices))).toBe(fileWireOf(once))
      }),
      { numRuns: RUNS }
    )
  })

  it('property: resolves one decoded file under one set of choices the same way every time', () => {
    fc.assert(
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
        expect(fileWireOf(resolveOnTestClock(file, choices))).toBe(
          fileWireOf(resolveOnTestClock(file, choices))
        )
      }),
      { numRuns: RUNS }
    )
  })

  it('property: keeps the file’s sections and keys', () => {
    fc.assert(
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
        const resolved = resolveOnTestClock(file, choices)
        const shape = (sections: readonly DecodedFile.Section[]): readonly unknown[] =>
          sections.map((section) => [section.title, section.resources.map((entry) => entry.key)])

        expect(shape(resolved.sections)).toEqual(shape(file.sections))
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
          const resolved = resolveOnTestClock(withUnrelated, choices)

          expect(
            resolved.sections[file.sections.length]?.resources.map((entry) => entry.resource)
          ).toEqual(unrelated)
          resolved.sections[file.sections.length]?.resources.forEach((entry, index) => {
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
        for (const { resource } of DecodedFile.resources(resolveOnTestClock(file, choices))) {
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

  it('property: lists a subject exactly when the resolved resource names no one by a relative literal', () => {
    fc.assert(
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
        const resolved = resolveOnTestClock(file, choices)
        const listedSubjects = leftByReferentLinksOnTestClock(file, choices)
          .filter((unlinked) => pathOf(unlinked) === 'subject')
          .map((unlinked) => unlinked.mentioningResourceKey)
        // The generated literals are `Patient/<id>` or an absolute URL into another system.
        const unlinkedSubjects = DecodedFile.resources(resolved)
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

describe('the identity map and the clock', () => {
  // A provider whose official name ended on 2026-10-31 and who goes by another since.
  const renamed = Schema.decodeUnknownSync(withMandatoryId(Practitioner.Schema))({
    resourceType: 'Practitioner',
    id: 'pr-1',
    identifier: [{ system: SOURCE_PRACTITIONER, value: 'pr-1' }],
    name: [
      { use: 'official', text: 'Dr. A Smith', period: { end: '2026-10-31' } },
      { text: 'Dr. A Jones' },
    ],
  })
  // Setting the test clock runs asynchronously, so these resolve the file through a promise.
  const appliedAt = (instant: string): Promise<DecodedFile.DecodedFile> =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(DateTime.unsafeMake(instant).epochMillis)
        const { resolvedFiles } = yield* resolveAcross(Array.of(fileOf(renamed)), HashMap.empty())
        return Array.headNonEmpty(resolvedFiles)
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

  it('resolves a file the same way twice at one instant', async () => {
    expect(fileWireOf(await appliedAt('2026-11-02T12:00:00Z'))).toBe(
      fileWireOf(await appliedAt('2026-11-02T12:00:00Z'))
    )
  })
})

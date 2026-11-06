import {
  type IdentifierAndReference,
  withMandatoryId,
} from '@wildflowerhealthio/fhir-r4/data-types'
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
  type DecodedFile,
  FileResolution,
  Link,
  LinkChoice,
  LinkPlan,
  LinkTarget,
  MentionLinkChoiceSet,
  Referent,
  ReferentLinkChoiceSet,
  type Row,
  type Section,
  SectionedList,
  UnlinkedMention,
} from '../index.ts'
import {
  ABSOLUTE,
  CUSTOMER,
  DEVICE,
  PRACTITIONER_NAME,
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
  literalSubject,
  resolveAcross,
  namedRequester,
  observation,
  patient,
  practitioner,
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

const PERSON = JSON.stringify(['Patient', SOURCE_PATIENT, 'p-1'])
const NAME_BIRTH_DATE = 'https://wildflowerhealth.io/fhir/identifier/patient-name-birth-date'

const at = (file: DecodedFile.DecodedFile, key: string): FhirResourceWithId | undefined =>
  SectionedList.rows(file).find((row) => row.key === key)?.resource

/** The resource keyed `key` in `file`; throws when there is none. */
const resourceAt = (file: DecodedFile.DecodedFile, key: string): FhirResourceWithId => {
  const resource = at(file, key)
  if (resource === undefined) throw new Error(`no resource keyed ${key}`)
  return resource
}

/** A decoded Patient keyed `p-<id>` that also carries the account ids `accounts`. */
const patientWithAccount = (
  id: string,
  accounts: readonly string[] = ['c-9']
): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
    resourceType: 'Patient',
    id,
    identifier: [
      { system: SOURCE_PATIENT, value: id },
      ...accounts.map((account) => ({ system: CUSTOMER, value: account })),
    ],
    name: [{ family: 'Banks', given: ['Tyra'] }],
    birthDate: '1990-01-02',
  })

/** A decoded Practitioner keyed `id`, that also carries its printed `name` as an identifier. */
const practitionerCarryingName = (id: string, name: string): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Practitioner.Schema))({
    resourceType: 'Practitioner',
    id,
    identifier: [
      { system: SOURCE_PRACTITIONER, value: id },
      { system: PRACTITIONER_NAME, value: name },
    ],
    name: [{ text: name }],
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

    expect(resolved.sections.map((section) => section.rows.map((row) => row.key))).toEqual([
      ['k-0', 'k-1', 'k-2', 'k-3'],
    ])
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

  it('writes a new person as it is plus its derived identifier, and leaves unlinked references alone', () => {
    const unlinked = request('rx-1', customerSubject('c-9'), namedRequester('Dr. A Smith'))
    const file = fileOf(patient({ id: 'p-1' }), unlinked)

    const resolved = resolveOnTestClock(file, HashMap.empty())

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
          logicalReference: { resourceType: 'Patient', identifier: [{ value: 'p-1' }] },
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

    expect(SectionedList.rows(resolved).map(({ key, title }) => [key, title])).toEqual([
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

  it('leaves a mention two decoded people answer to, by neither one’s key, as it is', () => {
    const file = fileOf(
      patientWithAccount('p-1'),
      patientWithAccount('p-2'),
      request('rx-1', customerSubject('c-9'))
    )

    expect(discoverOnTestClock(file).map(Referent.key)).toEqual([
      PERSON,
      JSON.stringify(['Patient', SOURCE_PATIENT, 'p-2']),
    ])
    expect(
      subjectAndRequesterOf(at(resolveOnTestClock(file, HashMap.empty()), 'k-2')).subject?.reference
    ).toBe(null)
  })

  it('redirects a printed name to the decoded Practitioner that carries it', () => {
    const decodedSmith = practitionerCarryingName('pr-1', 'Dr. A Smith')
    const file = fileOf(
      decodedSmith,
      request('rx-1', literalSubject('p-1'), namedRequester('Dr. A Smith'))
    )

    expect(discoverOnTestClock(file).map(Referent.key)).toEqual([
      JSON.stringify(['Practitioner', SOURCE_PRACTITIONER, 'pr-1']),
    ])
    const resolved = resolveOnTestClock(file, HashMap.empty())
    expect(at(resolved, 'k-0')).toBe(decodedSmith)
    expect(subjectAndRequesterOf(at(resolved, 'k-1')).requester?.reference).toBe(
      'Practitioner/pr-1'
    )
  })

  it('links a provider the import implied to a stored practitioner, and every prescription naming it with it', () => {
    const implied = practitioner('dr-smith', 'Dr. A Smith', PRACTITIONER_NAME)
    const requester = {
      reference: 'Practitioner/dr-smith',
      type: 'Practitioner',
      identifier: { system: PRACTITIONER_NAME, value: 'dr-smith' },
      display: 'Dr. A Smith',
    }
    const file = fileOf(
      implied,
      request('rx-1', literalSubject('p-1'), requester),
      request('rx-2', literalSubject('p-1'), requester),
      request('rx-3', literalSubject('p-1'), requester)
    )
    const prescriber = JSON.stringify(['Practitioner', PRACTITIONER_NAME, 'dr-smith'])

    const referents = discoverOnTestClock(file)
    expect(referents.map(Referent.key)).toEqual([prescriber])
    expect(
      referents.map((referent) => ReferentLinkChoiceSet.forReferent(HashMap.empty(), referent)._tag)
    ).toEqual(['CreateResource'])
    const resolved = resolveOnTestClock(
      file,
      HashMap.make([prescriber, LinkChoice.LinkToStoredResource({ resource: STORED_SMITH })])
    )
    expect(
      ['k-1', 'k-2', 'k-3'].map((key) => {
        const linked = subjectAndRequesterOf(at(resolved, key)).requester
        return [linked?.reference, linked?.display]
      })
    ).toEqual([
      ['Practitioner/sp-1', 'Dr. A Smith'],
      ['Practitioner/sp-1', 'Dr. A Smith'],
      ['Practitioner/sp-1', 'Dr. A Smith'],
    ])
  })
})

describe('the identity map on a re-import', () => {
  // The first import writes the person, carrying the two account ids the source gave it.
  const firstImport = resolveOnTestClock(
    fileOf(patientWithAccount('p-1', ['c-9', 'c-8'])),
    HashMap.empty()
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
  const reimport = fileOf(
    decodedAgain,
    request('rx-2', { type: 'Patient', identifier: { system: SOURCE_PATIENT, value: 'p-1' } })
  )
  // The decode's own identifiers, its derived one, then those only the stored copy carries.
  const assumedAll = [0, 3, 1, 2].flatMap((index) => storedCopy.identifier.slice(index, index + 1))
  // What `ReferentSearch.defaultChoices` gives: the search finds the stored copy.
  const defaultChoices: ReferentLinkChoiceSet.Type = HashMap.make([
    PERSON,
    LinkChoice.UpdateStoredResource({ resource: storedCopy }),
  ])

  it('links the person decoded to its stored copy, under one literal reference', () => {
    const referents = discoverOnTestClock(reimport)

    expect(identifiersOf(storedCopy)).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${CUSTOMER}|c-9`,
      `${CUSTOMER}|c-8`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
    ])
    expect(referents.map(Referent.key)).toEqual([PERSON])
    expect(linkTargetFor(defaultChoices, referents, PERSON)).toBe('Decoded')
  })

  it('writes the new decode, not the stored copy, having assumed every identifier the stored copy carries', () => {
    const resolved = resolveOnTestClock(reimport, defaultChoices)

    expect(wireOf(resourceAt(resolved, 'k-0'))).toBe(
      wireOf({ ...decodedAgain, identifier: assumedAll })
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
      wireOf({ ...decodedAgain, identifier: assumedAll })
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

  it('refuses to update a stored resource under another id', () => {
    expect(
      linkTargetFor(
        HashMap.make([PERSON, LinkChoice.UpdateStoredResource({ resource: STORED_TYRA })]),
        discoverOnTestClock(reimport),
        PERSON
      )
    ).toBe(`Invalid ${PERSON} StoredResourceUnderAnotherId`)
  })
})

describe('Link.fromChoices', () => {
  const referents = discoverOnTestClock(
    fileOf(patient({ id: 'p-1' }), request('rx-1', literalSubject('p-1')))
  )

  it('gives each choice its own target: the record written, over its stored copy, or a stored one', () => {
    const decoded = storedOf(patient({ id: 'p-1' }))

    expect(linkTargetFor(HashMap.empty(), referents, PERSON)).toBe('Decoded')
    expect(
      linkTargetFor(
        HashMap.make([PERSON, LinkChoice.UpdateStoredResource({ resource: decoded })]),
        referents,
        PERSON
      )
    ).toBe('Decoded')
    expect(
      linkTargetFor(
        HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })]),
        referents,
        PERSON
      )
    ).toBe('Stored s-1')
  })

  it('fails on a choice it cannot follow, naming the referent and why', () => {
    const invalid = (choice: LinkChoice.Type): string =>
      linkTargetFor(HashMap.make([PERSON, choice]), referents, PERSON)

    expect(invalid(LinkChoice.LinkToStoredResource({ resource: STORED_SMITH }))).toBe(
      `Invalid ${PERSON} StoredResourceOfAnotherType`
    )
    expect(invalid(LinkChoice.UpdateStoredResource({ resource: STORED_TYRA }))).toBe(
      `Invalid ${PERSON} StoredResourceUnderAnotherId`
    )
  })

  it('defaults every referent to New', () => {
    expect(
      referents.map((referent) => ReferentLinkChoiceSet.forReferent(HashMap.empty(), referent)._tag)
    ).toEqual(['CreateResource'])
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

  it('drops a mention a decoded record answers to', () => {
    const named = fileOf(
      ...SectionedList.rows(file).map(({ resource }) => resource),
      patientWithAccount('p-9'),
      practitionerCarryingName('pr-1', 'Dr. A Smith')
    )

    expect(
      leftByReferentLinksOnTestClock(named, HashMap.empty()).map(
        (unlinked) => `${unlinked._tag} ${unlinked.mentioningResourceKey} ${pathOf(unlinked)}`
      )
    ).toEqual([
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
  it('appends as a linked record a decoded record no file writes, once a stored one stands in for its id under another key', () => {
    // One id under two keys: the second key's referent links to a stored record,
    // which then stands in for every copy under that id, so the first key's
    // record, still its own, is written beside the files.
    const stored = storedOf(patient({ id: 's-1', value: 's' }))
    const { resolvedFiles, linkedRecords } = resolveAcrossOnTestClock(
      [fileOf(patient({ id: 'p-1', value: 'a' })), fileOf(patient({ id: 'p-1', value: 'b' }))],
      HashMap.make([
        JSON.stringify(['Patient', SOURCE_PATIENT, 'b']),
        LinkChoice.LinkToStoredResource({ resource: stored }),
      ])
    )

    expect(
      resolvedFiles.flatMap((file) => SectionedList.rows(file).map(({ resource }) => resource.id))
    ).toEqual(['s-1', 's-1'])
    expect(linkedRecords.map(({ key }) => key)).toEqual(['linked:Patient/p-1'])
  })

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

  it('links a mention in one file to the person another file holds', () => {
    const { resolvedFiles } = resolveAcrossOnTestClock(
      Array.make(
        fileOf(patientWithAccount('p-1')),
        fileOf(request('rx-1', customerSubject('c-9')))
      ),
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })])
    )

    expect(subjectAndRequesterOf(atFile(resolvedFiles, 1, 'k-0')).subject?.reference).toBe(
      'Patient/s-1'
    )
  })

  it('reads a person one file decodes and another only mentions as one referent', () => {
    const referents = runOnTestClock(
      Referent.discover([
        fileOf(
          observation('o-1', {
            type: 'Patient',
            identifier: { system: SOURCE_PATIENT, value: 'p-1' },
          })
        ),
        fileOf(patient({ id: 'p-1' }), request('rx-1', customerSubject('c-9'))),
        fileOf(patient({ id: 'p-1' })),
      ])
    )

    expect(referents.map(Referent.key)).toEqual([PERSON])
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
        const linkedWireOf = (linked: readonly Row.Type<FhirResourceWithId>[]): readonly string[] =>
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

  it('property: applying the same choices across the files again changes nothing', () => {
    fc.assert(
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
        const once = resolveAcrossOnTestClock(splitIntoFiles(file), choices)
        const again = resolveAcrossOnTestClock(once.resolvedFiles, choices)
        expect(again.resolvedFiles.map(fileWireOf)).toEqual(once.resolvedFiles.map(fileWireOf))
      }),
      { numRuns: RUNS }
    )
  })
})

describe('identity map properties', () => {
  it('property: applying the same choices again changes nothing', () => {
    fc.assert(
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
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
        const shape = (
          sections: readonly Section.Type<Row.Type<FhirResourceWithId>>[]
        ): readonly unknown[] =>
          sections.map((section) => [section.title, section.rows.map((row) => row.key)])

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

          expect(resolved.sections[file.sections.length]?.rows.map((row) => row.resource)).toEqual(
            unrelated
          )
          resolved.sections[file.sections.length]?.rows.forEach((row, index) => {
            expect(row.resource).toBe(unrelated[index])
          })
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('property: a stored resource keeps its demographics byte for byte, and its identifiers stay a set', () => {
    fc.assert(
      fc.property(fileWithChoicesArbitrary, ({ file, choices }) => {
        for (const { resource } of SectionedList.rows(resolveOnTestClock(file, choices))) {
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
        const unlinkedSubjects = SectionedList.rows(resolved)
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
  // A person whose official name ended on 2026-10-31 and who goes by another since.
  const renamed = Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
    resourceType: 'Patient',
    id: 'p-1',
    identifier: [{ system: SOURCE_PATIENT, value: 'p-1' }],
    name: [
      { use: 'official', family: 'Banks', given: ['Tyra'], period: { end: '2026-10-31' } },
      { family: 'Jones', given: ['Tyra'] },
    ],
    birthDate: '1990-01-02',
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

  it('derives a person’s name and birth date identifier from the name current at the clock’s now', async () => {
    expect(identifiersOf(at(await appliedAt('2026-10-30T12:00:00Z'), 'k-0'))).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|banks;tyra;1990-01-02`,
    ])
    expect(identifiersOf(at(await appliedAt('2026-11-02T12:00:00Z'), 'k-0'))).toEqual([
      `${SOURCE_PATIENT}|p-1`,
      `${NAME_BIRTH_DATE}|jones;tyra;1990-01-02`,
    ])
  })

  it('resolves a file the same way twice at one instant', async () => {
    expect(fileWireOf(await appliedAt('2026-11-02T12:00:00Z'))).toBe(
      fileWireOf(await appliedAt('2026-11-02T12:00:00Z'))
    )
  })
})

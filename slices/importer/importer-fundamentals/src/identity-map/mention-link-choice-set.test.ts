import type { IdentifierAndReference } from '@wildflowerhealthio/fhir-r4/data-types'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Array, FastCheck as fc, HashMap, Option } from 'effect'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

import {
  DecodedFile,
  LinkChoice,
  LinkableResource,
  Mention,
  MentionLinkChoiceSet,
  Referent,
  UnlinkedMention,
} from '../index.ts'
import {
  ABSOLUTE,
  CUSTOMER,
  SOURCE_PATIENT,
  STORED_JAN,
  STORED_SMITH,
  STORED_TYRA,
  customerSubject,
  discoverOnTestClock,
  fileOf,
  fileWireOf,
  fileWithReapplicableChoicesArbitrary,
  literalSubject,
  observation,
  patient,
  request,
  resolveOnTestClock,
  STORED,
} from './identity-map.test-helpers.ts'

/**
 * A mention the reviewer chose a link for on its own lands where that choice
 * says, over its referent's rule, and the plan resolves it: a
 * `LinkToDecodedReferent` follows its referent's later link, a
 * `LinkToStoredResource` teaches and writes nothing, a `DontLink` keeps what
 * the mention still names.
 */

// Schema-generated resources at fast-check's default size run to hundreds of
// kilobytes each; the properties are about structure, which the smallest size
// still exercises.
beforeAll(() => {
  fc.configureGlobal({ baseSize: 'xsmall' })
})
afterAll(() => {
  fc.resetConfigureGlobal()
})

const RUNS = numRunsFor({ base: 30 })

const PERSON = `Patient|${SOURCE_PATIENT}|p-1`
const ACCOUNT = `Patient|${CUSTOMER}|c-9`

/** The `subject` of the resource keyed `key` in `file`: `null` for an empty slot, `undefined` for none. */
const subjectAt = (
  file: DecodedFile.DecodedFile,
  key: string
): IdentifierAndReference.ReferenceType | null | undefined => {
  const resource = DecodedFile.resources(file).find((entry) => entry.key === key)?.resource
  return resource !== undefined && 'subject' in resource ? resource.subject : undefined
}

/** Mention link choices on the `subject` of each resource keyed in `chosen`. */
const onSubjects = (
  chosen: ReadonlyArray<readonly [string, LinkChoice.MentionLinkChoice]>
): MentionLinkChoiceSet.Type =>
  chosen.reduce(
    (choices, [reviewKey, choice]) =>
      MentionLinkChoiceSet.set(choices, reviewKey, Mention.SUBJECT_PATH, choice),
    MentionLinkChoiceSet.empty
  )

describe('a mention link choice on a resolved file', () => {
  const file = fileOf(
    patient({ id: 'p-1' }),
    request('rx-1', { ...customerSubject('c-9'), display: 'Tyra B.' }),
    request('rx-2', customerSubject('c-9')),
    observation('o-1')
  )

  it('lands a LinkToDecodedReferent mention where its referent lands, and follows that referent’s later link', () => {
    const toPerson = onSubjects([
      ['k-1', LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })],
    ])

    const onDecoded = resolveOnTestClock(file, HashMap.empty(), toPerson)
    const onStored = resolveOnTestClock(
      file,
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })]),
      toPerson
    )

    expect(subjectAt(onDecoded, 'k-1')?.reference).toBe('Patient/p-1')
    expect(subjectAt(onStored, 'k-1')?.reference).toBe('Patient/s-1')
    expect([
      subjectAt(onStored, 'k-1')?.display,
      subjectAt(onStored, 'k-1')?.identifier?.value,
    ]).toEqual(['Tyra B.', 'c-9'])
    // The account's other mention keeps the account's own rule: not linked.
    expect(subjectAt(onStored, 'k-2')?.reference).toBe(null)
  })

  it('lands a LinkToStoredResource mention on that resource, teaching it nothing and writing nothing', () => {
    const resolved = resolveOnTestClock(
      file,
      HashMap.empty(),
      onSubjects([['k-1', LinkChoice.LinkToStoredResource({ resource: STORED_JAN })]])
    )

    expect(subjectAt(resolved, 'k-1')?.reference).toBe('Patient/s-2')
    expect(subjectAt(resolved, 'k-2')?.reference).toBe(null)
    expect(resolved.sections.map((section) => section.title)).toEqual(['Resources'])
    expect(DecodedFile.resources(resolved).filter(({ resource }) => resource.id === 's-2')).toEqual(
      []
    )
  })

  it('drops a DontLink mention’s literal and keeps its identifier and display', () => {
    const linked = fileOf(
      patient({ id: 'p-1' }),
      request('rx-1', { ...literalSubject('p-1'), display: 'Tyra' }),
      request('rx-2', literalSubject('p-1')),
      observation('o-1', { reference: ABSOLUTE })
    )

    const resolved = resolveOnTestClock(
      linked,
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })]),
      onSubjects([
        ['k-1', LinkChoice.DontLink()],
        ['k-3', LinkChoice.DontLink()],
      ])
    )

    const subject = subjectAt(resolved, 'k-1')
    expect([subject?.reference, subject?.display, subject?.identifier?.value]).toEqual([
      null,
      'Tyra',
      'p-1',
    ])
    expect(subjectAt(resolved, 'k-2')?.reference).toBe('Patient/s-1')
    // With nothing left to name, Don't link leaves the mention as it is.
    expect(subjectAt(resolved, 'k-3')?.reference).toBe(ABSOLUTE)
  })

  it('fills an empty subject slot from its choice, which the unlinked mentions then leave out', () => {
    const choices = onSubjects([['k-3', LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })]])

    const resolved = resolveOnTestClock(file, HashMap.empty(), choices)

    expect(subjectAt(resolved, 'k-3')?.reference).toBe('Patient/p-1')
    expect(
      UnlinkedMention.collect(resolved).map((unlinked) => unlinked.mentioningResourceKey)
    ).toEqual(['k-1', 'k-2'])
  })

  it('reads a choice the mention cannot take as none: another type, or a referent landing nowhere', () => {
    const resolved = resolveOnTestClock(
      file,
      HashMap.empty(),
      onSubjects([
        ['k-1', LinkChoice.LinkToStoredResource({ resource: STORED_SMITH })],
        ['k-2', LinkChoice.LinkToDecodedReferent({ referentKey: ACCOUNT })],
        [
          'k-3',
          LinkChoice.LinkToDecodedReferent({ referentKey: 'Patient|https://nowhere.example|x' }),
        ],
      ])
    )

    expect([subjectAt(resolved, 'k-1'), subjectAt(resolved, 'k-2')]).toEqual([
      subjectAt(file, 'k-1'),
      subjectAt(file, 'k-2'),
    ])
    expect(subjectAt(resolved, 'k-3')).toBe(null)
  })
})

describe('Mention.linkableIn', () => {
  it('names a Patient for a subject, whatever it carries, and for an empty subject slot; a provider by its type', () => {
    const bare = observation('o-1')
    const named = request(
      'rx-1',
      { display: 'T. Banks' },
      { type: 'Practitioner', identifier: { system: 'https://x.example', value: '1' } }
    )

    expect(Mention.linkableIn(bare).map(({ path, type }) => [path, type])).toEqual([
      ['subject', 'Patient'],
    ])
    expect(Mention.linkableIn(named).map(({ path, type }) => [path, type])).toEqual([
      ['subject', 'Patient'],
      ['requester', 'Practitioner'],
    ])
  })

  it('leaves out a mention of a type the map does not link, or that states none', () => {
    const report = observation('o-1', { reference: 'Group/g-1' }, [
      { display: 'LifeLabs' },
      { reference: 'Organization/org-1' },
    ])

    expect(Mention.linkableIn(report)).toEqual([])
  })
})

describe('Mention.relinked', () => {
  it('property: differs from the resource given only at the mention relinked', () => {
    const literals = fc.option(
      fc.constantFrom(...STORED.map(LinkableResource.literalReferenceOf)),
      { nil: undefined }
    )
    fc.assert(
      fc.property(
        fileWithReapplicableChoicesArbitrary,
        fc.nat(),
        literals,
        ({ file }, pick, literal) => {
          const entries = DecodedFile.resources(file)
          const entry = entries[pick % Math.max(entries.length, 1)]
          if (entry === undefined) return
          const mentions = Mention.linkableIn(entry.resource)
          const mention = mentions[pick % Math.max(mentions.length, 1)]
          if (mention === undefined) return

          const relinked = Mention.relinked(
            entry.resource,
            mention.path,
            Option.fromNullable(literal)
          )

          const before = Mention.madeIn(entry.resource)
          const after = Mention.madeIn(relinked)
          const elsewhere = (found: readonly Mention.Type[]): readonly Mention.Type[] =>
            found.filter(({ path }) => path !== mention.path)
          expect(elsewhere(after)).toEqual(elsewhere(before))
          const now = Mention.at(relinked, mention.path)
          if (relinked === entry.resource) return
          // A relink lands the literal, or drops it, and keeps the rest of the mention.
          expect(Option.map(now, ({ reference }) => reference.reference)).toEqual(
            Option.some(literal ?? null)
          )
          expect(
            Option.map(now, ({ reference }) => [reference.identifier, reference.display])
          ).toEqual(Option.some([mention.reference.identifier, mention.reference.display]))
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('mention link choices and the referents', () => {
  /** Mention link choices each linkable mention of `file` can take, or none for some. */
  const mentionChoicesForArbitrary = (
    file: DecodedFile.DecodedFile
  ): fc.Arbitrary<MentionLinkChoiceSet.Type> => {
    const referents = discoverOnTestClock(file)
    const slots = DecodedFile.resources(file).flatMap(({ key, resource }) =>
      Mention.linkableIn(resource).map((mention) => ({ key, mention }))
    )
    return fc
      .tuple(
        ...slots.map(({ key, mention }) =>
          fc
            .option(
              fc.oneof(
                fc.constant<LinkChoice.MentionLinkChoice>(LinkChoice.DontLink()),
                fc
                  .constantFrom(...STORED.filter((stored) => stored.resourceType === mention.type))
                  .map((resource) => LinkChoice.LinkToStoredResource({ resource })),
                ...(referents.some((referent) => referent.logicalReference.type === mention.type)
                  ? [
                      fc
                        .constantFrom(
                          ...referents
                            .filter((referent) => referent.logicalReference.type === mention.type)
                            .map(Referent.key)
                        )
                        .map((referentKey) => LinkChoice.LinkToDecodedReferent({ referentKey })),
                    ]
                  : [])
              ),
              { nil: undefined }
            )
            .map((choice) => ({ key, path: mention.path, choice }))
        )
      )
      .map((made) =>
        made.reduce(
          (choices, { key, path, choice }) =>
            choice === undefined ? choices : MentionLinkChoiceSet.set(choices, key, path, choice),
          MentionLinkChoiceSet.empty
        )
      )
  }

  it('property: resolving again on the same choices changes nothing, when the resolved file has the decoded file’s referents', () => {
    fc.assert(
      fc.property(
        fileWithReapplicableChoicesArbitrary.chain(({ file, choices }) =>
          mentionChoicesForArbitrary(file).map((mentionChoices) => ({
            file,
            choices,
            mentionChoices,
          }))
        ),
        ({ file, choices, mentionChoices }) => {
          const once = resolveOnTestClock(file, choices, mentionChoices)
          const again = resolveOnTestClock(once, choices, mentionChoices)

          expect(fileWireOf(again)).toBe(fileWireOf(once))
        }
      ),
      { numRuns: RUNS }
    )
  })

  it('property: a mention link choice moves nothing but the mentions chosen for', () => {
    fc.assert(
      fc.property(
        fileWithReapplicableChoicesArbitrary.chain(({ file, choices }) =>
          mentionChoicesForArbitrary(file).map((mentionChoices) => ({
            file,
            choices,
            mentionChoices,
          }))
        ),
        ({ file, choices, mentionChoices }) => {
          const onReferents = resolveOnTestClock(file, choices)
          const withChosen = resolveOnTestClock(file, choices, mentionChoices)

          const unchosenMentionsOf = (resolved: DecodedFile.DecodedFile): readonly unknown[] =>
            DecodedFile.resources(resolved).flatMap(({ key, resource }) =>
              Mention.madeIn(resource)
                .filter(({ path }) =>
                  Option.isNone(MentionLinkChoiceSet.forMention(mentionChoices, key, path))
                )
                .map((mention) => [key, mention])
            )
          expect(unchosenMentionsOf(withChosen)).toEqual(unchosenMentionsOf(onReferents))
          expect(Array.map(withChosen.sections, (section) => section.title)).toEqual(
            Array.map(onReferents.sections, (section) => section.title)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })
})

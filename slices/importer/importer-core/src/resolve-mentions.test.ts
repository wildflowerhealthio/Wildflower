import { withMandatoryId } from '@wildflowerhealthio/fhir-r4/data-types'
import {
  DocumentReference,
  type FhirResource,
  type FhirResourceWithId,
  MedicationRequest,
  Patient,
  LogicalReference,
} from '@wildflowerhealthio/fhir-r4/resources'
import {
  type LinkableResource,
  LinkChoice,
  LinkPlan,
  MentionLinkChoiceSet,
  Referent,
  type ReferentLinkChoiceSet,
  SectionedList,
  UnlinkedMention,
} from '@wildflowerhealthio/importer-fundamentals'
import { Array as Arr, Effect, HashMap, Option, Schema, TestContext } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type { DecodedBatch } from './read-batch.ts'
import { type FormatKind, formatKinds, formatRegistry } from './registry.ts'
import {
  resolveMentions,
  discoverReferents,
  isSourceFileOf,
  resolveMentionsWithFallback,
  type ResolvedBatch,
} from './resolve-mentions.ts'
import * as ReviewGroup from './review-group.ts'

/** The key of the logical reference to the `resourceType` record named `value` in `system`. */
const keyOf = (
  resourceType: 'Patient' | 'Practitioner',
  system: string,
  value: string
): LogicalReference.Key =>
  LogicalReference.key(
    LogicalReference.make(resourceType, {
      id: null,
      extension: [],
      assigner: null,
      period: null,
      system: new URL(system),
      type: null,
      use: null,
      value,
    })
  )

/**
 * A batch built by hand, its mentions resolved: each format's decoded
 * file one section of the given resources, keyed `<kind>/k-<index>`.
 */

const SOURCE_PATIENT = 'https://source.example/patient-id'
const CUSTOMER = 'https://source.example/customer-id'
const DEVICE = 'https://device.example/id'
const PERSON = keyOf('Patient', SOURCE_PATIENT, 'p-1')

/** `effect` run on a `TestClock` standing at the epoch; throws its failure. */
const runOnTestClock = <A, E>(effect: Effect.Effect<A, E>): A =>
  Effect.runSync(Effect.provide(effect, TestContext.TestContext))

const patient = (id: string, system: string): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(Patient.Schema))({
    resourceType: 'Patient',
    id,
    identifier: [{ system, value: id }],
    name: [{ family: 'Banks', given: ['Tyra'] }],
  })

/** A `MedicationRequest` naming its subject by `subject`. */
const request = (id: string, subject: object): FhirResourceWithId =>
  Schema.decodeUnknownSync(withMandatoryId(MedicationRequest.Schema))({
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    subject,
  })

const accountSubject = { type: 'Patient', identifier: { system: CUSTOMER, value: 'c-9' } }

const STORED_TYRA: LinkableResource.WithId = (() => {
  const stored = patient('s-1', DEVICE)
  if (stored.resourceType !== 'Patient') throw new Error('unreachable')
  return stored
})()

/** `kind`'s group holding `resources` in one section, read from one pick. */
const groupOf = (kind: FormatKind, resources: readonly FhirResourceWithId[]): ReviewGroup.Type => ({
  sectionedList: SectionedList.make([
    {
      title: 'Resources',
      rows: resources.map((resource, index) => ({
        reviewKey: `${kind}/k-${index}`,
        title: `${resource.resourceType}/${resource.id}`,
        isImplied: false,
        resource,
      })),
    },
  ]),
  notes: [],
  unreadableFiles: [],
  files: [{ id: `0:${kind}`, fileName: kind, bytes: new Uint8Array([1]) }],
})

/** A batch of the given formats' resources, the others claiming nothing. */
const batchOf = (formats: {
  readonly [K in FormatKind]?: readonly FhirResourceWithId[]
}): DecodedBatch => {
  const claimed = Arr.filterMap(formatKinds, (kind) =>
    Option.map(Option.fromNullable(formats[kind]), (resources) => [kind, resources] as const)
  )
  return {
    groups: Object.fromEntries(
      claimed.map(([kind, resources]) => [kind, groupOf(kind, resources)])
    ),
    unrecognizedFiles: [],
  }
}

/** `batch` with its mentions resolved on `byReferent`, and on `byMention` when given, on the test clock. */
const resolvedOnTestClock = (
  batch: DecodedBatch,
  byReferent: ReferentLinkChoiceSet.Type,
  byMention: MentionLinkChoiceSet.Type = MentionLinkChoiceSet.empty
): ResolvedBatch => runOnTestClock(resolveMentions(batch, { byReferent, byMention }))

/** The resource keyed `key` in `kind`'s group. */
const at = (
  batch: { readonly groups: ReviewGroup.Groups },
  kind: FormatKind,
  key: string
): FhirResource | undefined =>
  ReviewGroup.entries(batch.groups, [kind])
    .flatMap(([, group]) => ReviewGroup.rows(group))
    .find((row) => row.reviewKey === key)?.resource

const subjectOf = (resource: FhirResource | undefined): string | null | undefined =>
  resource !== undefined && 'subject' in resource ? resource.subject?.reference : undefined

const identifiersOf = (resource: FhirResource | undefined): readonly string[] =>
  resource !== undefined && 'identifier' in resource
    ? resource.identifier.map((identifier) => `${identifier.system?.href}|${identifier.value}`)
    : []

describe('discoverReferents', () => {
  it('finds one referent per identity across formats, with its resource wherever it is', () => {
    const batch = batchOf({
      har: [
        request('rx-1', { type: 'Patient', identifier: { system: SOURCE_PATIENT, value: 'p-1' } }),
        request('rx-2', accountSubject),
      ],
      'lifelabs-pdf': [patient('p-1', SOURCE_PATIENT), request('rx-3', accountSubject)],
    })

    expect(runOnTestClock(discoverReferents(batch)).map(Referent.key)).toEqual([PERSON])
  })
})

describe('resolveMentions', () => {
  it('keeps every format’s sections and keys, and a group nothing moved in as it was', () => {
    const batch = batchOf({
      har: [request('rx-1', accountSubject)],
      'lifelabs-pdf': [patient('p-1', SOURCE_PATIENT)],
    })

    const resolved = resolvedOnTestClock(batch, HashMap.empty())

    expect(
      (['har', 'lifelabs-pdf'] as const).map((kind) =>
        resolved.groups[kind]?.sectionedList.sections.map((section) => [
          section.title,
          section.rows.map((row) => row.reviewKey),
        ])
      )
    ).toEqual([[['Resources', ['har/k-0']]], [['Resources', ['lifelabs-pdf/k-0']]]])
    expect(resolved.groups['lifelabs-pdf']).toBe(batch.groups['lifelabs-pdf'])
    expect(resolved.groups.dicom).toBeUndefined()
    expect(resolved.groups.linked).toBeUndefined()
  })

  it('gives an empty batch back as it is, with no linked records and no link targets', () => {
    const batch = batchOf({})

    const resolved = resolvedOnTestClock(batch, HashMap.empty())

    expect(resolved.groups).toEqual({})
    expect(LinkPlan.linkTargets(resolved.plan)).toEqual([])
    expect(resolved.decoded).toBe(batch)
  })

  it('links a mention in one format to the person another format holds, wherever that person is linked', () => {
    const resolved = resolvedOnTestClock(
      batchOf({
        har: [
          request('rx-1', {
            type: 'Patient',
            identifier: { system: SOURCE_PATIENT, value: 'p-1' },
          }),
        ],
        'lifelabs-pdf': [patient('p-1', SOURCE_PATIENT)],
      }),
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })])
    )

    expect(subjectOf(at(resolved, 'har', 'har/k-0'))).toBe('Patient/s-1')
    expect(at(resolved, 'lifelabs-pdf', 'lifelabs-pdf/k-0')?.id).toBe('s-1')
  })

  it('fails as the stage does, naming the referent a choice cannot be resolved for', () => {
    const batch = batchOf({ har: [patient('p-1', SOURCE_PATIENT)] })

    expect(
      runOnTestClock(
        Effect.either(
          resolveMentions(batch, {
            byReferent: HashMap.make([
              PERSON,
              LinkChoice.UpdateStoredResource({ resource: STORED_TYRA }),
            ]),
            byMention: MentionLinkChoiceSet.empty,
          })
        )
      )
    ).toMatchObject({
      _tag: 'Left',
      left: {
        _tag: 'InvalidLinkChoice',
        referentKey: PERSON,
        reason: 'StoredResourceUnderAnotherId',
      },
    })
  })
})

describe('resolveMentions with mention link choices', () => {
  const batch = batchOf({
    har: [request('rx-1', accountSubject), request('rx-2', accountSubject)],
    'lifelabs-pdf': [patient('p-1', SOURCE_PATIENT)],
  })

  it('redirects a mention one format chose for on its own where its choice says, the rest to their referent’s link target', () => {
    const resolved = resolvedOnTestClock(
      batch,
      HashMap.make([PERSON, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })]),
      MentionLinkChoiceSet.set(
        MentionLinkChoiceSet.empty,
        'har/k-1',
        'subject',
        LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })
      )
    )

    expect([
      subjectOf(at(resolved, 'har', 'har/k-0')),
      subjectOf(at(resolved, 'har', 'har/k-1')),
    ]).toEqual([null, 'Patient/s-1'])
    // A mention link choice teaches nothing: the stored person, standing in
    // for the decoded one, assumes only what its own referent brings.
    expect(at(resolved, 'lifelabs-pdf', 'lifelabs-pdf/k-0')?.id).toBe('s-1')
    expect(identifiersOf(at(resolved, 'lifelabs-pdf', 'lifelabs-pdf/k-0'))).not.toContain(
      `${CUSTOMER}|c-9`
    )
  })

  it('keeps the decoded batch, in which the plan’s referent links leave unlinked what they did before a mention link choice', () => {
    const onReferents = resolvedOnTestClock(batch, HashMap.empty())
    const withChosen = resolvedOnTestClock(
      batch,
      HashMap.empty(),
      MentionLinkChoiceSet.set(
        MentionLinkChoiceSet.empty,
        'har/k-1',
        'subject',
        LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })
      )
    )

    const listed = (resolved: ResolvedBatch): readonly string[] =>
      ReviewGroup.entries(resolved.decoded.groups, formatKinds)
        .flatMap(([, group]) => ReviewGroup.rows(group))
        .flatMap(({ reviewKey, resource }) =>
          UnlinkedMention.leftByReferentLinks(resolved.plan, reviewKey, resource)
        )
        .map(({ _tag, mentioningResourceKey }) => `${_tag} ${mentioningResourceKey}`)
    expect(listed(onReferents)).toEqual(['Dangling har/k-0', 'Dangling har/k-1'])
    expect(listed(withChosen)).toEqual(listed(onReferents))
    expect(withChosen.decoded).toBe(batch)
    expect(subjectOf(at(withChosen, 'har', 'har/k-1'))).toBe('Patient/p-1')
  })

  it('names a format’s own source file, which the review never asks a patient for', () => {
    const sourceFile = Schema.decodeUnknownSync(withMandatoryId(DocumentReference.Schema))({
      resourceType: 'DocumentReference',
      id: 'src-1',
      status: 'current',
      category: [
        {
          coding: [
            {
              system: formatRegistry.har.sourceFileFormat.coding.system,
              code: formatRegistry.har.sourceFileFormat.coding.code,
            },
          ],
        },
      ],
      content: [{ attachment: { contentType: 'application/json' } }],
    })

    expect([
      isSourceFileOf('har', sourceFile),
      isSourceFileOf('lifelabs-pdf', sourceFile),
      isSourceFileOf('har', request('rx-1', accountSubject)),
    ]).toEqual([true, false, false])
  })
})

describe('resolveMentionsWithFallback', () => {
  const batch = batchOf({ har: [patient('p-1', SOURCE_PATIENT)] })
  const linkedToStored = LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })
  // An update of a stored record under another id than the person's own.
  const cannotBeResolved = LinkChoice.UpdateStoredResource({ resource: STORED_TYRA })

  /** The choices used and each referent's link target's tag, on the test clock. */
  const withFallbackOnTestClock = (
    defaults: ReferentLinkChoiceSet.Type,
    chosen: ReferentLinkChoiceSet.Type
  ): {
    readonly linkChoices: ReadonlyArray<readonly [string, LinkChoice.Type]>
    readonly targets: readonly string[]
  } => {
    const resolved = runOnTestClock(
      resolveMentionsWithFallback(batch, defaults, chosen, MentionLinkChoiceSet.empty)
    )
    return {
      linkChoices: Array.from(HashMap.entries(resolved.linkChoices)),
      targets: LinkPlan.linkTargets(resolved.batch.plan).map((target) => target._tag),
    }
  }

  it('drops a chosen choice that cannot be resolved first, so the referent takes its searched default', () => {
    expect(
      withFallbackOnTestClock(
        HashMap.make([PERSON, linkedToStored]),
        HashMap.make([PERSON, cannotBeResolved])
      )
    ).toEqual({ linkChoices: [[PERSON, linkedToStored]], targets: ['Stored'] })
  })

  it('drops a default that cannot be resolved next, so the referent takes New', () => {
    expect(
      withFallbackOnTestClock(
        HashMap.make([PERSON, cannotBeResolved]),
        HashMap.make([PERSON, cannotBeResolved])
      )
    ).toEqual({ linkChoices: [], targets: ['Decoded'] })
  })
})

import { FhirResourceSchema, type FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import {
  DecodedFile,
  FormatDecode,
  LinkChoice,
  type LinkableResource,
  Placement,
  Referent,
  type ReferentLinkChoices,
} from '@wildflowerhealthio/importer-fundamentals'
import { Effect, HashMap, Schema, TestContext } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { applyIdentityMap, discoverReferents } from './identity-map.ts'
import type { BatchDecodeResult } from './read-batch.ts'
import type { FormatKind } from './registry.ts'

/**
 * The identity map lifted over a batch built by hand: each format's decoded
 * file one section of the given resources, keyed `<kind>/k-<index>`.
 */

const SOURCE_PATIENT = 'https://source.example/patient-id'
const CUSTOMER = 'https://source.example/customer-id'
const DEVICE = 'https://device.example/id'
const PERSON = `Patient|${SOURCE_PATIENT}|p-1`
const ACCOUNT = `Patient|${CUSTOMER}|c-9`

const decodeResource = Schema.decodeUnknownSync(FhirResourceSchema)

/** `effect` run on a `TestClock` standing at the epoch; throws its failure. */
const runOnTestClock = <A, E>(effect: Effect.Effect<A, E>): A =>
  Effect.runSync(Effect.provide(effect, TestContext.TestContext))

const patient = (id: string, system: string): FhirResource =>
  decodeResource({
    resourceType: 'Patient',
    id,
    identifier: [{ system, value: id }],
    name: [{ family: 'Banks', given: ['Tyra'] }],
  })

/** A `MedicationRequest` naming its subject by `subject`. */
const request = (id: string, subject: object): FhirResource =>
  decodeResource({
    resourceType: 'MedicationRequest',
    id,
    status: 'active',
    intent: 'order',
    subject,
  })

const accountSubject = { type: 'Patient', identifier: { system: CUSTOMER, value: 'c-9' } }

const STORED_TYRA: LinkableResource.WithId = (() => {
  const stored = patient('s-1', DEVICE)
  if (stored.resourceType !== 'Patient' || stored.id === null) throw new Error('unreachable')
  return { ...stored, id: stored.id }
})()

/** `kind`'s result holding `resources`, or the empty result of a format that claimed nothing. */
const resultOf = <K extends FormatKind>(
  kind: K,
  resources: readonly FhirResource[] | undefined
): FormatDecode.Result<K> =>
  resources === undefined
    ? FormatDecode.emptyResult(kind)
    : {
        ...FormatDecode.emptyResult(kind),
        title: `${kind} file`,
        files: [{ id: `0:${kind}`, fileName: kind, bytes: new Uint8Array([1]) }],
        decoded: {
          sections: [
            {
              title: 'Resources',
              resources: resources.map((resource, index) => ({
                key: `${kind}/k-${index}`,
                title: `${resource.resourceType}/${resource.id}`,
                resource,
              })),
            },
          ],
          notes: [],
        },
      }

const batchOf = (formats: {
  readonly [K in FormatKind]?: readonly FhirResource[]
}): BatchDecodeResult => ({
  har: resultOf('har', formats.har),
  'lifelabs-pdf': resultOf('lifelabs-pdf', formats['lifelabs-pdf']),
  dicom: resultOf('dicom', formats.dicom),
  unrecognizedFiles: [],
})

/** `batch` placed on `linkChoices`, on the test clock. */
const applied = (
  batch: BatchDecodeResult,
  linkChoices: ReferentLinkChoices.Type
): BatchDecodeResult => runOnTestClock(applyIdentityMap(batch, linkChoices))

/** The resource keyed `key` in `kind`'s decoded file. */
const at = (batch: BatchDecodeResult, kind: FormatKind, key: string): FhirResource | undefined =>
  DecodedFile.resources(batch[kind].decoded).find((entry) => entry.key === key)?.resource

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

    expect(
      runOnTestClock(discoverReferents(batch)).map((referent) => [
        referent._tag,
        Referent.key(referent),
      ])
    ).toEqual([
      ['AsResource', PERSON],
      ['ByMentionOnly', ACCOUNT],
    ])
  })
})

describe('applyIdentityMap', () => {
  it('keeps every format’s sections and keys, and every other slot as it was', () => {
    const batch = batchOf({
      har: [request('rx-1', accountSubject)],
      'lifelabs-pdf': [patient('p-1', SOURCE_PATIENT)],
    })

    const placed = applied(
      batch,
      HashMap.make([ACCOUNT, LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })])
    )

    expect(
      (['har', 'lifelabs-pdf'] as const).map((kind) =>
        placed[kind].decoded.sections.map((section) => [
          section.title,
          section.resources.map((entry) => entry.key),
        ])
      )
    ).toEqual([[['Resources', ['har/k-0']]], [['Resources', ['lifelabs-pdf/k-0']]]])
    expect(placed.dicom).toBe(batch.dicom)
    expect(placed.unrecognizedFiles).toBe(batch.unrecognizedFiles)
  })

  it('gives an empty batch back as itself', () => {
    const batch = batchOf({})

    expect(applied(batch, HashMap.empty())).toBe(batch)
  })

  it('links a mention in one format to the person another format holds', () => {
    const placed = applied(
      batchOf({
        har: [request('rx-1', accountSubject)],
        'lifelabs-pdf': [patient('p-1', SOURCE_PATIENT)],
      }),
      HashMap.make([ACCOUNT, LinkChoice.LinkToDecodedReferent({ referentKey: PERSON })])
    )

    expect(subjectOf(at(placed, 'har', 'har/k-0'))).toBe('Patient/p-1')
    expect(identifiersOf(at(placed, 'lifelabs-pdf', 'lifelabs-pdf/k-0'))).toContain(
      `${CUSTOMER}|c-9`
    )
  })

  it('writes a stored person two formats only mention once, in the first claimed format', () => {
    const placed = applied(
      batchOf({
        'lifelabs-pdf': [request('rx-1', accountSubject)],
        dicom: [request('rx-2', accountSubject)],
      }),
      HashMap.make([ACCOUNT, LinkChoice.LinkToStoredResource({ resource: STORED_TYRA })])
    )

    expect(
      (['lifelabs-pdf', 'dicom'] as const).map((kind) =>
        placed[kind].decoded.sections.map((section) => section.title)
      )
    ).toEqual([['Resources', Placement.LINKED_SECTION_TITLE], ['Resources']])
    expect(
      (['lifelabs-pdf', 'dicom'] as const)
        .flatMap((kind) => DecodedFile.resources(placed[kind].decoded))
        .filter(({ resource }) => resource.id === 's-1')
    ).toHaveLength(1)
    expect([
      subjectOf(at(placed, 'lifelabs-pdf', 'lifelabs-pdf/k-0')),
      subjectOf(at(placed, 'dicom', 'dicom/k-0')),
    ]).toEqual(['Patient/s-1', 'Patient/s-1'])
  })

  it('fails as the stage does, naming the referent a choice cannot be followed for', () => {
    const batch = batchOf({ har: [patient('p-1', SOURCE_PATIENT)] })

    expect(
      runOnTestClock(
        Effect.either(applyIdentityMap(batch, HashMap.make([PERSON, LinkChoice.DontLink()])))
      )
    ).toMatchObject({
      _tag: 'Left',
      left: { _tag: 'InvalidLinkChoice', referentKey: PERSON, reason: 'NotAllowedForReferent' },
    })
  })
})

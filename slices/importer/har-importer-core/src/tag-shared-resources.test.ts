import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { type FhirResourceWithId, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import {
  HttpResponseKind,
  SourceDescriptor,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import type { PreviewedResponse } from './review.ts'
import { tagSharedResources } from './tag-shared-resources.ts'

const decodePatient = Schema.decodeUnknownSync(Patient.Schema)

const detachSample = DetachedResource.fromServerRecord('https://example.org/fhir')

/**
 * A Patient its source calls `id`, or gave no id when `null`, detached, whose
 * one given name says which copy it is.
 */
const patientNamed = (id: string | null, given: string): DetachedResource.Type =>
  detachSample(
    decodePatient({
      resourceType: 'Patient',
      ...(id === null ? {} : { id }),
      name: [{ given: [given] }],
    })
  )

/** A kind that only its name matters for: the fold matches a pick to its source by it. */
const kindNamed = (name: string): HttpResponseKind.HttpResponseKind<DetachedResource.Type> =>
  HttpResponseKind.make({
    name,
    tryRecognize: () => Option.none(),
    parse: () => Effect.succeed([]),
  })

/** Whether `resource` is a Patient, keeping whatever else its type says of it. */
const isPatient = (
  resource: DetachedResource.Type
): resource is DetachedResource.Detached<Patient.Type> => resource.resourceType === 'Patient'

/** Joins the two copies' names, earlier first, so the result shows what merged. */
const joinNames: SourceDescriptor.ResourceMerge<DetachedResource.Type> = (earlier, later) =>
  isPatient(earlier) && isPatient(later)
    ? { ...later, name: [...earlier.name, ...later.name] }
    : later

const display = { title: 'Sample', description: 'A sample source.' }

const mergingSource = SourceDescriptor.make<DetachedResource.Type>({
  name: 'merging',
  display,
  responseKinds: [kindNamed('MergingKind')],
  mergeResources: joinNames,
})

const plainSource = SourceDescriptor.make<DetachedResource.Type>({
  name: 'plain',
  display,
  responseKinds: [kindNamed('PlainKind')],
})

/** One response's preview: `resources` parsed by the kind named `kindName`. */
const previewOf = (
  responseId: string,
  kindName: string,
  resources: readonly DetachedResource.Type[]
): PreviewedResponse<DetachedResource.Type> => {
  return {
    ref: { id: responseId, url: `https://example.org/${responseId}` },
    pickKindName: Option.some(kindName),
    outcome: {
      _tag: 'resources',
      resources: resources.map((resource, index) => ({ key: `${responseId}:${index}`, resource })),
    },
  }
}

/** The id of the archive the previews are read from. */
const ARCHIVE_ID = '0:archive.har'

/** Each response's resources as `key` or `key identity` lines, to read a result at a glance. */
const taggedBy = (
  previews: readonly PreviewedResponse<DetachedResource.Type>[]
): readonly (readonly string[])[] =>
  previews.map((preview) =>
    preview.outcome._tag === 'resources'
      ? preview.outcome.resources.map(({ key, shared }) =>
          shared === undefined ? key : `${key} ${shared.identity}`
        )
      : []
  )

/** The identity `tagSharedResources` gives a Patient of `source` keyed `id` in the archive. */
const patientIdentity = (sourceName: string, id: string): string =>
  `${ARCHIVE_ID} ${sourceName} Patient https://example.org/fhir/Patient|${id}`

/** `record` adopted under `id`, as the import stage writes it. */
const adoptedAs = (record: DetachedResource.Type, id: string): FhirResourceWithId => ({
  ...record,
  id,
})

describe('tagSharedResources', () => {
  it("should tag only a merging source's resource that occurs more than once, keeping every copy", () => {
    const previews = [
      previewOf('req-0', 'MergingKind', [patientNamed('p1', 'first'), patientNamed('p2', 'only')]),
      previewOf('req-1', 'MergingKind', [patientNamed('p1', 'second')]),
    ]

    expect(
      taggedBy(tagSharedResources([mergingSource, plainSource], ARCHIVE_ID, previews))
    ).toEqual([
      [`req-0:0 ${patientIdentity('merging', 'p1')}`, 'req-0:1'],
      [`req-1:0 ${patientIdentity('merging', 'p1')}`],
    ])
  })

  it('should leave the previews unchanged for a source without a merge', () => {
    const previews = [
      previewOf('req-0', 'PlainKind', [patientNamed('p1', 'first')]),
      previewOf('req-1', 'PlainKind', [patientNamed('p1', 'second')]),
    ]

    expect(tagSharedResources([mergingSource, plainSource], ARCHIVE_ID, previews)).toEqual(previews)
  })

  it('should never tag two keyless records, which are each their own', () => {
    const previews = [
      previewOf('req-0', 'MergingKind', [patientNamed(null, 'first')]),
      previewOf('req-1', 'MergingKind', [patientNamed(null, 'second')]),
    ]

    expect(
      taggedBy(tagSharedResources([mergingSource, plainSource], ARCHIVE_ID, previews))
    ).toEqual([['req-0:0'], ['req-1:0']])
  })

  it("should never share one source's resource with another's under the same key", () => {
    const previews = [
      previewOf('req-0', 'MergingKind', [patientNamed('p1', 'merging')]),
      previewOf('req-1', 'PlainKind', [patientNamed('p1', 'plain')]),
    ]

    expect(
      taggedBy(tagSharedResources([mergingSource, plainSource], ARCHIVE_ID, previews))
    ).toEqual([['req-0:0'], ['req-1:0']])
  })

  it("should merge the adopted copies with the source's merge, under the earlier copy's id", () => {
    const previews = [
      previewOf('req-0', 'MergingKind', [patientNamed('p1', 'first')]),
      previewOf('req-1', 'MergingKind', [patientNamed('p1', 'second')]),
    ]
    const [first, second] = tagSharedResources([mergingSource], ARCHIVE_ID, previews).flatMap(
      (preview) => (preview.outcome._tag === 'resources' ? preview.outcome.resources : [])
    )
    const merged =
      first?.shared === undefined || second === undefined
        ? undefined
        : first.shared.merge(
            adoptedAs(first.resource, 'local-p1'),
            adoptedAs(second.resource, 'local-p1-later')
          )

    expect(
      merged?.resourceType === 'Patient'
        ? { id: merged.id, given: merged.name.flatMap((name) => name.given) }
        : merged
    ).toEqual({ id: 'local-p1', given: ['first', 'second'] })
  })
})

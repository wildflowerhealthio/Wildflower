import { detach, type DetachedResource, SystemFamily } from '@wildflowerhealthio/fhir-r4-adoption'
import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import {
  HttpResponseKind,
  SourceDescriptor,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { mergeSharedResources } from './merge-shared-resources.ts'
import type { PreviewedResponse } from './review.ts'

const decodePatient = Schema.decodeUnknownSync(Patient.Schema)

const detachSample = detach(
  SystemFamily.FixedAcrossResourceTypes({ system: 'https://example.org/fhir/sid/sample' })
)

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
): PreviewedResponse<never, DetachedResource.Type> => {
  const ref = { id: responseId, url: `https://example.org/${responseId}` }
  return {
    ref,
    recognized: { ref, candidates: [] },
    pickKindName: Option.some(kindName),
    outcome: {
      _tag: 'resources',
      resources: resources.map((resource, index) => ({ key: `${responseId}:${index}`, resource })),
    },
  }
}

/** Each response's resources as `key given…` lines, to read a result at a glance. */
const heldBy = (
  previews: readonly PreviewedResponse<never, DetachedResource.Type>[]
): readonly (readonly string[])[] =>
  previews.map((preview) =>
    preview.outcome._tag === 'resources'
      ? preview.outcome.resources.map(({ key, resource }) =>
          resource.resourceType === 'Patient'
            ? `${key} ${resource.name.flatMap((name) => name.given).join(' ')}`
            : key
        )
      : []
  )

describe('mergeSharedResources', () => {
  it("should hold a merging source's shared resource once, merged, where it first arrived", () => {
    const previews = [
      previewOf('req-0', 'MergingKind', [patientNamed('p1', 'first'), patientNamed('p2', 'only')]),
      previewOf('req-1', 'MergingKind', [patientNamed('p1', 'second')]),
    ]

    expect(heldBy(mergeSharedResources([mergingSource, plainSource], previews))).toEqual([
      ['req-0:0 first second', 'req-0:1 only'],
      [],
    ])
  })

  it('should leave the previews unchanged for a source without a merge', () => {
    const previews = [
      previewOf('req-0', 'PlainKind', [patientNamed('p1', 'first')]),
      previewOf('req-1', 'PlainKind', [patientNamed('p1', 'second')]),
    ]

    expect(mergeSharedResources([mergingSource, plainSource], previews)).toEqual(previews)
  })

  it('should never merge two keyless records, which are each their own', () => {
    const previews = [
      previewOf('req-0', 'MergingKind', [patientNamed(null, 'first')]),
      previewOf('req-1', 'MergingKind', [patientNamed(null, 'second')]),
    ]

    expect(heldBy(mergeSharedResources([mergingSource, plainSource], previews))).toEqual([
      ['req-0:0 first'],
      ['req-1:0 second'],
    ])
  })

  it('should keep the merged record detached', () => {
    const previews = [
      previewOf('req-0', 'MergingKind', [patientNamed('p1', 'first')]),
      previewOf('req-1', 'MergingKind', [patientNamed('p1', 'second')]),
    ]
    const [first] = mergeSharedResources([mergingSource], previews)

    expect(
      first?.outcome._tag === 'resources'
        ? first.outcome.resources.map(({ resource }) => resource.id)
        : []
    ).toEqual([null])
  })

  it("should never merge one source's resource with another's under the same key", () => {
    const previews = [
      previewOf('req-0', 'MergingKind', [patientNamed('p1', 'merging')]),
      previewOf('req-1', 'PlainKind', [patientNamed('p1', 'plain')]),
    ]

    expect(heldBy(mergeSharedResources([mergingSource, plainSource], previews))).toEqual([
      ['req-0:0 merging'],
      ['req-1:0 plain'],
    ])
  })
})

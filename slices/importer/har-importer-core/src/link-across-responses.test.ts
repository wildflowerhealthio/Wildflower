import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { Patient } from '@wildflowerhealthio/fhir-r4/resources'
import {
  HttpResponseKind,
  SourceDescriptor,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { linkAcrossSourceResponses } from './link-across-responses.ts'
import type { PreviewedResponse } from './review.ts'

const decodePatient = Schema.decodeUnknownSync(Patient.Schema)

const detachSample = DetachedResource.fromServerRecord('https://example.org/fhir')

/** A Patient whose one given name says which record it is, detached. */
const patientNamed = (given: string): DetachedResource.Type =>
  detachSample(decodePatient({ resourceType: 'Patient', id: given, name: [{ given: [given] }] }))

/** A kind that only its name matters for: the step matches a pick to its source by it. */
const kindNamed = (name: string): HttpResponseKind.HttpResponseKind<DetachedResource.Type> =>
  HttpResponseKind.make({
    name,
    tryRecognize: () => Option.none(),
    parse: () => Effect.succeed([]),
  })

/** `resource` with `linked` after its given names, so a result shows what the link rewrote. */
const markLinked = (resource: DetachedResource.Type): DetachedResource.Type =>
  resource.resourceType === 'Patient'
    ? {
        ...resource,
        name: resource.name.map((name) => ({ ...name, given: [...name.given, 'linked'] })),
      }
    : resource

const display = { title: 'Sample', description: 'A sample source.' }

/** A linking source that marks every record it is given, and the responses each call saw. */
const linkingSourceSeeing = (): {
  readonly source: SourceDescriptor.SourceDescriptor<DetachedResource.Type>
  readonly seen: (readonly SourceDescriptor.ResponseRecords<DetachedResource.Type>[])[]
} => {
  const seen: (readonly SourceDescriptor.ResponseRecords<DetachedResource.Type>[])[] = []
  const source = SourceDescriptor.make<DetachedResource.Type>({
    name: 'linking',
    display,
    responseKinds: [kindNamed('LinkingKind')],
    linkAcrossResponses: (responses) => {
      seen.push(responses)
      return responses.map((response) => ({
        ...response,
        records: response.records.map(markLinked),
      }))
    },
  })
  return { source, seen }
}

const plainSource = SourceDescriptor.make<DetachedResource.Type>({
  name: 'plain',
  display,
  responseKinds: [kindNamed('PlainKind')],
})

const urlOf = (responseId: string): string => `https://example.org/${responseId}`

/** One response's preview: `resources` parsed by the kind named `kindName`. */
const previewOf = (
  responseId: string,
  kindName: string,
  resources: readonly DetachedResource.Type[]
): PreviewedResponse<never, DetachedResource.Type> => {
  const ref = { id: responseId, url: urlOf(responseId) }
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

/** A response no enabled kind picked. */
const unpickedPreviewOf = (responseId: string): PreviewedResponse<never, DetachedResource.Type> => {
  const ref = { id: responseId, url: urlOf(responseId) }
  return {
    ref,
    recognized: { ref, candidates: [] },
    pickKindName: Option.none(),
    outcome: { _tag: 'noPick' },
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

describe('linkAcrossSourceResponses', () => {
  it("should rewrite a linking source's records in their place, under their review keys", () => {
    const { source } = linkingSourceSeeing()
    const previews = [
      previewOf('req-0', 'LinkingKind', [patientNamed('a'), patientNamed('b')]),
      previewOf('req-1', 'PlainKind', [patientNamed('c')]),
      previewOf('req-2', 'LinkingKind', [patientNamed('d')]),
    ]

    expect(heldBy(linkAcrossSourceResponses([source, plainSource], previews))).toEqual([
      ['req-0:0 a linked', 'req-0:1 b linked'],
      ['req-1:0 c'],
      ['req-2:0 d linked'],
    ])
  })

  it("should give a link its own source's parsed responses alone, in archive order, once", () => {
    const { source, seen } = linkingSourceSeeing()
    const previews = [
      previewOf('req-0', 'LinkingKind', [patientNamed('a')]),
      previewOf('req-1', 'PlainKind', [patientNamed('c')]),
      unpickedPreviewOf('req-2'),
      previewOf('req-3', 'LinkingKind', [patientNamed('d')]),
    ]

    linkAcrossSourceResponses([source, plainSource], previews)

    expect(seen).toEqual([
      [
        { url: urlOf('req-0'), records: [patientNamed('a')] },
        { url: urlOf('req-3'), records: [patientNamed('d')] },
      ],
    ])
  })

  it('should leave the previews unchanged when no source gives a link', () => {
    const previews = [
      previewOf('req-0', 'PlainKind', [patientNamed('a')]),
      unpickedPreviewOf('req-1'),
    ]

    expect(linkAcrossSourceResponses([plainSource], previews)).toEqual(previews)
  })

  it('should leave a preview with no records as it was', () => {
    const { source } = linkingSourceSeeing()
    const unpicked = unpickedPreviewOf('req-1')

    const [, linkedUnpicked] = linkAcrossSourceResponses(
      [source],
      [previewOf('req-0', 'LinkingKind', [patientNamed('a')]), unpicked]
    )

    expect(linkedUnpicked).toBe(unpicked)
  })
})

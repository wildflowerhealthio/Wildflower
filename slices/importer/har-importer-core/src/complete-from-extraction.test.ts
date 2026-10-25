import { type FhirResource, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import {
  HttpResponseKind,
  SourceDescriptor,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { Effect, Option, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { completeFromExtraction } from './complete-from-extraction.ts'
import type { PreviewedResponse } from './review.ts'

const decodePatient = Schema.decodeUnknownSync(Patient.Schema)

/** A Patient whose given names say what it was completed with. */
const patientNamed = (id: string, given: string): FhirResource =>
  decodePatient({ resourceType: 'Patient', id, name: [{ given: [given] }] })

/** A kind that only its name matters for: the fold matches a pick to its source by it. */
const kindNamed = (name: string): HttpResponseKind.HttpResponseKind<FhirResource> =>
  HttpResponseKind.make({
    name,
    tryRecognize: () => Option.none(),
    parse: () => Effect.succeed([]),
  })

/** Adds every Patient id the extraction holds to each Patient's given names. */
const nameEveryoneSeen: SourceDescriptor.ExtractionCompletion<FhirResource> = (extraction) =>
  Effect.succeed((resource) =>
    resource.resourceType === 'Patient'
      ? {
          ...resource,
          name: [
            ...resource.name,
            ...decodePatient({
              resourceType: 'Patient',
              name: [{ given: extraction.map((seen) => seen.id ?? '') }],
            }).name,
          ],
        }
      : resource
  )

const display = { title: 'Sample', description: 'A sample source.' }

const completingSource = SourceDescriptor.make<FhirResource>({
  name: 'completing',
  display,
  responseKinds: [kindNamed('CompletingKind'), kindNamed('OtherCompletingKind')],
  completeFromExtraction: nameEveryoneSeen,
})

const plainSource = SourceDescriptor.make<FhirResource>({
  name: 'plain',
  display,
  responseKinds: [kindNamed('PlainKind')],
})

/** One response's preview: `resources` parsed by the kind named `kindName`. */
const previewOf = (
  responseId: string,
  kindName: string,
  resources: readonly FhirResource[]
): PreviewedResponse<never, FhirResource> => {
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
  previews: readonly PreviewedResponse<never, FhirResource>[]
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

const complete = (
  previews: readonly PreviewedResponse<never, FhirResource>[]
): readonly PreviewedResponse<never, FhirResource>[] =>
  Effect.runSync(completeFromExtraction([completingSource, plainSource], previews))

describe('completeFromExtraction', () => {
  it("should complete each of a source's resources, under its key, from every response of that source", () => {
    const previews = [
      previewOf('req-0', 'CompletingKind', [patientNamed('p1', 'one')]),
      previewOf('req-1', 'OtherCompletingKind', [patientNamed('p2', 'two')]),
    ]

    expect(heldBy(complete(previews))).toEqual([['req-0:0 one p1 p2'], ['req-1:0 two p1 p2']])
  })

  it("should neither complete a source without a completion nor show its resources to another's", () => {
    const previews = [
      previewOf('req-0', 'CompletingKind', [patientNamed('p1', 'one')]),
      previewOf('req-1', 'PlainKind', [patientNamed('p2', 'two')]),
    ]

    const completed = complete(previews)

    expect(heldBy(completed)).toEqual([['req-0:0 one p1'], ['req-1:0 two']])
    expect(completed[1]).toBe(previews[1])
  })
})

import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { HttpResponseKind } from '@wildflowerhealthio/http-extraction-fundamentals'
import { makeHttpResponse } from '@wildflowerhealthio/http-extraction-fundamentals/test-helpers'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { fhirR4ResponseKinds } from './response-kinds.ts'

const kindNamed = (name: string): HttpResponseKind.HttpResponseKind<DetachedResource.Type> => {
  const found = fhirR4ResponseKinds.find((kind) => kind.name === name)
  if (found === undefined) throw new Error(`no kind named ${name}`)
  return found
}

const detachedFrom = (name: string, url: string, body: unknown): readonly DetachedResource.Type[] =>
  Effect.runSync(
    kindNamed(name).parse(
      makeHttpResponse({
        url,
        headers: [['content-type', 'application/fhir+json']],
        body: JSON.stringify(body),
      })
    )
  )

describe('fhirR4ResponseKinds', () => {
  it('contains the five kinds in plan order', () => {
    expect(fhirR4ResponseKinds.map((kind) => kind.name)).toEqual([
      'PatientResponseKind',
      'ObservationResponseKind',
      'ObservationListResponseKind',
      'DocumentReferenceResponseKind',
      'BinaryResponseKind',
    ])
  })

  it.each([
    { url: 'https://r4.example.org/baseR4/Binary/bin-1', kind: 'BinaryResponseKind' },
    { url: 'https://r4.example.org/baseR4/Binary/bin-1?_format=json', kind: 'BinaryResponseKind' },
    {
      url: 'https://r4.example.org/baseR4/DocumentReference/doc-1',
      kind: 'DocumentReferenceResponseKind',
    },
  ])('claims "$url" by $kind alone', ({ url, kind }) => {
    expect(
      fhirR4ResponseKinds
        .filter((candidate) => Option.isSome(candidate.tryRecognize(url, Option.some('GET'))))
        .map((candidate) => candidate.name)
    ).toEqual([kind])
  })

  it('detaches a JSON Binary keyless, its id dropped', () => {
    const root = 'https://r4.example.org/baseR4'
    const [binary] = detachedFrom('BinaryResponseKind', `${root}/Binary/bin-1`, {
      resourceType: 'Binary',
      id: 'bin-1',
      contentType: 'application/pdf',
      data: 'JVBERi0=',
    })
    expect(binary).toMatchObject({
      resourceType: 'Binary',
      id: null,
      contentType: 'application/pdf',
      data: 'JVBERi0=',
    })
  })

  it('fails a Binary read served as its raw content', () => {
    const result = Effect.runSync(
      Effect.either(
        kindNamed('BinaryResponseKind').parse(
          makeHttpResponse({
            url: 'https://r4.example.org/baseR4/Binary/bin-1',
            headers: [['content-type', 'application/pdf']],
            body: '%PDF-1.7',
          })
        )
      )
    )
    expect(result).toMatchObject({ _tag: 'Left', left: { _tag: 'ParseError' } })
  })

  it("detaches a DocumentReference's Binary attachment and reference to the server's URL for the Binary", () => {
    const root = 'https://r4.example.org/baseR4'
    const [document] = detachedFrom(
      'DocumentReferenceResponseKind',
      `${root}/DocumentReference/doc-1`,
      {
        resourceType: 'DocumentReference',
        id: 'doc-1',
        status: 'current',
        content: [{ attachment: { contentType: 'application/pdf', url: 'Binary/bin-1' } }],
        context: { related: [{ reference: `${root}/Binary/bin-1` }] },
      }
    )
    if (document?.resourceType !== 'DocumentReference') {
      throw new Error('expected a DocumentReference')
    }
    expect([document.content[0]?.attachment.url, document.context?.related[0]?.reference]).toEqual([
      `${root}/Binary/bin-1`,
      `${root}/Binary/bin-1`,
    ])
  })

  it("keys a detached resource in its type's system under its own URL's root", () => {
    const root = 'https://r4.example.org/baseR4'
    const [patient] = detachedFrom('PatientResponseKind', `${root}/Patient/pat-7`, {
      resourceType: 'Patient',
      id: 'pat-7',
    })
    expect(Option.flatMap(Option.fromNullable(patient), DetachedResource.keyOf)).toEqual(
      Option.some({ system: `${root}/Patient`, value: 'pat-7' })
    )
  })

  it('keys resources from different servers under their own roots, no shared system', () => {
    const rootA = 'https://a.example.org/baseR4'
    const rootB = 'https://b.example.org/fhir/R4'
    const [fromA] = detachedFrom('PatientResponseKind', `${rootA}/Patient/1`, {
      resourceType: 'Patient',
      id: '1',
    })
    const [fromB] = detachedFrom('ObservationResponseKind', `${rootB}/Observation/2`, {
      resourceType: 'Observation',
      id: '2',
      status: 'final',
      code: { text: 'Weight' },
    })
    expect(Option.flatMap(Option.fromNullable(fromA), DetachedResource.keyOf)).toEqual(
      Option.some({ system: `${rootA}/Patient`, value: '1' })
    )
    expect(Option.flatMap(Option.fromNullable(fromB), DetachedResource.keyOf)).toEqual(
      Option.some({ system: `${rootB}/Observation`, value: '2' })
    )
  })

  it("detaches every reference to the server's own records, relative or absolute", () => {
    const root = 'https://r4.example.org/baseR4'
    const [observation] = detachedFrom('ObservationResponseKind', `${root}/Observation/obs-1`, {
      resourceType: 'Observation',
      id: 'obs-1',
      status: 'final',
      code: { text: 'Weight' },
      subject: { reference: `${root}/Patient/pat-7` },
      performer: [{ reference: 'https://elsewhere.example/fhir/Practitioner/pr-1' }],
    })
    if (observation?.resourceType !== 'Observation') throw new Error('expected an Observation')
    expect(observation.id).toBeNull()
    expect(observation.subject).toMatchObject({
      reference: null,
      type: 'Patient',
      identifier: { system: new URL(`${root}/Patient`), value: 'pat-7' },
    })
    expect(observation.performer[0]?.reference).toBe(
      'https://elsewhere.example/fhir/Practitioner/pr-1'
    )
  })

  it('fails a response whose URL the kind does not claim', () => {
    const result = Effect.runSync(
      Effect.either(
        kindNamed('PatientResponseKind').parse(
          makeHttpResponse({
            url: 'https://r4.example.org/Observation/1',
            body: JSON.stringify({ resourceType: 'Patient', id: '1' }),
          })
        )
      )
    )
    expect(result).toMatchObject({ _tag: 'Left', left: { _tag: 'ParseError' } })
  })

  it('a record the server sent with no id detaches keyless', () => {
    const root = 'https://r4.example.org/baseR4'
    const [observation] = detachedFrom(
      'ObservationListResponseKind',
      `${root}/Observation?subject=pat-7`,
      {
        resourceType: 'Bundle',
        type: 'searchset',
        entry: [
          { resource: { resourceType: 'Observation', status: 'final', code: { text: 'Weight' } } },
        ],
      }
    )
    expect(observation?.id).toBeNull()
    expect(Option.flatMap(Option.fromNullable(observation), DetachedResource.keyOf)).toEqual(
      Option.none()
    )
  })
})

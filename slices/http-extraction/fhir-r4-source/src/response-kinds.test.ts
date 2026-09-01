import { Effect, Either } from 'effect'
import { type AdoptableEntity, localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { describe, expect, it } from 'vite-plus/test'

import { fhirR4ResponseKinds } from './response-kinds.ts'

const kindNamed = (name: string): HttpResponseKind.HttpResponseKind<FhirResource> => {
  const found = fhirR4ResponseKinds.find((kind) => kind.name === name)
  if (found === undefined) throw new Error(`no kind named ${name}`)
  return found
}

const parse = (name: string, url: string, body: unknown): readonly FhirResource[] =>
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
  it('HttpResponseKind<FhirResource> satisfies AdoptableEntity (the seam drift guard)', () => {
    const seam: readonly AdoptableEntity[] = fhirR4ResponseKinds
    expect(seam.length).toBe(fhirR4ResponseKinds.length)
  })

  it('contains the three kinds in plan order', () => {
    expect(fhirR4ResponseKinds.map((kind) => kind.name)).toEqual([
      'PatientResponseKind',
      'ObservationResponseKind',
      'ObservationListResponseKind',
    ])
  })

  it("keys a resource under its own URL's root", () => {
    const root = 'https://r4.example.org/baseR4'
    const [patient] = parse('PatientResponseKind', `${root}/Patient/pat-7`, {
      resourceType: 'Patient',
      id: 'pat-7',
    })
    expect(patient?.id).toBe(localResourceId(root, 'Patient', 'pat-7'))
  })

  it('keys resources from different servers under their own roots, no shared system', () => {
    const rootA = 'https://a.example.org/baseR4'
    const rootB = 'https://b.example.org/fhir/R4'
    const [fromA] = parse('PatientResponseKind', `${rootA}/Patient/1`, {
      resourceType: 'Patient',
      id: '1',
    })
    const [fromB] = parse('ObservationResponseKind', `${rootB}/Observation/2`, {
      resourceType: 'Observation',
      id: '2',
      status: 'final',
      code: { text: 'Weight' },
    })
    expect(fromA?.id).toBe(localResourceId(rootA, 'Patient', '1'))
    expect(fromB?.id).toBe(localResourceId(rootB, 'Observation', '2'))
  })

  it("rewrites a relative reference under the referring resource's own root", () => {
    const root = 'https://r4.example.org/baseR4'
    const [observation] = parse('ObservationResponseKind', `${root}/Observation/obs-1`, {
      resourceType: 'Observation',
      id: 'obs-1',
      status: 'final',
      code: { text: 'Weight' },
      subject: { reference: 'Patient/pat-7' },
    })
    if (observation?.resourceType !== 'Observation') throw new Error('expected an Observation')
    expect(observation.subject?.reference).toBe(
      `Patient/${localResourceId(root, 'Patient', 'pat-7')}`
    )
  })

  it('fails with a ParseError when handed a URL its kind does not recognize', () => {
    const result = Effect.runSync(
      Effect.either(
        kindNamed('PatientResponseKind').parse(
          makeHttpResponse({
            url: 'https://example.com/not-a-fhir-url',
            headers: [['content-type', 'application/fhir+json']],
            body: JSON.stringify({ resourceType: 'Patient', id: 'pat-7' }),
          })
        )
      )
    )
    expect(Either.isLeft(result)).toBe(true)
    if (Either.isLeft(result)) {
      expect(result.left._tag).toBe('ParseError')
    }
  })
})

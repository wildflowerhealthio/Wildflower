import { Effect, Either } from 'effect'
import { type AdoptableEntity, localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { describe, expect, it } from 'vite-plus/test'

import { fhirR4ResponseKinds } from './plan-entities.ts'
import { fhirR4SourceEntities } from './source-entities.ts'

const entityNamed = (
  entities: readonly HttpResponseKind.HttpResponseKind<FhirResource>[],
  name: string
): HttpResponseKind.HttpResponseKind<FhirResource> => {
  const found = entities.find((entity) => entity.name === name)
  if (found === undefined) throw new Error(`no entity named ${name}`)
  return found
}

/** Parse `body` at `url` through the importer entity named `name`. */
const parseImporter = (name: string, url: string, body: unknown): readonly FhirResource[] =>
  Effect.runSync(
    entityNamed(fhirR4SourceEntities, name).parse(
      makeHttpResponse({
        url,
        headers: [['content-type', 'application/fhir+json']],
        body: JSON.stringify(body),
      })
    )
  )

describe('fhirR4SourceEntities', () => {
  it('HttpResponseKind<FhirResource> satisfies AdoptableEntity (the seam drift guard)', () => {
    // `fhir-r4/identity` cannot import `http-extraction-fundamentals` (layering),
    // so `AdoptableEntity` restates `HttpResponseKind`'s shape structurally. This
    // package is the one that sees both types, and this typed assignment is where
    // the alignment is *deliberate* rather than coincidental: if either side's
    // shape drifts (a renamed field, a changed `tryRecognize` payload), this
    // line — and `source-entities.ts`'s own `.map(adoptUnderRecognizedRoot)` —
    // go red together, naming the seam.
    const seam: readonly AdoptableEntity[] = fhirR4ResponseKinds
    expect(seam.map((entity) => entity.name)).toEqual(
      fhirR4SourceEntities.map((entity) => entity.name)
    )
  })

  it('decodes through the shared tuple in plan order', () => {
    expect(fhirR4SourceEntities.map((entity) => entity.name)).toEqual([
      'PatientResponseKind',
      'ObservationResponseKind',
      'ObservationListResponseKind',
    ])
  })

  it("keys a resource under its own URL's root", () => {
    const root = 'https://r4.example.org/baseR4'
    const [patient] = parseImporter('PatientResponseKind', `${root}/Patient/pat-7`, {
      resourceType: 'Patient',
      id: 'pat-7',
    })
    expect(patient?.id).toBe(localResourceId(root, 'Patient', 'pat-7'))
  })

  it('keys resources from different servers under their own roots, no shared system', () => {
    const rootA = 'https://a.example.org/baseR4'
    const rootB = 'https://b.example.org/fhir/R4'
    const [fromA] = parseImporter('PatientResponseKind', `${rootA}/Patient/1`, {
      resourceType: 'Patient',
      id: '1',
    })
    const [fromB] = parseImporter('ObservationResponseKind', `${rootB}/Observation/2`, {
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
    const [observation] = parseImporter('ObservationResponseKind', `${root}/Observation/obs-1`, {
      resourceType: 'Observation',
      id: 'obs-1',
      status: 'final',
      code: { text: 'Weight' },
      subject: { reference: 'Patient/pat-7' },
    })
    if (observation?.resourceType !== 'Observation') throw new Error('expected an Observation')
    // The subject resolves to the id its Patient *would* adopt to under the same
    // root — so a same-server capture links up, a cross-server one dangles.
    expect(observation.subject?.reference).toBe(
      `Patient/${localResourceId(root, 'Patient', 'pat-7')}`
    )
  })

  it('fails with a ParseError when handed a URL its kind does not recognize', () => {
    // `adoptUnderRecognizedRoot` reads the identity off the kind's own
    // `tryRecognize`; a URL it does not claim has no root to key under, so the
    // wrapped parse fails rather than passing resources through un-adopted. In
    // the pipeline `Extraction.run` only ever hands a kind a URL it routed there,
    // so this arm guards a misuse, not a normal response.
    const result = Effect.runSync(
      Effect.either(
        entityNamed(fhirR4SourceEntities, 'PatientResponseKind').parse(
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

import { detach, DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import type { FhirResource } from '@wildflowerhealthio/fhir-r4/resources'
import {
  type HttpResponseKind,
  SystemFamily,
} from '@wildflowerhealthio/http-extraction-fundamentals'
import { makeHttpResponse } from '@wildflowerhealthio/http-extraction-fundamentals/test-helpers'
import { Effect, Option } from 'effect'
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

/** The family `name`'s `tryRecognize` mints for a GET of `url`. */
const familyOf = (name: string, url: string): Option.Option<SystemFamily.Type | undefined> =>
  Option.map(
    kindNamed(name).tryRecognize(url, Option.some('GET')),
    ({ systemFamily }) => systemFamily
  )

/** `name`'s parse of `body` at `url`, each resource detached under the family it mints there. */
const detachedFrom = (
  name: string,
  url: string,
  body: unknown
): readonly DetachedResource.Type[] => {
  const family = Option.getOrThrow(familyOf(name, url))
  if (family === undefined) throw new Error(`${name} mints no family at ${url}`)
  return parse(name, url, body).map(detach(family))
}

describe('fhirR4ResponseKinds', () => {
  it('contains the three kinds in plan order', () => {
    expect(fhirR4ResponseKinds.map((kind) => kind.name)).toEqual([
      'PatientResponseKind',
      'ObservationResponseKind',
      'ObservationListResponseKind',
    ])
  })

  it("mints the FHIR style under its own URL's root", () => {
    const root = 'https://r4.example.org/baseR4'
    expect(familyOf('PatientResponseKind', `${root}/Patient/pat-7`)).toEqual(
      Option.some(SystemFamily.FhirStyleBaseUrl({ baseUrl: root }))
    )
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

  it('parses every id and reference as the server spelled it', () => {
    const root = 'https://r4.example.org/baseR4'
    const [observation] = parse('ObservationResponseKind', `${root}/Observation/obs-1`, {
      resourceType: 'Observation',
      id: 'obs-1',
      status: 'final',
      code: { text: 'Weight' },
      subject: { reference: `${root}/Patient/pat-7` },
      performer: [{ reference: 'https://elsewhere.example/fhir/Practitioner/pr-1' }],
    })
    if (observation?.resourceType !== 'Observation') throw new Error('expected an Observation')
    expect(observation.id).toBe('obs-1')
    expect(observation.subject?.reference).toBe(`${root}/Patient/pat-7`)
    expect(observation.performer[0]?.reference).toBe(
      'https://elsewhere.example/fhir/Practitioner/pr-1'
    )
  })

  it('a record the server sent with no id parses with none, and detaches keyless', () => {
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

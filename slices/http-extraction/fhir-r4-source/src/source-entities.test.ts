import { Effect } from 'effect'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { EntityDefinition } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { describe, expect, it } from 'vite-plus/test'

import { fhirR4SourceEntities } from './source-entities.ts'

const entityNamed = (
  entities: readonly EntityDefinition.EntityDefinition<FhirResource>[],
  name: string
): EntityDefinition.EntityDefinition<FhirResource> => {
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
  it('decodes through the shared tuple in plan order', () => {
    expect(fhirR4SourceEntities.map((entity) => entity.name)).toEqual([
      'PatientEntity',
      'ObservationEntity',
      'ObservationListEntity',
    ])
  })

  it("keys a resource under its own URL's root", () => {
    const root = 'https://r4.example.org/baseR4'
    const [patient] = parseImporter('PatientEntity', `${root}/Patient/pat-7`, {
      resourceType: 'Patient',
      id: 'pat-7',
    })
    expect(patient?.id).toBe(localResourceId(root, 'Patient', 'pat-7'))
  })

  it('keys resources from different servers under their own roots, no shared system', () => {
    const rootA = 'https://a.example.org/baseR4'
    const rootB = 'https://b.example.org/fhir/R4'
    const [fromA] = parseImporter('PatientEntity', `${rootA}/Patient/1`, {
      resourceType: 'Patient',
      id: '1',
    })
    const [fromB] = parseImporter('ObservationEntity', `${rootB}/Observation/2`, {
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
    const [observation] = parseImporter('ObservationEntity', `${root}/Observation/obs-1`, {
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
})

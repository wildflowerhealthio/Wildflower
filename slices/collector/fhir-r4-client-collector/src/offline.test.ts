import type { EntityDefinition } from 'collector-fundamentals/model'
import type { Replay } from 'collector-fundamentals/replay'
import { makeRemoteResponse } from 'collector-fundamentals/test-helpers'
import { Arbitrary, DateTime, Effect, Option } from 'effect'
import * as fc from 'fast-check'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'

import { InstanceConfig, scrapingPlan } from './config.ts'
import { fhirR4Recognizer, fhirRootOf, offlineEntities } from './offline.ts'

/** The plan factory ignores its run id; a fixed one keeps builds comparable. */
const FIXED_RUN_ID = 'test-run'

const utf8 = new TextEncoder()

/**
 * A minimal {@link Replay.ReplayResponse} for the recognizer, which reads only
 * `url` — everything else is filler the shape requires.
 */
const replay = (url: string, body = '{}'): Replay.ReplayResponse => ({
  id: `req:${url}`,
  url,
  status: 200,
  statusText: 'OK',
  headers: [['content-type', 'application/fhir+json']],
  startedAt: DateTime.unsafeMake('2026-02-02T00:00:00.000Z'),
  body: utf8.encode(body),
  bodyAbsent: false,
})

const entityNamed = (
  entities: readonly EntityDefinition.EntityDefinition<FhirResource>[],
  name: string
): EntityDefinition.EntityDefinition<FhirResource> => {
  const found = entities.find((entity) => entity.name === name)
  if (found === undefined) throw new Error(`no entity named ${name}`)
  return found
}

/** Parse `body` at `url` through the offline entity named `name`. */
const parseOffline = (name: string, url: string, body: unknown): readonly FhirResource[] =>
  Effect.runSync(
    entityNamed(offlineEntities, name).parse(
      makeRemoteResponse({
        url,
        headers: [['content-type', 'application/fhir+json']],
        body: JSON.stringify(body),
      })
    )
  )

describe('fhirR4Recognizer', () => {
  it('is a middle-specificity recognizer named fhir-r4', () => {
    expect(fhirR4Recognizer.name).toBe('fhir-r4')
    expect(fhirR4Recognizer.specificity).toBe(50)
  })

  it("claims our own emit shape — the plan's Patient and Observation URLs", () => {
    const root = 'https://r4.example.org/baseR4'
    expect(
      fhirR4Recognizer.claims([
        replay(`${root}/Patient/8c0f46f4-dd7b-4a5f-bd35-f0f41a2f8882?_format=json`),
        replay(`${root}/Observation?subject%3APatient=8c0f46f4&_count=250&_format=json`),
      ])
    ).toBe(true)
  })

  it('claims a Chrome-style HAR capture of a FHIR server amid browser noise', () => {
    // A single FHIR resource URL, interleaved with the fonts/analytics/asset
    // traffic a browser's HAR export carries, is enough to claim.
    expect(
      fhirR4Recognizer.claims([
        replay('https://fonts.googleapis.com/css2?family=Inter'),
        replay('https://www.google-analytics.com/g/collect?v=2'),
        replay('https://ehr.example.com/interconnect-fhir-oauth/api/FHIR/R4/Patient/eXYZ'),
        replay('https://ehr.example.com/assets/app.7f3c.js'),
      ])
    ).toBe(true)
  })

  it('claims a single Observation resource and an Observation search', () => {
    const root = 'https://hapi.fhir.org/baseR4'
    expect(fhirR4Recognizer.claims([replay(`${root}/Observation/obs-1`)])).toBe(true)
    expect(fhirR4Recognizer.claims([replay(`${root}/Observation?patient=1`)])).toBe(true)
  })

  it('declines HTML portal traffic', () => {
    expect(
      fhirR4Recognizer.claims([
        replay('https://portal.example.com/carebook/summary', '<!doctype html><html></html>'),
        replay('https://portal.example.com/login'),
        replay('https://portal.example.com/api/prescriptions'),
      ])
    ).toBe(false)
  })

  it('declines arbitrary JSON APIs', () => {
    expect(
      fhirR4Recognizer.claims([
        replay('https://api.example.com/v2/users/1', '{"name":"x"}'),
        replay('https://api.github.com/repos/owner/name'),
        replay('https://example.com/Patients/1'), // plural — not the FHIR resource
      ])
    ).toBe(false)
  })

  it('declines an empty capture', () => {
    expect(fhirR4Recognizer.claims([])).toBe(false)
  })

  test("property: claims any capture containing the plan's configured URLs", () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const safeId = encodeURIComponent(config.patientId)
        expect(
          fhirR4Recognizer.claims([
            replay(`${config.rootUrl}/Patient/${safeId}?_format=json`),
            replay(`${config.rootUrl}/Observation?subject%3APatient=${safeId}`),
          ])
        ).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('offlineEntities', () => {
  it('decodes through the shared tuple in plan order', () => {
    expect(offlineEntities.map((entity) => entity.name)).toEqual([
      'PatientEntity',
      'ObservationEntity',
      'ObservationListEntity',
    ])
  })

  it("keys a resource under its own URL's root", () => {
    const root = 'https://r4.example.org/baseR4'
    const [patient] = parseOffline('PatientEntity', `${root}/Patient/pat-7`, {
      resourceType: 'Patient',
      id: 'pat-7',
    })
    expect(patient?.id).toBe(localResourceId(root, 'Patient', 'pat-7'))
  })

  it('keys resources from different servers under their own roots, no shared system', () => {
    const rootA = 'https://a.example.org/baseR4'
    const rootB = 'https://b.example.org/fhir/R4'
    const [fromA] = parseOffline('PatientEntity', `${rootA}/Patient/1`, {
      resourceType: 'Patient',
      id: '1',
    })
    const [fromB] = parseOffline('ObservationEntity', `${rootB}/Observation/2`, {
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
    const [observation] = parseOffline('ObservationEntity', `${root}/Observation/obs-1`, {
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

  it('matches the live plan when a resource is captured from its configured root', () => {
    const rootUrl = 'https://r4.example.org/baseR4'
    const body = { resourceType: 'Patient', id: 'pat-7' }
    const [offlinePatient] = parseOffline('PatientEntity', `${rootUrl}/Patient/pat-7`, body)
    const [livePatient] = Effect.runSync(
      entityNamed(
        scrapingPlan({ _tag: 'fhir-r4', rootUrl, patientId: 'pat-7' }, FIXED_RUN_ID)
          .entityDefinitions,
        'PatientEntity'
      ).parse(
        makeRemoteResponse({
          url: `${rootUrl}/Patient/pat-7`,
          headers: [['content-type', 'application/fhir+json']],
          body: JSON.stringify(body),
        })
      )
    )
    expect(offlinePatient?.id).toBe(localResourceId(rootUrl, 'Patient', 'pat-7'))
    expect(offlinePatient?.id).toBe(livePatient?.id)
  })

  test('property: keys any configured rootUrl under that same root', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const [patient] = parseOffline(
          'PatientEntity',
          `${config.rootUrl}/Patient/${encodeURIComponent(config.patientId)}`,
          { resourceType: 'Patient', id: config.patientId }
        )
        expect(patient?.id).toBe(localResourceId(config.rootUrl, 'Patient', config.patientId))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('fhirRootOf', () => {
  it('reads the root off a Patient URL, honoring a base path', () => {
    expect(fhirRootOf('https://r4.example.org/baseR4/Patient/pat-7?_format=json')).toEqual(
      Option.some('https://r4.example.org/baseR4')
    )
  })

  it('reads the root off an Observation resource and an Observation search', () => {
    const root = 'https://hapi.fhir.org/baseR4'
    expect(fhirRootOf(`${root}/Observation/obs-1`)).toEqual(Option.some(root))
    expect(fhirRootOf(`${root}/Observation?subject%3APatient=1&_count=250`)).toEqual(
      Option.some(root)
    )
  })

  it('honors an Epic-style deep base path', () => {
    const root = 'https://ehr.example.com/interconnect-fhir-oauth/api/FHIR/R4'
    expect(fhirRootOf(`${root}/Observation/obs-9`)).toEqual(Option.some(root))
  })

  it('is none for a URL that names no FHIR resource', () => {
    expect(fhirRootOf('https://portal.example.com/login')).toEqual(Option.none())
    expect(fhirRootOf('https://api.example.com/users/1')).toEqual(Option.none())
    expect(fhirRootOf('https://example.com/Patients/1')).toEqual(Option.none())
  })

  /**
   * A rootUrl whose own path already carries a `Patient`/`Observation` segment
   * makes root extraction ambiguous (the appended segment could be read as an
   * id under the earlier one) — a pathological base no real server uses. Filter
   * those out so the property tests the honest case.
   */
  const hasResourceSegment = (rootUrl: string): boolean =>
    new URL(rootUrl).pathname
      .split('/')
      .some((segment) => segment === 'Patient' || segment === 'Observation')

  test('property: recovers the generated root from a resource URL built on it', () => {
    fc.assert(
      fc.property(
        Arbitrary.make(InstanceConfig).filter((config) => !hasResourceSegment(config.rootUrl)),
        (config) => {
          const safeId = encodeURIComponent(config.patientId)
          expect(fhirRootOf(`${config.rootUrl}/Patient/${safeId}?_format=json`)).toEqual(
            Option.some(config.rootUrl)
          )
          expect(fhirRootOf(`${config.rootUrl}/Observation?subject%3APatient=${safeId}`)).toEqual(
            Option.some(config.rootUrl)
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

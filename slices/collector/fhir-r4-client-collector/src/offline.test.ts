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
import { fhirR4Recognizer, inferFhirRootUrl, offlineEntities } from './offline.ts'

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
  it('returns the three entities in plan order', () => {
    expect(offlineEntities('https://r4.example.org/baseR4').map((entity) => entity.name)).toEqual([
      'PatientEntity',
      'ObservationEntity',
      'ObservationListEntity',
    ])
  })

  it("mirrors the live plan's entityDefinitions for a rootUrl", () => {
    const config = {
      _tag: 'fhir-r4',
      rootUrl: 'https://r4.example.org/baseR4',
      patientId: 'pat-7',
    } as const
    // Same style as the plan-identity test: adopting the shared tuple through
    // the same source yields entities that deep-equal the live plan's, the
    // memoized `parse` closures compared by identity.
    expect(offlineEntities(config.rootUrl)).toEqual(
      scrapingPlan(config, FIXED_RUN_ID).entityDefinitions
    )
  })

  test("property: reuses the live plan's entities for any configured rootUrl", () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        expect(offlineEntities(config.rootUrl)).toEqual(
          scrapingPlan(config, FIXED_RUN_ID).entityDefinitions
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('re-keys a parsed resource to the same local id as the live plan', () => {
    const rootUrl = 'https://r4.example.org/baseR4'
    const parsePatient = (
      entities: readonly EntityDefinition.EntityDefinition<FhirResource>[]
    ): FhirResource | undefined =>
      Effect.runSync(
        entityNamed(entities, 'PatientEntity').parse(
          makeRemoteResponse({
            url: `${rootUrl}/Patient/pat-7`,
            headers: [['content-type', 'application/fhir+json']],
            body: JSON.stringify({ resourceType: 'Patient', id: 'pat-7' }),
          })
        )
      )[0]

    const offlinePatient = parsePatient(offlineEntities(rootUrl))
    const livePatient = parsePatient(
      scrapingPlan({ _tag: 'fhir-r4', rootUrl, patientId: 'pat-7' }, FIXED_RUN_ID).entityDefinitions
    )

    expect(offlinePatient?.id).toBe(localResourceId(rootUrl, 'Patient', 'pat-7'))
    expect(offlinePatient?.id).toBe(livePatient?.id)
  })
})

describe('inferFhirRootUrl', () => {
  it('infers the root from FHIR URLs, honoring a base path', () => {
    const root = 'https://r4.example.org/baseR4'
    expect(
      inferFhirRootUrl([
        `${root}/Patient/pat-7?_format=json`,
        `${root}/Observation?subject%3APatient=pat-7&_count=250`,
      ])
    ).toEqual(Option.some(root))
  })

  it('honors an Epic-style deep base path', () => {
    const root = 'https://ehr.example.com/interconnect-fhir-oauth/api/FHIR/R4'
    expect(inferFhirRootUrl([`${root}/Observation/obs-9`])).toEqual(Option.some(root))
  })

  it('returns none when no URL names a FHIR resource', () => {
    expect(
      inferFhirRootUrl(['https://portal.example.com/login', 'https://api.example.com/users/1'])
    ).toEqual(Option.none())
    expect(inferFhirRootUrl([])).toEqual(Option.none())
  })

  it('picks the most frequent root when a capture disagrees', () => {
    const a = 'https://a.example.org/baseR4'
    const b = 'https://b.example.org/fhir'
    expect(inferFhirRootUrl([`${a}/Patient/1`, `${b}/Patient/2`, `${a}/Observation/3`])).toEqual(
      Option.some(a)
    )
  })

  it('breaks a frequency tie toward the earliest-seen root', () => {
    const a = 'https://a.example.org/baseR4'
    const b = 'https://b.example.org/fhir'
    expect(inferFhirRootUrl([`${b}/Patient/1`, `${a}/Patient/2`])).toEqual(Option.some(b))
    expect(inferFhirRootUrl([`${a}/Patient/1`, `${b}/Patient/2`])).toEqual(Option.some(a))
  })

  /**
   * A rootUrl whose own path already carries a `Patient`/`Observation` segment
   * makes inference self-ambiguous (the appended segment could be read as an
   * id under the earlier one) — a pathological base no real server uses. Filter
   * those out so the property tests the honest case.
   */
  const hasResourceSegment = (rootUrl: string): boolean =>
    new URL(rootUrl).pathname
      .split('/')
      .some((segment) => segment === 'Patient' || segment === 'Observation')

  test('property: recovers the generated root from entity-matching URLs built on it', () => {
    fc.assert(
      fc.property(
        Arbitrary.make(InstanceConfig).filter((config) => !hasResourceSegment(config.rootUrl)),
        (config) => {
          const safeId = encodeURIComponent(config.patientId)
          const urls = [
            `${config.rootUrl}/Patient/${safeId}?_format=json`,
            `${config.rootUrl}/Observation/obs-1`,
            `${config.rootUrl}/Observation?subject%3APatient=${safeId}&_count=250`,
          ]
          expect(inferFhirRootUrl(urls)).toEqual(Option.some(config.rootUrl))
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

import { makeCollectorHttpResponse } from 'collector-fundamentals/test-helpers'
import { Arbitrary, DateTime, Effect, Option } from 'effect'
import * as fc from 'fast-check'
import { fhirR4Source, fhirR4SourceEntities, fhirRootOf } from 'fhir-r4-source'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind, Extraction } from 'http-extraction-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { InstanceConfig, scrapingPlan } from './config.ts'

/**
 * Parity between this collector's live plan and `fhir-r4-source`'s extraction
 * surface: the two consume the same entity tuple, and a resource captured from
 * its configured root must carry the byte-identical id either way. These tests
 * live here, not in `fhir-r4-source`, because they are the only ones that
 * need the live `InstanceConfig`/`scrapingPlan` — the source's own behaviour is
 * pinned in that package's `source.test.ts` and `source-entities.test.ts`.
 */

/** The plan factory ignores its run id; a fixed one keeps builds comparable. */
const FIXED_RUN_ID = 'test-run'

const utf8 = new TextEncoder()

/**
 * A minimal {@link Extraction.Input} for the source's `claims`, which reads
 * only `url` — everything else is filler the shape requires.
 */
const input = (url: string, body = '{}'): Extraction.Input => ({
  id: `req:${url}`,
  url,
  status: 200,
  statusText: 'OK',
  headers: [['content-type', 'application/fhir+json']],
  startedAt: DateTime.unsafeMake('2026-02-02T00:00:00.000Z'),
  body: utf8.encode(body),
  bodyAbsent: false,
})

const responseKindNamed = (
  responseKinds: readonly HttpResponseKind.HttpResponseKind<FhirResource>[],
  name: string
): HttpResponseKind.HttpResponseKind<FhirResource> => {
  const found = responseKinds.find((responseKind) => responseKind.name === name)
  if (found === undefined) throw new Error(`no response kind named ${name}`)
  return found
}

/** Parse `body` at `url` through the importer entity named `name`. */
const parseImporter = (name: string, url: string, body: unknown): readonly FhirResource[] =>
  Effect.runSync(
    responseKindNamed(fhirR4SourceEntities, name).parse(
      makeCollectorHttpResponse({
        url,
        headers: [['content-type', 'application/fhir+json']],
        body: JSON.stringify(body),
      })
    )
  )

describe('fhirR4Source.claims against the live config', () => {
  test("property: claims any capture containing the plan's configured URLs", () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const safeId = encodeURIComponent(config.patientId)
        expect(
          fhirR4Source.claims([
            input(`${config.rootUrl}/Patient/${safeId}?_format=json`),
            input(`${config.rootUrl}/Observation?subject%3APatient=${safeId}`),
          ])
        ).toBe(true)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('fhirR4SourceEntities against the live plan', () => {
  test('matches the live plan when a resource is captured from its configured root', () => {
    const rootUrl = 'https://r4.example.org/baseR4'
    const body = { resourceType: 'Patient', id: 'pat-7' }
    const [importedPatient] = parseImporter('PatientResponseKind', `${rootUrl}/Patient/pat-7`, body)
    const [livePatient] = Effect.runSync(
      responseKindNamed(
        scrapingPlan({ _tag: 'fhir-r4', rootUrl, patientId: 'pat-7' }, FIXED_RUN_ID).responseKinds,
        'PatientResponseKind'
      ).parse(
        makeCollectorHttpResponse({
          url: `${rootUrl}/Patient/pat-7`,
          headers: [['content-type', 'application/fhir+json']],
          body: JSON.stringify(body),
        })
      )
    )
    expect(importedPatient?.id).toBe(localResourceId(rootUrl, 'Patient', 'pat-7'))
    expect(importedPatient?.id).toBe(livePatient?.id)
  })

  test('property: keys any configured rootUrl under that same root', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const [patient] = parseImporter(
          'PatientResponseKind',
          `${config.rootUrl}/Patient/${encodeURIComponent(config.patientId)}`,
          { resourceType: 'Patient', id: config.patientId }
        )
        expect(patient?.id).toBe(localResourceId(config.rootUrl, 'Patient', config.patientId))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('fhirRootOf against the live config', () => {
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

import { makeCollectorHttpResponse } from 'collector-fundamentals/test-helpers'
import { Arbitrary, Effect, Option } from 'effect'
import * as fc from 'fast-check'
import {
  fhirR4SourceEntities,
  ObservationListResponseKind,
  PatientResponseKind,
} from 'fhir-r4-source'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { InstanceConfig, scrapingPlan } from './config.ts'

/**
 * Parity between this collector's live plan and `fhir-r4-source`'s extraction
 * surface: the two consume the same entity tuple, and a resource captured from
 * its configured root must carry the byte-identical id either way. These tests
 * live here, not in `fhir-r4-source`, because they are the only ones that
 * need the live `InstanceConfig`/`scrapingPlan` — the source's own behaviour is
 * pinned in that package's `source-entities.test.ts` and the response-kind
 * tests.
 */

/** The plan factory ignores its run id; a fixed one keeps builds comparable. */
const FIXED_RUN_ID = 'test-run'

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

/**
 * A rootUrl whose own path already carries a `Patient`/`Observation` segment
 * makes root extraction ambiguous (the appended segment could be read as an id
 * under the earlier one) — a pathological base no real server uses. Filter those
 * out so the property tests the honest case.
 */
const hasResourceSegment = (rootUrl: string): boolean =>
  new URL(rootUrl).pathname
    .split('/')
    .some((segment) => segment === 'Patient' || segment === 'Observation')

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

describe("tryRecognize mints the configured root as the resource's source", () => {
  // The load-bearing guard for Phase 2's keying switch: a resource captured from
  // a configured `rootUrl` recognizes with `source.system === rootUrl` (and
  // `baseUrl` likewise), so the derived id equals the live-adopted one. When
  // Phase 2 drops `adoptSourceIdentity` in favour of the pre-adopted kinds, the
  // live==archive assertions above become tautologies and this property is the
  // only real guard left on that switch.
  test('property: PatientResponseKind recognizes the configured root as its source', () => {
    fc.assert(
      fc.property(
        Arbitrary.make(InstanceConfig).filter((config) => !hasResourceSegment(config.rootUrl)),
        (config) => {
          const safeId = encodeURIComponent(config.patientId)
          const recognized = PatientResponseKind.tryRecognize(
            `${config.rootUrl}/Patient/${safeId}?_format=json`
          )
          expect(Option.isSome(recognized)).toBe(true)
          const source = Option.getOrThrow(recognized).source
          expect(source?.system).toBe(config.rootUrl)
          expect(source?.baseUrl).toBe(config.rootUrl)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: ObservationListResponseKind recognizes the configured root as its source', () => {
    fc.assert(
      fc.property(
        Arbitrary.make(InstanceConfig).filter((config) => !hasResourceSegment(config.rootUrl)),
        (config) => {
          const safeId = encodeURIComponent(config.patientId)
          const recognized = ObservationListResponseKind.tryRecognize(
            `${config.rootUrl}/Observation?subject%3APatient=${safeId}`
          )
          expect(Option.isSome(recognized)).toBe(true)
          const source = Option.getOrThrow(recognized).source
          expect(source?.system).toBe(config.rootUrl)
          expect(source?.baseUrl).toBe(config.rootUrl)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

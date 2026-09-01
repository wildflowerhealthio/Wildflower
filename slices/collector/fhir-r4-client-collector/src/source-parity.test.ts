import { makeCollectorHttpResponse } from 'collector-fundamentals/test-helpers'
import { Arbitrary, Effect, Option } from 'effect'
import * as fc from 'fast-check'
import { fhirR4Source } from 'fhir-r4-source'
import { ObservationListResponseKind, PatientResponseKind } from 'fhir-r4-source/test-helpers'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import type { HttpResponseKind } from 'http-extraction-fundamentals'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { InstanceConfig, scrapingPlan } from './config.ts'

/**
 * Parity between this collector's live plan and `fhir-r4-source`'s extraction
 * surface. Post-unification (Phase 2) the two are the **same** pre-adopted
 * array: the live plan's `responseKinds` IS `fhirR4Source.responseKinds` by
 * reference, so a resource decodes and keys identically live and in an archive by
 * construction rather than by coincidence. What is left to pin here — the only
 * claims that are not tautologies — is that reference identity itself, that the
 * shared entities key a resource under the root of the URL it arrived on, and
 * the property the live-keying switch actually rests on: a capture from a
 * configured `rootUrl` recognizes with `source.system === rootUrl` (and
 * `baseUrl` likewise). These live here, not in `fhir-r4-source`, because they
 * are the only ones that need the live `InstanceConfig`/`scrapingPlan`.
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

/** Parse `body` at `url` through the shared source entity named `name`. */
const parseSource = (name: string, url: string, body: unknown): readonly FhirResource[] =>
  Effect.runSync(
    responseKindNamed(fhirR4Source.responseKinds, name).parse(
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

describe('the live plan shares fhir-r4-source pre-adopted entities', () => {
  test('the plan responseKinds IS fhirR4Source.responseKinds (same single definition)', () => {
    // The point of the unification: no separate live-adoption wrapper, so the
    // live plan and an archive import extract with the exact same frozen array.
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        expect(scrapingPlan(config, FIXED_RUN_ID).responseKinds).toBe(fhirR4Source.responseKinds)
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  test('keys a resource captured from its configured root under that root', () => {
    const rootUrl = 'https://r4.example.org/baseR4'
    const body = { resourceType: 'Patient', id: 'pat-7' }
    const [patient] = parseSource('PatientResponseKind', `${rootUrl}/Patient/pat-7`, body)
    expect(patient?.id).toBe(localResourceId(rootUrl, 'Patient', 'pat-7'))
  })

  test('property: keys any configured rootUrl under that same root', () => {
    fc.assert(
      fc.property(Arbitrary.make(InstanceConfig), (config) => {
        const [patient] = parseSource(
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
  // `baseUrl` likewise), so the derived id equals the one the old
  // configured-constant keying gave it. With the live-adoption wrapper gone, the
  // live==archive assertions above are reference-identical by construction, so
  // this property is the only real guard left on that switch.
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

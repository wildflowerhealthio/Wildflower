import { Effect, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { localResourceId } from 'fhir-r4/identity'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'
import { type TraceBody, type TraceExchange } from 'web-trace-core'
import { HarFromJson, emitHar } from 'web-trace-core/har'
import { CAPTURE_FLOOR, arbitraries, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

import chromeHar from './fixtures/chrome-fhir-capture.har.json' with { type: 'json' }
import type { ImportPreview, Preview } from './import-preview.ts'
import { runHarImport } from './run-har-import.ts'

/**
 * Covers the read half of the import flow: a HAR archive in, an
 * {@link ImportPreview} out. Two fixture routes reach the same assertions — a
 * HAR built through `web-trace-core`'s own `emitHar` from constructed exchanges,
 * and a committed Chrome DevTools export — so the pipeline is exercised against
 * both an archive shaped exactly like ours and a foreign one carrying browser
 * noise and vendor extras.
 *
 * The critical structural property is here too: `runHarImport` requires no
 * services, so the FHIR write client is unreachable from a preview — asserted at
 * the type level and at runtime.
 */

/** A base64 SHA-256; the importer never reads it, so any valid digest serves. */
const ANY_HASH = 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o='

/** A stored FHIR-JSON body, as the capture side would hold it. */
const storedJson = (value: unknown): TraceBody => ({
  _tag: 'StoredBody',
  contentType: 'application/fhir+json',
  data: jsonBody(value),
  size: JSON.stringify(value).length,
  hash: ANY_HASH,
})

/** A minimal FHIR `Patient`. */
const patient = (id: string): Record<string, unknown> => ({ resourceType: 'Patient', id })

/** A minimal FHIR `Observation`. */
const observation = (id: string): Record<string, unknown> => ({
  resourceType: 'Observation',
  id,
  status: 'final',
  code: { text: 'Body Weight' },
})

/** A FHIR searchset `Bundle` wrapping the given resources. */
const searchset = (...resources: readonly unknown[]): Record<string, unknown> => ({
  resourceType: 'Bundle',
  type: 'searchset',
  total: resources.length,
  entry: resources.map((resource) => ({ resource })),
})

const encodeHar = Schema.encode(HarFromJson)

/** Serialize constructed exchanges into `.har` file text through `emitHar`. */
const harTextOf = (exchanges: readonly TraceExchange[]): string =>
  Effect.runSync(encodeHar(emitHar(exchanges, { sessionId: 'test-session' })))

/** Run a preview, surfacing a HAR `ParseError` as a thrown defect (none expected). */
const runPreview = (harText: string): ImportPreview => Effect.runSync(runHarImport(harText))

/** Assert the preview claimed and narrow it to {@link Preview}. */
const expectPreview = (preview: ImportPreview): Preview => {
  expect(preview._tag).toBe('Preview')
  if (preview._tag !== 'Preview') throw new Error('expected a Preview')
  return preview
}

describe('runHarImport', () => {
  describe('a Patient read + Observation searchset', () => {
    it('previews re-keyed resources from an emitHar archive', () => {
      const root = 'https://r4.example.org/baseR4'
      const preview = expectPreview(
        runPreview(
          harTextOf([
            traceExchange({
              requestId: 'req-0',
              url: `${root}/Patient/pat-7?_format=json`,
              headers: [['content-type', 'application/fhir+json']],
              body: storedJson(patient('pat-7')),
              startedAtMillis: CAPTURE_FLOOR,
            }),
            traceExchange({
              requestId: 'req-1',
              url: `${root}/Observation?subject%3APatient=pat-7&_count=250`,
              headers: [['content-type', 'application/fhir+json']],
              body: storedJson(searchset(observation('obs-1'), observation('obs-2'))),
              startedAtMillis: CAPTURE_FLOOR + 1000,
            }),
          ])
        )
      )

      expect(preview.collectorTag).toBe('fhir-r4')
      expect(preview.rootUrls).toEqual([root])
      expect(preview.totalEntries).toBe(2)
      expect(preview.unmatchedCount).toBe(0)
      expect(preview.bodyAbsentCount).toBe(0)
      expect(preview.parseFailures).toEqual([])

      const patients = preview.resourcesByType['Patient'] ?? []
      expect(patients.map((resource) => resource.id)).toEqual([
        localResourceId(root, 'Patient', 'pat-7'),
      ])
      const observations = preview.resourcesByType['Observation'] ?? []
      expect(observations.map((resource) => resource.id)).toEqual([
        localResourceId(root, 'Observation', 'obs-1'),
        localResourceId(root, 'Observation', 'obs-2'),
      ])
    })

    it('keeps resources from many servers in one archive apart, listing every root', () => {
      // The whole point of per-URL keying: one archive can span several FHIR
      // servers, and each server's resources stay keyed under its own root with
      // no inference or voting.
      const rootA = 'https://a.example.org/baseR4'
      const rootB = 'https://b.example.org/fhir/R4'
      const preview = expectPreview(
        runPreview(
          harTextOf([
            traceExchange({
              requestId: 'req-0',
              url: `${rootA}/Patient/pat-7?_format=json`,
              headers: [['content-type', 'application/fhir+json']],
              body: storedJson(patient('pat-7')),
              startedAtMillis: CAPTURE_FLOOR,
            }),
            traceExchange({
              requestId: 'req-1',
              url: `${rootB}/Patient/pat-9?_format=json`,
              headers: [['content-type', 'application/fhir+json']],
              body: storedJson(patient('pat-9')),
              startedAtMillis: CAPTURE_FLOOR + 1000,
            }),
            traceExchange({
              requestId: 'req-2',
              url: `${rootB}/Observation?patient=pat-9`,
              headers: [['content-type', 'application/fhir+json']],
              body: storedJson(searchset(observation('obs-b1'))),
              startedAtMillis: CAPTURE_FLOOR + 2000,
            }),
          ])
        )
      )

      // Both servers are surfaced, in first-seen order — neither is dropped and
      // neither is chosen as "the" root.
      expect(preview.rootUrls).toEqual([rootA, rootB])
      // Each Patient is keyed under its own server's root, so the two ids differ
      // even though both are `pat-*` — no collision across servers.
      const patients = preview.resourcesByType['Patient'] ?? []
      expect(patients.map((resource) => resource.id)).toEqual([
        localResourceId(rootA, 'Patient', 'pat-7'),
        localResourceId(rootB, 'Patient', 'pat-9'),
      ])
      const observations = preview.resourcesByType['Observation'] ?? []
      expect(observations.map((resource) => resource.id)).toEqual([
        localResourceId(rootB, 'Observation', 'obs-b1'),
      ])
      expect(preview.totalEntries).toBe(3)
    })

    it('previews re-keyed resources from a committed Chrome DevTools export', () => {
      const root = 'https://ehr.example.com/interconnect-fhir-oauth/api/FHIR/R4'
      const preview = expectPreview(runPreview(JSON.stringify(chromeHar)))

      expect(preview.collectorTag).toBe('fhir-r4')
      // The Epic-style deep base path is recovered as the one source root.
      expect(preview.rootUrls).toEqual([root])
      expect(preview.totalEntries).toBe(5)
      // fonts, analytics, and the app bundle are the browser noise around the
      // FHIR traffic — matched by no entity.
      expect(preview.unmatchedCount).toBe(3)
      expect(preview.bodyAbsentCount).toBe(0)
      expect(preview.parseFailures).toEqual([])

      const patients = preview.resourcesByType['Patient'] ?? []
      expect(patients.map((resource) => resource.id)).toEqual([
        localResourceId(root, 'Patient', 'eXYZ123'),
      ])
      const observations = preview.resourcesByType['Observation'] ?? []
      expect(observations.map((resource) => resource.id)).toEqual([
        localResourceId(root, 'Observation', 'obs-a'),
        localResourceId(root, 'Observation', 'obs-b'),
      ])
    })
  })

  describe('when no collector claims the traffic', () => {
    it('reports NoCollectorClaims for a non-FHIR archive, counting the entries read', () => {
      const preview = runPreview(
        harTextOf([
          traceExchange({
            url: 'https://portal.example.com/carebook/summary',
            body: storedJson({ page: 'summary' }),
          }),
          traceExchange({
            requestId: 'req-1',
            url: 'https://portal.example.com/api/prescriptions',
            body: storedJson({ items: [] }),
          }),
        ])
      )
      expect(preview).toEqual({ _tag: 'NoCollectorClaims', totalEntries: 2 })
    })

    test('property: an archive of arbitrary non-FHIR traffic is NoCollectorClaims', () => {
      const { session } = arbitraries(fc)
      fc.assert(
        fc.property(session, (exchanges) => {
          const preview = runPreview(harTextOf(exchanges))
          expect(preview._tag).toBe('NoCollectorClaims')
          if (preview._tag === 'NoCollectorClaims') {
            expect(preview.totalEntries).toBe(exchanges.length)
          }
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })
  })

  describe('accounting for entries around the claimed resources', () => {
    it('counts unmatched extra entries alongside a claimed FHIR resource', () => {
      const root = 'https://r4.example.org/baseR4'
      const preview = expectPreview(
        runPreview(
          harTextOf([
            traceExchange({
              requestId: 'req-0',
              url: `${root}/Patient/pat-7?_format=json`,
              headers: [['content-type', 'application/fhir+json']],
              body: storedJson(patient('pat-7')),
            }),
            traceExchange({
              requestId: 'req-1',
              url: 'https://portal.example.com/login',
              body: storedJson({}),
            }),
            traceExchange({
              requestId: 'req-2',
              url: 'https://cdn.example.com/app.7f3c.js',
              body: storedJson({}),
            }),
          ])
        )
      )
      expect(preview.unmatchedCount).toBe(2)
      expect(preview.totalEntries).toBe(3)
      expect(preview.resourcesByType['Patient'] ?? []).toHaveLength(1)
    })

    it('counts a matched entry the archive stored no body for as bodyAbsent, not a parse failure', () => {
      const root = 'https://r4.example.org/baseR4'
      const skipped: TraceBody = {
        _tag: 'SkippedBody',
        contentType: 'application/fhir+json',
        size: 118,
        hash: ANY_HASH,
        reason: 'Content type outside the allowlist',
      }
      const preview = expectPreview(
        runPreview(
          harTextOf([
            traceExchange({
              url: `${root}/Patient/pat-7?_format=json`,
              headers: [['content-type', 'application/fhir+json']],
              body: skipped,
            }),
          ])
        )
      )
      expect(preview.bodyAbsentCount).toBe(1)
      expect(preview.parseFailures).toEqual([])
      expect(preview.resourcesByType).toEqual({})
    })
  })

  describe('failures', () => {
    it('fails with a ParseError for text that is not a well-formed HAR', () => {
      const result = Effect.runSync(Effect.either(runHarImport('{ not a har }')))
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left._tag).toBe('ParseError')
      }
    })
  })

  it('requires no services — the FHIR write client is unreachable from a preview', async () => {
    const root = 'https://r4.example.org/baseR4'
    // Type-level: annotating the requirements channel as `never` fails to compile
    // if `runHarImport` ever reached a service (in particular the write client),
    // because that would widen its `R`.
    const preview: (
      harText: string
    ) => Effect.Effect<ImportPreview, ParseResult.ParseError, never> = runHarImport
    // Runtime: run with NO layers provided at all — a missing requirement would
    // surface as a defect here. Neither the compile above nor this run fails.
    const result = await Effect.runPromise(
      preview(
        harTextOf([
          traceExchange({
            url: `${root}/Patient/pat-7?_format=json`,
            headers: [['content-type', 'application/fhir+json']],
            body: storedJson(patient('pat-7')),
          }),
        ])
      )
    )
    expect(result._tag).toBe('Preview')
  })
})

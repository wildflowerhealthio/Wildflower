// oxlint-disable import/max-dependencies -- a committed fixture per source the FHIR pool registers, and that source's constants
import { DetachedResource } from '@wildflowerhealthio/fhir-r4-adoption'
import { HarFromJson, emitHar } from '@wildflowerhealthio/http-archive'
import { type Extraction, SourceDescriptor } from '@wildflowerhealthio/http-extraction-fundamentals'
import {
  type ExtractionResult,
  runExtraction,
} from '@wildflowerhealthio/http-extraction-fundamentals/test-helpers'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { REXALL_STU3_PATIENT_SYSTEM } from '@wildflowerhealthio/rexall-be-well-source'
import { ShoppersIdentifierSystem } from '@wildflowerhealthio/shoppers-drugmart-source'
import { type TraceBody, type TraceExchange } from '@wildflowerhealthio/web-trace-core'
import {
  CAPTURE_FLOOR,
  arbitraries,
  jsonBody,
  traceExchange,
} from '@wildflowerhealthio/web-trace-core/test-helpers'
import { Array as Arr, Effect, type ParseResult, Record as Rec, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it, test } from 'vite-plus/test'

import { decodeHar } from './decode-har.ts'
import { fhirSources } from './fhir-pool.ts'
import chromeHar from './fixtures/chrome-fhir-capture.har.json' with { type: 'json' }
import rexallHar from './fixtures/rexall-be-well.generated.har.json' with { type: 'json' }
import shoppersHar from './fixtures/shoppers-drugmart.generated.har.json' with { type: 'json' }

/**
 * Covers the HAR binding's read half: `decodeHar` in, the FHIR pool run over it
 * (`runExtraction`), each resource keyed as the importer detaches it. Two fixture routes reach the same assertions — an `emitHar`
 * archive shaped like ours and a committed foreign Chrome DevTools export. The
 * portal sources run over whole sessions their synthetic-data generators
 * wrote (`fixtures/*.generated.har.json`, kept current by each generator's
 * `importer-fixture.test.ts`). Also
 * asserts the structural property that `decodeHar` requires no services (the
 * FHIR write client is unreachable from a decode), at the type level and at runtime.
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

/** Encode text to UTF-8 bytes the way a file read would produce them. */
const bytesOf = (text: string): Uint8Array => new TextEncoder().encode(text)

/**
 * Serialize constructed exchanges into `.har` file bytes through `emitHar`.
 *
 * `emitHar` writes `request.method: 'UNKNOWN'` verbatim on every entry — the
 * capture side never observed a verb — but the FHIR pool requires `GET` to
 * claim a URL. Rewrite the wire values here so the tests exercise the
 * extraction path they were written to exercise, mirroring what a real
 * capture that observed the method would carry through.
 */
const harBytesOf = (exchanges: readonly TraceExchange[]): Uint8Array =>
  bytesOf(
    Effect.runSync(encodeHar(emitHar(exchanges, { sessionId: 'test-session' }))).replaceAll(
      '"method":"UNKNOWN"',
      '"method":"GET"'
    )
  )

/** The registered sources' kinds flattened — the flat pool recognition routes against. */
const fhirPool = SourceDescriptor.poolOf(fhirSources)

/** The five-way extraction of running the FHIR pool over a decoded HAR. */
const extract = (harBytes: Uint8Array): ExtractionResult<DetachedResource.Type> =>
  Effect.runSync(
    decodeHar(harBytes).pipe(Effect.flatMap((inputs) => runExtraction(fhirPool, inputs)))
  )

/** Every decoded resource of one `resourceType`, in batch order. */
const ofType = (
  extraction: ExtractionResult<DetachedResource.Type>,
  resourceType: string
): readonly DetachedResource.Type[] =>
  extraction.batches
    .flatMap((batch) => batch.resources)
    .filter((resource) => resource.resourceType === resourceType)

/** The key of every decoded resource of one `resourceType`, in batch order. */
const keysOfType = (
  extraction: ExtractionResult<DetachedResource.Type>,
  resourceType: string
): readonly DetachedResource.Key[] =>
  Arr.filterMap(ofType(extraction, resourceType), DetachedResource.keyOf)

/** How many decoded resources of each `resourceType` the extraction holds. */
const countsByType = (
  extraction: ExtractionResult<DetachedResource.Type>
): Readonly<Record<string, number>> =>
  Rec.map(
    Arr.groupBy(
      extraction.batches.flatMap(({ resources }) => resources),
      ({ resourceType }) => resourceType
    ),
    Arr.length
  )

/** Which response each batch came from, and the kind that claimed it, in order. */
const claimsOf = (
  extraction: ExtractionResult<DetachedResource.Type>
): readonly { readonly url: string; readonly responseKindName: string }[] =>
  extraction.batches.map(({ url, responseKindName }) => ({ url, responseKindName }))

/** The shape of a Chrome DevTools export this file reads: each entry's request URL and DevTools resource type. */
interface ChromeExport {
  readonly log: {
    readonly entries: readonly {
      readonly _resourceType: string
      readonly request: { readonly url: string }
    }[]
  }
}

/**
 * The request URLs of a Chrome export's entries of one DevTools
 * `_resourceType` (`document` for a page navigation, `xhr` for a call a page
 * made), in archive order.
 */
const urlsOfResourceType = (har: ChromeExport, resourceType: string): readonly string[] =>
  har.log.entries
    .filter(({ _resourceType }) => _resourceType === resourceType)
    .map(({ request }) => request.url)

describe('decodeHar + runExtraction', () => {
  describe('a Patient read + Observation searchset', () => {
    it("should decode the server's resources from an emitHar archive, each keyed by its id", () => {
      const root = 'https://r4.example.org/baseR4'
      const extraction = extract(
        harBytesOf([
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

      expect(extraction.unmatched).toHaveLength(0)
      expect(extraction.bodyAbsent).toHaveLength(0)
      expect(extraction.parseFailures).toEqual([])
      expect(keysOfType(extraction, 'Patient')).toEqual([
        { system: `${root}/Patient`, value: 'pat-7' },
      ])
      expect(keysOfType(extraction, 'Observation')).toEqual([
        { system: `${root}/Observation`, value: 'obs-1' },
        { system: `${root}/Observation`, value: 'obs-2' },
      ])
    })

    it('should keep resources from many servers in one archive apart', () => {
      // The whole point of per-URL keying: one archive can span several FHIR
      // servers, and each server's resources stay keyed under its own root.
      const rootA = 'https://a.example.org/baseR4'
      const rootB = 'https://b.example.org/fhir/R4'
      const extraction = extract(
        harBytesOf([
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

      // Each Patient is keyed in its own server's system, so the two keys differ
      // even though both are `pat-*` — no collision across servers.
      expect(keysOfType(extraction, 'Patient')).toEqual([
        { system: `${rootA}/Patient`, value: 'pat-7' },
        { system: `${rootB}/Patient`, value: 'pat-9' },
      ])
      expect(keysOfType(extraction, 'Observation')).toEqual([
        { system: `${rootB}/Observation`, value: 'obs-b1' },
      ])
    })

    it('should decode keyed resources from a committed Chrome DevTools export', () => {
      const root = 'https://ehr.example.com/interconnect-fhir-oauth/api/FHIR/R4'
      const extraction = extract(bytesOf(JSON.stringify(chromeHar)))

      // fonts, analytics, and the app bundle are the browser noise around the
      // FHIR traffic — matched by no entity.
      expect(extraction.unmatched).toHaveLength(3)
      expect(extraction.bodyAbsent).toHaveLength(0)
      expect(extraction.parseFailures).toEqual([])
      expect(keysOfType(extraction, 'Patient')).toEqual([
        { system: `${root}/Patient`, value: 'eXYZ123' },
      ])
      expect(keysOfType(extraction, 'Observation')).toEqual([
        { system: `${root}/Observation`, value: 'obs-a' },
        { system: `${root}/Observation`, value: 'obs-b' },
      ])
    })
  })

  describe('a generated Shoppers Drug Mart session', () => {
    // The household account `synthetic-data-shoppers-drugmart`'s
    // `importer-fixture.test.ts` writes this archive from: a holder and one
    // dependant, two prescriptions each, filled 2 + 1 and 1 + 2 times.
    const extraction = extract(bytesOf(JSON.stringify(shoppersHar)))
    const xhrUrls = urlsOfResourceType(shoppersHar, 'xhr')

    it('should leave only the four page navigations unmatched', () => {
      expect(extraction.unmatched.map(({ url }) => url)).toEqual(
        urlsOfResourceType(shoppersHar, 'document')
      )
      expect(extraction.unmatched).toHaveLength(4)
      expect(extraction.bodyAbsent).toEqual([])
      expect(extraction.parseFailures).toEqual([])
    })

    it('should claim each prescription-status XHR, then the history, then the customers', () => {
      expect(claimsOf(extraction)).toEqual(
        Arr.zipWith(
          xhrUrls,
          [
            ...Arr.replicate('PrescriptionResponseKind', 4),
            'PrescriptionHistoryResponseKind',
            'CustomerResponseKind',
          ],
          (url, responseKindName) => ({ url, responseKindName })
        )
      )
    })

    it('should decode a Patient per person, a request per prescription, and its fills from both feeds', () => {
      // Patient: 2 people. MedicationRequest: 2 + 2 prescriptions, one per
      // status XHR. MedicationDispense: each status XHR's latest fill (4), and
      // every fill on the account in the history (2 + 1 + 1 + 2 = 6).
      expect(countsByType(extraction)).toEqual({
        Patient: 2,
        MedicationRequest: 4,
        MedicationDispense: 10,
      })
    })

    it("should key each person's Patient by their patientId", () => {
      expect(keysOfType(extraction, 'Patient')).toEqual([
        {
          system: ShoppersIdentifierSystem.PatientId,
          value: '00000000-0000-4000-8000-000000000011',
        },
        {
          system: ShoppersIdentifierSystem.PatientId,
          value: '00000000-0000-4000-8000-000000000012',
        },
      ])
    })

    it("should key each prescription's latest fill alike in its status XHR and in the history", () => {
      // What `mergeSharedResources` relies on to make the two copies one.
      const dispenseKeysFrom = (urls: readonly string[]): readonly DetachedResource.Key[] =>
        Arr.filterMap(
          extraction.batches
            .filter(({ url }) => urls.includes(url))
            .flatMap(({ resources }) => resources)
            .filter(({ resourceType }) => resourceType === 'MedicationDispense'),
          DetachedResource.keyOf
        )
      const statusKeys = dispenseKeysFrom(
        xhrUrls.filter((url) => url.endsWith('/prescription-status'))
      )
      const historyKeys = dispenseKeysFrom(
        xhrUrls.filter((url) => url.includes('/prescription-history?'))
      )

      expect(statusKeys).toHaveLength(4)
      expect(new Set(statusKeys.map(({ value }) => value)).size).toBe(4)
      expect(historyKeys).toHaveLength(6)
      expect(historyKeys).toEqual(expect.arrayContaining([...statusKeys]))
    })
  })

  describe('a generated Rexall Be Well session', () => {
    // The story and account `synthetic-data-rexall-be-well`'s
    // `importer-fixture.test.ts` writes this archive from: one person, two
    // prescriptions, the first filled twice.
    const extraction = extract(bytesOf(JSON.stringify(rexallHar)))

    it('should leave only the two page navigations unmatched', () => {
      expect(extraction.unmatched.map(({ url }) => url)).toEqual(
        urlsOfResourceType(rexallHar, 'document')
      )
      expect(extraction.unmatched).toHaveLength(2)
      expect(extraction.bodyAbsent).toEqual([])
      expect(extraction.parseFailures).toEqual([])
    })

    it('should claim the profile XHR and the prescriptions searchset XHR', () => {
      expect(claimsOf(extraction)).toEqual(
        Arr.zipWith(
          urlsOfResourceType(rexallHar, 'xhr'),
          ['ProfileResponseKind', 'MedicationListResponseKind'],
          (url, responseKindName) => ({ url, responseKindName })
        )
      )
    })

    it('should decode the Patient, a request per prescription and its latest fill', () => {
      // Patient: the profile. MedicationRequest: 2 prescriptions.
      // MedicationDispense: the searchset carries each one's latest fill only.
      expect(countsByType(extraction)).toEqual({
        Patient: 1,
        MedicationRequest: 2,
        MedicationDispense: 2,
      })
    })

    it("should key the Patient by the profile's uid", () => {
      expect(keysOfType(extraction, 'Patient')).toEqual([
        { system: REXALL_STU3_PATIENT_SYSTEM, value: '00000000-0000-4000-8000-000000000001' },
      ])
    })
  })

  describe('when no response kind recognizes the traffic', () => {
    it('should count every response as unmatched for a non-FHIR archive', () => {
      const extraction = extract(
        harBytesOf([
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
      expect(extraction.batches).toEqual([])
      expect(extraction.unmatched).toHaveLength(2)
      expect(extraction.parseFailures).toEqual([])
    })

    test('property: an archive of arbitrary non-FHIR traffic recognizes nothing', () => {
      const { session } = arbitraries(fc)
      fc.assert(
        fc.property(session, (exchanges) => {
          const extraction = extract(harBytesOf(exchanges))
          expect(extraction.batches).toEqual([])
          expect(extraction.unmatched).toHaveLength(exchanges.length)
        }),
        { numRuns: numRunsFor({ base: 50 }) }
      )
    })
  })

  describe('accounting for responses around the claimed resources', () => {
    it('should count unmatched extra responses alongside a claimed FHIR resource', () => {
      const root = 'https://r4.example.org/baseR4'
      const extraction = extract(
        harBytesOf([
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
      expect(extraction.unmatched).toHaveLength(2)
      expect(ofType(extraction, 'Patient')).toHaveLength(1)
    })

    it('should count a matched response with no stored body as bodyAbsent, not a parse failure', () => {
      const root = 'https://r4.example.org/baseR4'
      const skipped: TraceBody = {
        _tag: 'SkippedBody',
        contentType: 'application/fhir+json',
        size: 118,
        hash: ANY_HASH,
        reason: 'Content type outside the allowlist',
      }
      const extraction = extract(
        harBytesOf([
          traceExchange({
            url: `${root}/Patient/pat-7?_format=json`,
            headers: [['content-type', 'application/fhir+json']],
            body: skipped,
          }),
        ])
      )
      expect(extraction.bodyAbsent).toHaveLength(1)
      expect(extraction.parseFailures).toEqual([])
      expect(extraction.batches).toEqual([])
    })
  })

  describe('failures', () => {
    it('should fail with a ParseError for bytes that are not a well-formed HAR', () => {
      const result = Effect.runSync(Effect.either(decodeHar(bytesOf('{ not a har }'))))
      expect(result._tag).toBe('Left')
      if (result._tag === 'Left') {
        expect(result.left._tag).toBe('ParseError')
      }
    })
  })

  it('should require no services — the FHIR write client is unreachable from a decode', async () => {
    const root = 'https://r4.example.org/baseR4'
    // Type-level: annotating the requirements channel as `never` fails to compile
    // if `decodeHar` ever reached a service (in particular the write client).
    const decode: (
      fileBytes: Uint8Array
    ) => Effect.Effect<readonly Extraction.Input[], ParseResult.ParseError, never> = (fileBytes) =>
      decodeHar(fileBytes)
    // Runtime: run with NO layers provided at all — a missing requirement would
    // surface as a defect here.
    const inputs = await Effect.runPromise(
      decode(
        harBytesOf([
          traceExchange({
            url: `${root}/Patient/pat-7?_format=json`,
            headers: [['content-type', 'application/fhir+json']],
            body: storedJson(patient('pat-7')),
          }),
        ])
      )
    )
    expect(inputs).toHaveLength(1)
    expect(inputs[0]?.url).toBe(`${root}/Patient/pat-7?_format=json`)
  })
})

import { Effect, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import { type Extraction, SourceDescriptor } from 'http-extraction-fundamentals'
import { type ExtractionResult, runExtraction } from 'http-extraction-fundamentals/test-helpers'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, test } from 'vite-plus/test'
import { type TraceBody, type TraceExchange } from 'web-trace-core'
import { HarFromJson, emitHar } from 'web-trace-core/har'
import { CAPTURE_FLOOR, arbitraries, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

import { decodeHar } from './decode-har.ts'
import { fhirSources } from './fhir-pool.ts'
import chromeHar from './fixtures/chrome-fhir-capture.har.json' with { type: 'json' }
import { defaultHarSettings } from './har-settings.ts'

/**
 * Covers the HAR binding's read half: `decodeHar` in, the FHIR pool run over it
 * (`runExtraction`). Two fixture routes reach the same assertions — an `emitHar`
 * archive shaped like ours and a committed foreign Chrome DevTools export. Also
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

/** Serialize constructed exchanges into `.har` file text through `emitHar`. */
const harTextOf = (exchanges: readonly TraceExchange[]): string =>
  Effect.runSync(encodeHar(emitHar(exchanges, { sessionId: 'test-session' })))

/** The registered sources' kinds flattened — the flat pool recognition routes against. */
const fhirPool = SourceDescriptor.poolOf(fhirSources)

/** The four-way extraction of running the FHIR pool over a decoded HAR. */
const extract = (harText: string): ExtractionResult<FhirResource> =>
  Effect.runSync(
    decodeHar(harText, defaultHarSettings).pipe(
      Effect.flatMap((inputs) => runExtraction(fhirPool, inputs))
    )
  )

/** Every decoded resource of one `resourceType`, in batch order. */
const ofType = (
  extraction: ExtractionResult<FhirResource>,
  resourceType: string
): readonly FhirResource[] =>
  extraction.batches
    .flatMap((batch) => batch.resources)
    .filter((resource) => resource.resourceType === resourceType)

describe('decodeHar + runExtraction', () => {
  describe('a Patient read + Observation searchset', () => {
    it('should decode re-keyed resources from an emitHar archive', () => {
      const root = 'https://r4.example.org/baseR4'
      const extraction = extract(
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

      expect(extraction.unmatched).toHaveLength(0)
      expect(extraction.bodyAbsent).toHaveLength(0)
      expect(extraction.parseFailures).toEqual([])
      expect(ofType(extraction, 'Patient').map((resource) => resource.id)).toEqual([
        localResourceId(root, 'Patient', 'pat-7'),
      ])
      expect(ofType(extraction, 'Observation').map((resource) => resource.id)).toEqual([
        localResourceId(root, 'Observation', 'obs-1'),
        localResourceId(root, 'Observation', 'obs-2'),
      ])
    })

    it('should keep resources from many servers in one archive apart', () => {
      // The whole point of per-URL keying: one archive can span several FHIR
      // servers, and each server's resources stay keyed under its own root.
      const rootA = 'https://a.example.org/baseR4'
      const rootB = 'https://b.example.org/fhir/R4'
      const extraction = extract(
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

      // Each Patient is keyed under its own server's root, so the two ids differ
      // even though both are `pat-*` — no collision across servers.
      expect(ofType(extraction, 'Patient').map((resource) => resource.id)).toEqual([
        localResourceId(rootA, 'Patient', 'pat-7'),
        localResourceId(rootB, 'Patient', 'pat-9'),
      ])
      expect(ofType(extraction, 'Observation').map((resource) => resource.id)).toEqual([
        localResourceId(rootB, 'Observation', 'obs-b1'),
      ])
    })

    it('should decode re-keyed resources from a committed Chrome DevTools export', () => {
      const root = 'https://ehr.example.com/interconnect-fhir-oauth/api/FHIR/R4'
      const extraction = extract(JSON.stringify(chromeHar))

      // fonts, analytics, and the app bundle are the browser noise around the
      // FHIR traffic — matched by no entity.
      expect(extraction.unmatched).toHaveLength(3)
      expect(extraction.bodyAbsent).toHaveLength(0)
      expect(extraction.parseFailures).toEqual([])
      expect(ofType(extraction, 'Patient').map((resource) => resource.id)).toEqual([
        localResourceId(root, 'Patient', 'eXYZ123'),
      ])
      expect(ofType(extraction, 'Observation').map((resource) => resource.id)).toEqual([
        localResourceId(root, 'Observation', 'obs-a'),
        localResourceId(root, 'Observation', 'obs-b'),
      ])
    })
  })

  describe('a Shoppers Drug Mart prescription-history archive', () => {
    // A hand-built history payload, not a real capture. Replace this synthetic
    // exchange with an anonymized `.har` fixture — see #562.
    it('should decode re-keyed MedicationDispense resources from a portal capture', () => {
      const extraction = extract(
        harTextOf([
          traceExchange({
            requestId: 'req-0',
            url: 'https://mypharmacy.shoppersdrugmart.ca/api/v1/prescription-history?customerId=acct-1',
            headers: [['content-type', 'application/json']],
            body: storedJson({
              dispenses: [
                {
                  prescriptionId: 'rx-1',
                  dispenseId: 'disp-1',
                  prescriptionNumber: 9534360,
                  dispenseDate: '2033-05-13',
                  chemicalName: 'Amoxicillin 500mg',
                  brandName: 'Amoxil',
                  quantityDispensed: 30,
                  din: '51480840',
                  isArchive: false,
                  store: { id: 9000, storeName: 'SDM #9000' },
                },
              ],
            }),
            startedAtMillis: CAPTURE_FLOOR,
          }),
        ])
      )

      expect(extraction.unmatched).toHaveLength(0)
      expect(extraction.bodyAbsent).toHaveLength(0)
      expect(extraction.parseFailures).toEqual([])
      expect(ofType(extraction, 'MedicationDispense')).toHaveLength(1)
      const [dispense] = ofType(extraction, 'MedicationDispense')
      expect(dispense?.id).toBe(
        localResourceId(
          'https://wildflowerhealth.io/fhir/sid/shoppers-drugmart',
          'MedicationDispense',
          'disp-1'
        )
      )
    })
  })

  describe('a LifeLabs analytic-summary archive', () => {
    // A hand-built summary payload, not a real capture. Replace this synthetic
    // exchange with an anonymized `.har` fixture — see #562.
    it('should synthesize a re-keyed Patient and Observation from a portal capture', () => {
      const extraction = extract(
        harTextOf([
          traceExchange({
            requestId: 'req-0',
            url: 'https://on-api.mycarecompass.lifelabs.com/api/Report/GetAnalyticSummary?patientId=31653025',
            headers: [['content-type', 'application/json']],
            body: storedJson({
              entity: {
                selectedPatient: '31653025',
                patients: [{ text: 'Test Patient', value: '31653025', isPrimary: true }],
                analytics: [
                  {
                    testCode: 'TR10477-8W',
                    testItemId: 'VFIxMDQ3Ny04V19fNjY5MC0yOw==',
                    testItemName: 'WBC',
                    testName: 'Complete Blood Count',
                    testResultValue: '7.5',
                    referenceRange: '4.0 - 11.0',
                    collectionDate: '/Date(1779297900000-0400)/',
                  },
                ],
              },
            }),
            startedAtMillis: CAPTURE_FLOOR,
          }),
        ])
      )

      expect(extraction.unmatched).toHaveLength(0)
      expect(extraction.bodyAbsent).toHaveLength(0)
      expect(extraction.parseFailures).toEqual([])
      const system = 'https://wildflowerhealth.io/fhir/sid/lifelabs'
      const patientId = localResourceId(system, 'Patient', '31653025')
      expect(ofType(extraction, 'Patient').map((r) => r.id)).toEqual([patientId])
      const [labResult] = ofType(extraction, 'Observation')
      expect(labResult?.id).toBe(
        localResourceId(system, 'Observation', 'VFIxMDQ3Ny04V19fNjY5MC0yOw-1779297900000')
      )
      expect(labResult?.resourceType === 'Observation' && labResult.subject?.reference).toBe(
        `Patient/${patientId}`
      )
    })
  })

  describe('a Rexall Be Well profile archive', () => {
    // A hand-built carebook profile payload, not a real capture. Replace this
    // synthetic exchange with an anonymized `.har` fixture — see #562.
    it('should synthesize a re-keyed Patient from a carebook profile capture', () => {
      const extraction = extract(
        harTextOf([
          traceExchange({
            requestId: 'req-0',
            url: 'https://rexall-prd-tunnel.letsbewell.ca/enduser/profile/v2/me',
            headers: [['content-type', 'application/json']],
            body: storedJson({
              data: {
                identifiers: { uid: 'uid-abc-123', email: 'jordan.rivera@example.com' },
                names: { firstName: 'Jordan', lastName: 'Rivera' },
                birthDate: '1985-07-14',
                zipPostalCode: 'M5V 2T6',
              },
            }),
            startedAtMillis: CAPTURE_FLOOR,
          }),
        ])
      )

      expect(extraction.unmatched).toHaveLength(0)
      expect(extraction.bodyAbsent).toHaveLength(0)
      expect(extraction.parseFailures).toEqual([])
      expect(ofType(extraction, 'Patient')).toHaveLength(1)
      const [synthesizedPatient] = ofType(extraction, 'Patient')
      expect(synthesizedPatient?.id).toBe(
        localResourceId(
          'https://wildflowerhealth.io/fhir/sid/rexall-carebook',
          'Patient',
          'uid-abc-123'
        )
      )
    })
  })

  describe('when no response kind recognizes the traffic', () => {
    it('should count every response as unmatched for a non-FHIR archive', () => {
      const extraction = extract(
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
      expect(extraction.batches).toEqual([])
      expect(extraction.unmatched).toHaveLength(2)
      expect(extraction.parseFailures).toEqual([])
    })

    test('property: an archive of arbitrary non-FHIR traffic recognizes nothing', () => {
      const { session } = arbitraries(fc)
      fc.assert(
        fc.property(session, (exchanges) => {
          const extraction = extract(harTextOf(exchanges))
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
        harTextOf([
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
    it('should fail with a ParseError for text that is not a well-formed HAR', () => {
      const result = Effect.runSync(Effect.either(decodeHar('{ not a har }', defaultHarSettings)))
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
      fileText: string
    ) => Effect.Effect<readonly Extraction.Input[], ParseResult.ParseError, never> = (fileText) =>
      decodeHar(fileText, defaultHarSettings)
    // Runtime: run with NO layers provided at all — a missing requirement would
    // surface as a defect here.
    const inputs = await Effect.runPromise(
      decode(
        harTextOf([
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

import { DateTime, Effect, type Either, Option, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { Observation } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { type HttpResponse, Specificity } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import summary from '../fixtures/analytic-summary.json' with { type: 'json' }
import view from '../fixtures/view-analytics.json' with { type: 'json' }
import { LIFELABS_TEST_SYSTEM, LOINC_SYSTEM, LifeLabsIdentifierSystem } from '../lifelabs.ts'
import { LIFELABS_SYSTEM } from '../source-system.ts'
import { UCUM_SYSTEM } from '../units.ts'
import { AnalyticSummaryResponseKind } from './analytic-summary-response-kind.ts'
import { ViewAnalyticsResponseKind } from './view-analytics-response-kind.ts'

/** base64('TR10477-8W__789-8;') — RBC off the Complete Blood Count. */
const RBC_ITEM_ID = 'VFIxMDQ3Ny04V19fNzg5LTg7'
const VIEW_URL = `https://on-api.mycarecompass.lifelabs.com/api/Report/ViewAnalytics?patientId=31653025&testItemIds=${RBC_ITEM_ID}`

const decodeObservation = Schema.decodeUnknownSync(Observation.Schema)

const makeResponse = (body: string, url = VIEW_URL): HttpResponse.HttpResponse =>
  makeHttpResponse({ url, body })

const runParse = (
  r: HttpResponse.HttpResponse
): Either.Either<readonly FhirResource[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(ViewAnalyticsResponseKind.parse(r)))

const parse = (payload: unknown, url = VIEW_URL): readonly FhirResource[] =>
  Effect.runSync(ViewAnalyticsResponseKind.parse(makeResponse(JSON.stringify(payload), url)))

type ObservationResource = Extract<FhirResource, { resourceType: 'Observation' }>

const observations = (resources: readonly FhirResource[]): readonly ObservationResource[] =>
  resources.filter((r): r is ObservationResource => r.resourceType === 'Observation')

describe('ViewAnalyticsResponseKind', () => {
  describe('tryRecognize', () => {
    it.each([
      { url: VIEW_URL, match: true },
      {
        url: 'https://on-api.mycarecompass.lifelabs.com/api/Report/ViewAnalytics?patientId=1',
        match: true,
      },
      // No query at all: the analyte comes from the query, so this is not the kind.
      { url: 'https://on-api.mycarecompass.lifelabs.com/api/Report/ViewAnalytics', match: false },
      { url: 'https://on-api.mycarecompass.lifelabs.com/api/Report/ViewAnalytics/', match: false },
      {
        url: 'https://on-api.mycarecompass.lifelabs.com/api/Report/ViewReports?patientId=1&reportIds=2',
        match: false,
      },
      {
        url: 'https://on-api.mycarecompass.lifelabs.com/api/Report/GetAnalyticSummary',
        match: false,
      },
      {
        url: `https://bc-api.mycarecompass.lifelabs.com/api/Report/ViewAnalytics?x=1`,
        match: false,
      },
    ])('recognizes $match for "$url"', ({ url, match }) => {
      expect(Option.isSome(ViewAnalyticsResponseKind.tryRecognize(url, Option.none()))).toBe(match)
    })

    it('mints the same portal source as the summary kind', () => {
      expect(ViewAnalyticsResponseKind.tryRecognize(VIEW_URL, Option.none())).toStrictEqual(
        Option.some({ specificity: Specificity.PORTAL, source: { system: LIFELABS_SYSTEM } })
      )
    })
  })

  describe('parse', () => {
    it('emits one Observation per history row and no Patient', () => {
      const result = parse(view)
      expect(result).toHaveLength(3)
      expect(result.every((r) => r.resourceType === 'Observation')).toBe(true)
    })

    it('maps a row whole-value: unit with UCUM, report id, subject, range, codings, instant', () => {
      const [latest] = observations(parse(view))
      expect(latest).toStrictEqual(
        decodeObservation({
          resourceType: 'Observation',
          id: `${RBC_ITEM_ID}-1779297900000`,
          identifier: [{ system: LifeLabsIdentifierSystem.ReportId, value: '900000301' }],
          status: 'final',
          code: {
            text: 'RBC',
            coding: [
              { system: LOINC_SYSTEM, code: '789-8', display: 'RBC' },
              // The panel code is recovered from the item id — this payload has no testCode.
              { system: LIFELABS_TEST_SYSTEM, code: 'TR10477-8W', display: 'Complete Blood Count' },
            ],
          },
          subject: { reference: 'Patient/31653025' },
          effectiveDateTime: '2026-05-20T17:25:00.000Z',
          valueQuantity: { value: 4.66, unit: 'x E12/L', system: UCUM_SYSTEM, code: '10*12/L' },
          referenceRange: [{ text: '4.00 - 5.10', low: { value: 4 }, high: { value: 5.1 } }],
        })
      )
      if (latest?.effectiveDateTime != null) {
        expect(DateTime.toEpochMillis(latest.effectiveDateTime)).toBe(1779297900000)
      }
    })

    it('carries the abnormal flag and a non-empty comment', () => {
      const [, , oldest] = observations(parse(view))
      expect(oldest?.interpretation[0]?.text).toBe('L')
      expect(oldest?.note[0]?.text).toBe('Specimen slightly haemolyzed.')
      expect(oldest?.referenceRange[0]).toMatchObject({ low: { value: 4.5 }, high: { value: 6 } })
    })

    it('mints the same logical id as the summary kind for the same draw of the same analyte', () => {
      // The summary fixture's WBC row and a ViewAnalytics history for WBC at the
      // same collection instant must collide on purpose, so the unit-bearing
      // row supersedes the unitless one on persist.
      const wbcItemId = 'VFIxMDQ3Ny04V19fNjY5MC0yOw=='
      const [fromView] = observations(
        parse(
          {
            entity: {
              testItemName: 'WBC',
              testName: 'Complete Blood Count',
              reports: [
                {
                  reportId: 1,
                  collectionDate: '/Date(1779297900000-0400)/',
                  testResultValue: '7.5',
                  testUnit: 'x E9/L',
                },
              ],
            },
          },
          `https://on-api.mycarecompass.lifelabs.com/api/Report/ViewAnalytics?patientId=31653025&testItemIds=${encodeURIComponent(wbcItemId)}`
        )
      )
      const [fromSummary] = observations(
        Effect.runSync(
          AnalyticSummaryResponseKind.parse(
            makeHttpResponse({
              url: 'https://on-api.mycarecompass.lifelabs.com/api/Report/GetAnalyticSummary',
              body: JSON.stringify(summary),
            })
          )
        )
      ).filter((o) => o.code.text === 'WBC')
      expect(fromView?.id).toBe(fromSummary?.id)
      expect(fromView?.code).toStrictEqual(fromSummary?.code)
      expect(fromView?.valueQuantity?.unit).toBe('x E9/L')
      expect(fromView?.valueQuantity?.code).toBe('10*9/L')
    })

    it('keeps an unlisted unit as display only, without a UCUM code', () => {
      const [o] = observations(
        parse({
          entity: {
            reports: [
              { collectionDate: '/Date(1000)/', testResultValue: '3', testUnit: 'furlongs' },
            ],
          },
        })
      )
      expect(o?.valueQuantity).toMatchObject({ value: 3, unit: 'furlongs' })
      expect(o?.valueQuantity?.system).toBeNull()
      expect(o?.valueQuantity?.code).toBeNull()
    })

    it('maps a non-numeric result to a valueString', () => {
      const [o] = observations(
        parse({
          entity: { reports: [{ collectionDate: '/Date(1000)/', testResultValue: 'Negative' }] },
        })
      )
      expect(o?.valueString).toBe('Negative')
      expect(o?.valueQuantity).toBeNull()
    })

    it('omits the subject when the URL names no patient', () => {
      const [o] = observations(
        parse(
          { entity: { reports: [{ collectionDate: '/Date(1000)/', testResultValue: '1' }] } },
          `https://on-api.mycarecompass.lifelabs.com/api/Report/ViewAnalytics?testItemIds=${RBC_ITEM_ID}`
        )
      )
      expect(o?.subject).toBeNull()
    })

    it('yields nothing for a URL naming several testItemIds', () => {
      expect(
        parse(
          view,
          `https://on-api.mycarecompass.lifelabs.com/api/Report/ViewAnalytics?patientId=1&testItemIds=${RBC_ITEM_ID},VFIxMDQ3Ny04V19fNjY5MC0yOw%3D%3D`
        )
      ).toEqual([])
    })

    it('reads null reports as an empty history', () => {
      expect(parse({ entity: { reports: null } })).toEqual([])
    })

    it('fails with a ParseError for a payload with no entity', () => {
      const result = runParse(makeResponse(JSON.stringify({ caseId: null })))
      expect(result._tag).toBe('Left')
    })

    it('never throws on arbitrary JSON strings', () => {
      fc.assert(
        fc.property(fc.json(), (body) => {
          expect(() => runParse(makeResponse(body))).not.toThrow()
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    it('always carries a finite numeric result as a quantity in the row unit at the collection instant', () => {
      fc.assert(
        fc.property(
          fc.double({ noNaN: true, noDefaultInfinity: true, min: -1e9, max: 1e9 }),
          fc.integer({ min: 0, max: 4_000_000_000_000 }),
          fc.constantFrom('x E9/L', 'x E12/L', 'g/L', 'mmol/L', 'umol/L'),
          (value, millis, unit) => {
            const [o] = observations(
              parse({
                entity: {
                  reports: [
                    {
                      collectionDate: `/Date(${millis}-0400)/`,
                      testResultValue: String(value),
                      testUnit: unit,
                    },
                  ],
                },
              })
            )
            expect(o?.valueQuantity?.value).toBe(Number(String(value)))
            expect(o?.valueQuantity?.unit).toBe(unit)
            expect(String(o?.valueQuantity?.system)).toMatch(/^http:\/\/unitsofmeasure\.org\/?$/)
            expect(o?.id).toBe(`${RBC_ITEM_ID}-${millis}`)
            if (o?.effectiveDateTime != null) {
              expect(DateTime.toEpochMillis(o.effectiveDateTime)).toBe(millis)
            }
          }
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})

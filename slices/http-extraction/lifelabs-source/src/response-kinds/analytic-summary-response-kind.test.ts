import { DateTime, Effect, type Either, Option, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { Observation, Patient } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { type HttpResponse, Specificity } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import summary from '../fixtures/analytic-summary.json' with { type: 'json' }
import { LIFELABS_TEST_SYSTEM, LifeLabsIdentifierSystem } from '../lifelabs.ts'
import { LIFELABS_SYSTEM } from '../source-system.ts'
import { AnalyticSummaryResponseKind } from './analytic-summary-response-kind.ts'

const API_BASE = 'https://on-api.mycarecompass.lifelabs.com'

/** The GetAnalyticSummary URL the analytics page fires (API host). */
const SUMMARY_URL = `${API_BASE}/api/Report/GetAnalyticSummary?patientId=31653025`

const decodePatient = Schema.decodeUnknownSync(Patient.Schema)
const decodeObservation = Schema.decodeUnknownSync(Observation.Schema)

const makeResponse = (body: string, url = SUMMARY_URL): HttpResponse.HttpResponse =>
  makeHttpResponse({ url, body })

const runParse = (
  r: HttpResponse.HttpResponse
): Either.Either<readonly FhirResource[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(AnalyticSummaryResponseKind.parse(r)))

const parse = (payload: unknown): readonly FhirResource[] =>
  Effect.runSync(AnalyticSummaryResponseKind.parse(makeResponse(JSON.stringify(payload))))

const ofType = <T extends FhirResource['resourceType']>(
  resources: readonly FhirResource[],
  resourceType: T
): readonly Extract<FhirResource, { resourceType: T }>[] =>
  resources.filter(
    (r): r is Extract<FhirResource, { resourceType: T }> => r.resourceType === resourceType
  )

describe('AnalyticSummaryResponseKind', () => {
  describe('tryRecognize', () => {
    it.each([
      { url: SUMMARY_URL, match: true },
      { url: `${API_BASE}/api/Report/GetAnalyticSummary`, match: true },
      // No suffix room: a bare trailing slash or a sub-path must NOT match.
      { url: `${API_BASE}/api/Report/GetAnalyticSummary/`, match: false },
      { url: `${API_BASE}/api/Report/GetAnalyticSummary/extra`, match: false },
      // A different report endpoint is not this pattern.
      { url: `${API_BASE}/api/Report/GetVisits`, match: false },
      // The exact host is pinned — another province or a foreign host is rejected.
      {
        url: 'https://bc-api.mycarecompass.lifelabs.com/api/Report/GetAnalyticSummary',
        match: false,
      },
      { url: 'https://tunnel/api/Report/GetAnalyticSummary', match: false },
      // The login host fires nothing this kind claims.
      { url: 'https://myvisit.lifelabs.com/login', match: false },
      // The host is never mistaken for a path segment.
      { url: 'https://GetAnalyticSummary/api/Report', match: false },
    ])('recognizes $match for "$url"', ({ url, match }) => {
      expect(Option.isSome(AnalyticSummaryResponseKind.tryRecognize(url))).toBe(match)
    })

    it('mints the portal source (system only, no baseUrl) at portal specificity', () => {
      expect(AnalyticSummaryResponseKind.tryRecognize(SUMMARY_URL)).toStrictEqual(
        Option.some({ specificity: Specificity.PORTAL, source: { system: LIFELABS_SYSTEM } })
      )
    })
  })

  describe('parse', () => {
    it('synthesizes the selected Patient plus one Observation per analytic', () => {
      const result = parse(summary)

      const patients = ofType(result, 'Patient')
      // The fixture carries 3 analytics, all with a testCode/testItemId to key.
      expect(ofType(result, 'Observation')).toHaveLength(3)
      expect(patients).toStrictEqual([
        decodePatient({
          resourceType: 'Patient',
          id: '31653025',
          identifier: [{ system: LifeLabsIdentifierSystem.PatientId, value: '31653025' }],
          name: [{ text: 'Test Patient' }],
        }),
      ])
    })

    it('maps a numeric analytic whole-value: quantity, subject, range, coding, instant', () => {
      const [wbc] = ofType(parse(summary), 'Observation').filter((o) => o.code.text === 'WBC')

      expect(wbc).toStrictEqual(
        decodeObservation({
          resourceType: 'Observation',
          id: 'VFIxMDQ3Ny04V19fNjY5MC0yOw-1779297900000',
          status: 'final',
          code: {
            text: 'WBC',
            coding: [
              { system: LIFELABS_TEST_SYSTEM, code: 'TR10477-8W', display: 'Complete Blood Count' },
            ],
          },
          subject: { reference: 'Patient/31653025' },
          // .NET /Date(ms-offset)/ → the absolute UTC instant.
          effectiveDateTime: '2026-05-20T17:25:00.000Z',
          valueQuantity: { value: 7.5 },
          referenceRange: [{ text: '4.0 - 11.0', low: { value: 4 }, high: { value: 11 } }],
        })
      )
      if (wbc?.effectiveDateTime != null) {
        expect(DateTime.toEpochMillis(wbc.effectiveDateTime)).toBe(1779297900000)
      }
    })

    it('carries the abnormal flag onto interpretation and parses a spaced range', () => {
      const [hgb] = ofType(parse(summary), 'Observation').filter(
        (o) => o.code.text === 'Hemoglobin'
      )
      expect(hgb?.interpretation[0]?.text).toBe('H')
      expect(hgb?.referenceRange[0]).toMatchObject({
        text: '120- 160',
        low: { value: 120 },
        high: { value: 160 },
      })
    })

    it('maps a non-numeric result to a valueString with no quantity or range', () => {
      const [note] = ofType(parse(summary), 'Observation').filter(
        (o) => o.code.text === 'Reference Interval Note:'
      )
      expect(note?.valueString).toBe('See report for reference interval notes.')
      expect(note?.valueQuantity).toBeNull()
      expect(note?.referenceRange).toEqual([])
    })

    it('gives each Observation a distinct, FHIR-safe logical id', () => {
      const ids = ofType(parse(summary), 'Observation').map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9.-]{1,64}$/)
    })

    it('keys the same analyte on different collection dates apart', () => {
      const analytic = (collectionDate: string): Record<string, unknown> => ({
        testCode: 'TR1',
        testItemId: 'AAAA',
        testItemName: 'X',
        testResultValue: '1',
        collectionDate,
      })
      const ids = ofType(
        parse({
          entity: {
            selectedPatient: 1,
            analytics: [analytic('/Date(1000)/'), analytic('/Date(2000-0400)/')],
          },
        }),
        'Observation'
      ).map((o) => o.id)
      expect(ids).toEqual(['AAAA-1000', 'AAAA-2000'])
    })

    it('drops and counts an analytic with no test code or item id', () => {
      const result = parse({
        entity: {
          selectedPatient: '7',
          analytics: [
            { testItemName: 'No key', testResultValue: '1' },
            { testCode: 'TRX', testItemName: 'Keyed', testResultValue: '2' },
          ],
        },
      })
      expect(ofType(result, 'Observation').map((o) => o.id)).toEqual(['TRX'])
    })

    it('omits the subject when no patient is selected, and emits no Patient', () => {
      const result = parse({
        entity: { analytics: [{ testCode: 'TRX', testItemName: 'Keyed', testResultValue: '2' }] },
      })
      expect(ofType(result, 'Patient')).toEqual([])
      expect(ofType(result, 'Observation')[0]?.subject).toBeNull()
    })

    it('returns an empty array for a summary with no analytics and no patient', () => {
      expect(parse({ entity: { analytics: [], patients: [] } })).toEqual([])
    })

    it('fails with a ParseError for a payload with no entity', () => {
      const result = runParse(makeResponse(JSON.stringify({ message: 'Failed' })))
      expect(result._tag).toBe('Left')
    })

    it('always carries a finite numeric result as a unitless quantity at the collection instant', () => {
      fc.assert(
        fc.property(
          fc.double({ noNaN: true, noDefaultInfinity: true }),
          fc.nat({ max: 4102444800000 }),
          (value, millis) => {
            // Arrange
            const payload = {
              entity: {
                selectedPatient: 1,
                analytics: [
                  {
                    testCode: 'TRX',
                    testItemName: 'X',
                    testResultValue: String(value),
                    collectionDate: `/Date(${millis}-0400)/`,
                  },
                ],
              },
            }

            // Act
            const [observation] = ofType(parse(payload), 'Observation')

            // Assert
            expect(observation?.valueQuantity).toStrictEqual(
              decodeObservation({
                resourceType: 'Observation',
                status: 'final',
                code: { text: 'X' },
                valueQuantity: { value },
              }).valueQuantity
            )
            expect(observation?.valueString).toBeNull()
            expect(observation?.effectiveDateTime).not.toBeNull()
            if (observation?.effectiveDateTime != null) {
              expect(DateTime.toEpochMillis(observation.effectiveDateTime)).toBe(millis)
            }
          }
        ),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })

    it('never throws on arbitrary JSON strings', () => {
      fc.assert(
        fc.property(fc.json(), (json) => {
          const result = runParse(makeResponse(json))
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})

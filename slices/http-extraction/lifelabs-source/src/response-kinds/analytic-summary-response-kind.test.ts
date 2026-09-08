import { DateTime, Effect, type Either, Option, type ParseResult, Schema } from 'effect'
import * as fc from 'fast-check'
import { Observation, Patient } from 'fhir-r4/resources'
import type { FhirResource } from 'fhir-r4/resources'
import { type HttpResponse, Specificity } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import summary from '../fixtures/analytic-summary.json' with { type: 'json' }
import { LIFELABS_TEST_SYSTEM, LOINC_SYSTEM, LifeLabsIdentifierSystem } from '../lifelabs.ts'
import { LIFELABS_SYSTEM } from '../source-system.ts'
import { UCUM_SYSTEM } from '../units.ts'
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
      expect(Option.isSome(AnalyticSummaryResponseKind.tryRecognize(url, Option.none()))).toBe(
        match
      )
    })

    it('mints the portal source (system only, no baseUrl) at portal specificity', () => {
      expect(AnalyticSummaryResponseKind.tryRecognize(SUMMARY_URL, Option.none())).toStrictEqual(
        Option.some({ specificity: Specificity.PORTAL, source: { system: LIFELABS_SYSTEM } })
      )
    })
  })

  describe('parse', () => {
    it('synthesizes the selected Patient plus one Observation per analytic', () => {
      const result = parse(summary)

      const patients = ofType(result, 'Patient')
      // The fixture carries 4 analytics, all with a testCode/testItemId to key.
      expect(ofType(result, 'Observation')).toHaveLength(4)
      expect(patients).toStrictEqual([
        decodePatient({
          resourceType: 'Patient',
          id: '31653025',
          identifier: [
            { system: LifeLabsIdentifierSystem.PatientId, value: '31653025' },
            // The row's `patientMap` — the same human's other portal id.
            { system: LifeLabsIdentifierSystem.PatientId, value: '30990017' },
          ],
          name: [{ text: 'Test Patient' }],
        }),
      ])
    })

    it('carries each distinct other patientMap id once, never the selected id twice', () => {
      const [patient] = ofType(
        parse({
          entity: {
            selectedPatient: 7,
            patients: [{ text: 'P', value: 7, patientMap: [7, 9, '9', 8, 7] }],
            analytics: [],
          },
        }),
        'Patient'
      )
      expect(patient?.identifier.map((i) => i.value)).toEqual(['7', '9', '8'])
    })

    it('reads a null patientMap as no extra identifiers', () => {
      const [patient] = ofType(
        parse({
          entity: {
            selectedPatient: '7',
            patients: [{ text: 'P', value: '7', patientMap: null }],
          },
        }),
        'Patient'
      )
      expect(patient?.identifier.map((i) => i.value)).toEqual(['7'])
    })

    it('maps a numeric analytic whole-value: quantity with researched unit, subject, range, codings, instant', () => {
      const [wbc] = ofType(parse(summary), 'Observation').filter((o) => o.code.text === 'WBC')

      expect(wbc).toStrictEqual(
        decodeObservation({
          resourceType: 'Observation',
          id: 'VFIxMDQ3Ny04V19fNjY5MC0yOw-1779297900000',
          status: 'final',
          code: {
            text: 'WBC',
            coding: [
              // base64('TR10477-8W__6690-2;') — the LOINC for WBC rides in the item id.
              { system: LOINC_SYSTEM, code: '6690-2', display: 'WBC' },
              { system: LIFELABS_TEST_SYSTEM, code: 'TR10477-8W', display: 'Complete Blood Count' },
            ],
          },
          subject: { reference: 'Patient/31653025' },
          // .NET /Date(ms-offset)/ → the absolute UTC instant.
          effectiveDateTime: '2026-05-20T17:25:00.000Z',
          // No unit in the payload: the researched LifeLabs unit for LOINC 6690-2.
          valueQuantity: { value: 7.5, unit: 'x E9/L', system: UCUM_SYSTEM, code: '10*9/L' },
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

    it('parses a one-sided range as a bound only, and recovers the LOINC from the item id', () => {
      const [ratio] = ofType(parse(summary), 'Observation').filter(
        (o) => o.code.text === 'Creatinine ratio'
      )
      expect(ratio?.referenceRange[0]).toMatchObject({ text: '<2.6', high: { value: 2.6 } })
      expect(ratio?.referenceRange[0]?.low).toBeNull()
      // `system` decodes to a `URL`, which normalizes a host-only URI to a
      // trailing slash — compare hrefs.
      expect(ratio?.code.coding.map((c) => [c.system?.href, c.code])).toEqual([
        [new URL(LOINC_SYSTEM).href, '14682-9'],
        [LIFELABS_TEST_SYSTEM, 'TR10149-3'],
      ])
    })

    it('parses a lower-bound range, and emits no LOINC coding for an item id of another shape', () => {
      const [o] = ofType(
        parse({
          entity: {
            selectedPatient: 1,
            analytics: [
              {
                testCode: 'TR1',
                // Not base64 of `<code>__<loinc>;` — a scrambled or foreign id.
                testItemId: 'MBVQBQUFP83ISVO6',
                testItemName: 'X',
                testResultValue: '50',
                referenceRange: '>= 40',
              },
            ],
          },
        }),
        'Observation'
      )
      expect(o?.referenceRange[0]).toMatchObject({ text: '>= 40', low: { value: 40 } })
      expect(o?.referenceRange[0]?.high).toBeNull()
      expect(o?.code.coding.map((c) => c.system?.href)).toEqual([LIFELABS_TEST_SYSTEM])
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

    it('reads an ISO collection date — with an offset, or offset-less as UTC — like a .NET token', () => {
      // The portal's sibling report endpoints serialize dates as ISO strings
      // (`reportDate: "…+00:00"`, `reportPostedDate` with no offset), so the
      // analytic payload is not assumed to differ from them.
      const analytic = (testItemId: string, collectionDate: string): Record<string, unknown> => ({
        testCode: 'TR1',
        testItemId,
        testItemName: 'X',
        testResultValue: '1',
        collectionDate,
      })
      const observations = ofType(
        parse({
          entity: {
            selectedPatient: 1,
            analytics: [
              analytic('AAAA', '2023-02-15T13:55:34+00:00'),
              analytic('BBBB', '2023-02-15T08:55:34-05:00'),
              analytic('CCCC', '2023-02-15T13:55:34'),
              analytic('DDDD', '/Date(1676469334000-0500)/'),
            ],
          },
        }),
        'Observation'
      )
      expect(observations.map((o) => o.id)).toEqual([
        'AAAA-1676469334000',
        'BBBB-1676469334000',
        'CCCC-1676469334000',
        'DDDD-1676469334000',
      ])
      for (const o of observations) {
        expect(o.effectiveDateTime).not.toBeNull()
        if (o.effectiveDateTime != null) {
          expect(DateTime.toEpochMillis(o.effectiveDateTime)).toBe(1676469334000)
        }
      }
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
      // The keyed row falls back to `testCode` + the analyte name (see the
      // panel-code collision below).
      expect(ofType(result, 'Observation').map((o) => o.id)).toEqual(['TRX-Keyed'])
    })

    it('keys two analytes of one panel apart when the capture omits testItemId', () => {
      // Arrange — WBC and Hemoglobin share a CBC `testCode` *and* a collection
      // instant; only the analyte name separates them. Colliding ids would let
      // the persist PUT overwrite one result with the other.
      const analytic = (
        testItemName: string,
        testResultValue: string
      ): Record<string, unknown> => ({
        testCode: 'TR10477-8W',
        testName: 'Complete Blood Count',
        testItemName,
        testResultValue,
        collectionDate: '/Date(1779297900000-0400)/',
      })

      // Act
      const ids = ofType(
        parse({
          entity: {
            selectedPatient: 1,
            analytics: [analytic('WBC', '7.5'), analytic('Hemoglobin', '175')],
          },
        }),
        'Observation'
      ).map((o) => o.id)

      // Assert
      expect(new Set(ids).size).toBe(2)
      expect(ids).toEqual(['TR10477-8W-WBC-1779297900000', 'TR10477-8W-Hemoglobin-1779297900000'])
    })

    it('keeps the collection instant in the id when the item token is over-long', () => {
      // Arrange — a 70-char `testItemId` leaves no room for the suffix inside
      // FHIR's 64-char id, and dropping the suffix would re-collide the same
      // analyte across dates.
      const analytic = (collectionDate: string): Record<string, unknown> => ({
        testItemId: 'A'.repeat(70),
        testItemName: 'X',
        testResultValue: '1',
        collectionDate,
      })

      // Act
      const ids = ofType(
        parse({
          entity: {
            selectedPatient: 1,
            analytics: [analytic('/Date(1000)/'), analytic('/Date(2000)/')],
          },
        }),
        'Observation'
      ).map((o) => o.id)

      // Assert
      expect(new Set(ids).size).toBe(2)
      for (const id of ids) expect(id).toMatch(/^A+-\d+$/)
      for (const id of ids) expect(id?.length).toBeLessThanOrEqual(64)
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

    it('reads null collections as empty ones (the .NET empty-list encoding)', () => {
      expect(parse({ entity: { selectedPatient: null, analytics: null, patients: null } })).toEqual(
        []
      )
    })

    it('emits no Patient for a blank selected patient id', () => {
      const result = parse({
        entity: {
          selectedPatient: '',
          patients: [{ text: 'Test Patient', value: '', isPrimary: true }],
          analytics: [{ testCode: 'TRX', testItemName: 'Keyed', testResultValue: '2' }],
        },
      })
      expect(ofType(result, 'Patient')).toEqual([])
      expect(ofType(result, 'Observation')[0]?.subject).toBeNull()
    })

    it('names the selected patient from their own row, not the primary one', () => {
      // Arrange — a shared account: the account holder is primary, the
      // selected patient is the dependent whose results these are.
      const payload = {
        entity: {
          selectedPatient: 2,
          patients: [
            { text: 'Account Holder', value: 1, isPrimary: true },
            { text: 'Dependent', value: 2, isPrimary: false, isSharedPatient: true },
          ],
          analytics: [{ testCode: 'TRX', testItemName: 'X', testResultValue: '1' }],
        },
      }

      // Act
      const [patient] = ofType(parse(payload), 'Patient')

      // Assert
      expect(patient?.id).toBe('2')
      expect(patient?.name[0]?.text).toBe('Dependent')
    })

    it('leaves the selected patient unnamed when no row carries their id', () => {
      const [patient] = ofType(
        parse({
          entity: {
            selectedPatient: 2,
            patients: [{ text: 'Account Holder', value: 1, isPrimary: true }],
            analytics: [],
          },
        }),
        'Patient'
      )
      expect(patient?.id).toBe('2')
      expect(patient?.name).toEqual([])
    })

    it('drops an out-of-range .NET date instead of dying on it', () => {
      // `new Date(ms).toISOString()` throws past the representable range, and a
      // throw inside `parse` is a defect that escapes the extraction's fold.
      const result = runParse(
        makeResponse(
          JSON.stringify({
            entity: {
              selectedPatient: 1,
              analytics: [
                {
                  testCode: 'TRX',
                  testItemName: 'X',
                  testResultValue: '1',
                  collectionDate: '/Date(99999999999999999)/',
                },
              ],
            },
          })
        )
      )
      expect(result._tag).toBe('Right')
      if (result._tag !== 'Right') return
      const [observation] = ofType(result.right, 'Observation')
      expect(observation?.effectiveDateTime).toBeNull()
      expect(observation?.id).toBe('TRX-X')
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

            // Assert — against the number the wire string round-trips to
            // (`-0` stringifies as "0" and comes back as `+0`).
            expect(observation?.valueQuantity).toStrictEqual(
              decodeObservation({
                resourceType: 'Observation',
                status: 'final',
                code: { text: 'X' },
                valueQuantity: { value: Number(String(value)) },
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

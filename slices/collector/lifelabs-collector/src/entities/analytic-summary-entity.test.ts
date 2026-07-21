import { Response } from 'collector-fundamentals/model'
import { DateTime, Effect, type Either, type ParseResult } from 'effect'
import * as fc from 'fast-check'
import type { FhirResource } from 'fhir-r4/resources'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import summary from '../fixtures/analytic-summary.json' with { type: 'json' }
import { AnalyticSummaryEntity } from './analytic-summary-entity.ts'

const encoder = new TextEncoder()

/** The GetAnalyticSummary URL the analytics page fires (API host), matched by `isFoundAt`. */
const SUMMARY_URL =
  'https://on-api.mycarecompass.lifelabs.com/api/Report/GetAnalyticSummary?patientId=31653025'

const makeResponse = (body: string, url = SUMMARY_URL): Response.RemoteResponse => {
  const r = new Response.RemoteResponse(url, 200, 'OK', [['content-type', 'application/json']])
  r.appendChunk(encoder.encode(body))
  return r
}

const runParse = (
  r: Response.RemoteResponse
): Either.Either<readonly FhirResource[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(AnalyticSummaryEntity.parse(r)))

describe('AnalyticSummaryEntity', () => {
  describe('isFoundAt', () => {
    it.each([
      { url: SUMMARY_URL, match: true },
      {
        url: 'https://on-api.mycarecompass.lifelabs.com/api/Report/GetAnalyticSummary',
        match: true,
      },
      // A different report endpoint is not this pattern.
      { url: 'https://on-api.mycarecompass.lifelabs.com/api/Report/GetVisits', match: false },
      // The login host fires nothing this entity claims.
      { url: 'https://myvisit.lifelabs.com/login', match: false },
      // The host is never mistaken for a path segment.
      { url: 'https://GetAnalyticSummary/api/Report', match: false },
    ])('returns $match for "$url"', ({ url, match }) => {
      expect(AnalyticSummaryEntity.isFoundAt(url)).toBe(match)
    })
  })

  describe('parse', () => {
    it('synthesizes a Patient (id = selectedPatient) plus one Observation per analytic', () => {
      const result = runParse(makeResponse(JSON.stringify(summary)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')

      const patients = result.right.filter((r) => r.resourceType === 'Patient')
      const observations = result.right.filter((r) => r.resourceType === 'Observation')
      expect(patients).toHaveLength(1)
      // The fixture carries 3 analytics, all with a testCode/testItemId to key.
      expect(observations).toHaveLength(3)

      const patient = patients[0]
      if (patient?.resourceType !== 'Patient') throw new Error('missing Patient')
      expect(patient.id).toBe('31653025')
      expect(patient.name[0]?.text).toBe('Test Patient')
    })

    it('maps a numeric result to a valueQuantity and subjects the patient', () => {
      const result = runParse(makeResponse(JSON.stringify(summary)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const wbc = result.right.find(
        (r) => r.resourceType === 'Observation' && r.code.text === 'WBC'
      )
      if (wbc?.resourceType !== 'Observation') throw new Error('missing WBC observation')
      expect(wbc.status).toBe('final')
      expect(wbc.valueQuantity?.value).toBe(7.5)
      expect(wbc.subject?.reference).toBe('Patient/31653025')
      // '4.0 - 11.0' → parsed low/high plus the raw text.
      expect(wbc.referenceRange[0]?.low?.value).toBe(4)
      expect(wbc.referenceRange[0]?.high?.value).toBe(11)
      expect(wbc.referenceRange[0]?.text).toBe('4.0 - 11.0')
      // .NET /Date(ms-offset)/ → the absolute UTC instant (decoded to DateTime.Utc).
      const eff = wbc.effectiveDateTime
      expect(eff).not.toBeNull()
      if (eff !== null) expect(DateTime.toEpochMillis(eff)).toBe(1779297900000)
    })

    it('carries the abnormal flag onto interpretation', () => {
      const result = runParse(makeResponse(JSON.stringify(summary)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const hgb = result.right.find(
        (r) => r.resourceType === 'Observation' && r.code.text === 'Hemoglobin'
      )
      if (hgb?.resourceType !== 'Observation') throw new Error('missing Hemoglobin observation')
      expect(hgb.interpretation[0]?.text).toBe('H')
    })

    it('maps a non-numeric result to a valueString', () => {
      const result = runParse(makeResponse(JSON.stringify(summary)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const note = result.right.find(
        (r) => r.resourceType === 'Observation' && r.code.text === 'Reference Interval Note:'
      )
      if (note?.resourceType !== 'Observation') throw new Error('missing note observation')
      expect(note.valueString).toBe('See report for reference interval notes.')
      expect(note.valueQuantity).toBeNull()
    })

    it('gives each Observation a distinct, FHIR-safe logical id', () => {
      const result = runParse(makeResponse(JSON.stringify(summary)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      const ids = result.right.filter((r) => r.resourceType === 'Observation').map((r) => r.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const id of ids) {
        expect(id).not.toBeNull()
        expect(id).toMatch(/^[A-Za-z0-9.-]{1,64}$/)
      }
    })

    it('returns an empty array for a summary with no analytics and no patient', () => {
      const empty = { entity: { analytics: [], patients: [] } }
      const result = runParse(makeResponse(JSON.stringify(empty)))
      if (result._tag !== 'Right') throw new Error('expected a successful parse')
      expect(result.right).toEqual([])
    })

    it('never throws on arbitrary JSON strings', () => {
      fc.assert(
        fc.property(fc.json(), (json) => {
          const result = Effect.runSync(
            Effect.either(AnalyticSummaryEntity.parse(makeResponse(json)))
          )
          expect(['Right', 'Left']).toContain(result._tag)
        }),
        { numRuns: numRunsFor({ base: 100 }) }
      )
    })
  })
})

import { Effect, Either, Option, ParseResult } from 'effect'
import * as fc from 'fast-check'
import { localResourceId } from 'fhir-r4/identity'
import type { FhirResource } from 'fhir-r4/resources'
import { type HttpResponse, Specificity } from 'http-extraction-fundamentals'
import { makeHttpResponse } from 'http-extraction-fundamentals/test-helpers'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { LIFELABS_PDF_URL_PREFIX, TIME_ZONE_HEADER } from './decode.ts'
import { arbitrary as reportArbitrary } from './entities/report-arbitrary.ts'
import { LifeLabsReportResponseKind, lifeLabsPdfResponseKinds } from './response-kind.ts'
import { LIFELABS_SYSTEM } from './source-system.ts'
import { layoutDocument } from './test-helpers.ts'

const URL = `${LIFELABS_PDF_URL_PREFIX}Reports-1.pdf`

const response = (body: string, timeZone?: string): HttpResponse.HttpResponse =>
  makeHttpResponse({
    url: URL,
    body,
    headers:
      timeZone === undefined
        ? [['content-type', 'application/json']]
        : [
            ['content-type', 'application/json'],
            [TIME_ZONE_HEADER, timeZone],
          ],
  })

const adopted = lifeLabsPdfResponseKinds[0]
if (adopted === undefined) throw new Error('unreachable: one kind is registered')

const runParse = (
  kind: typeof LifeLabsReportResponseKind,
  r: HttpResponse.HttpResponse
): Either.Either<readonly FhirResource[], ParseResult.ParseError> =>
  Effect.runSync(Effect.either(kind.parse(r)))

describe('LifeLabsReportResponseKind.tryRecognize', () => {
  it('claims the URL the decode mints at portal specificity, under the LifeLabs system', () => {
    expect(LifeLabsReportResponseKind.tryRecognize(URL, Option.some('GET'))).toEqual(
      Option.some({ specificity: Specificity.PORTAL, source: { system: LIFELABS_SYSTEM } })
    )
  })

  it('claims nothing else: a nested path, a query, another host, a FHIR URL', () => {
    for (const url of [
      `${LIFELABS_PDF_URL_PREFIX}a/b.pdf`,
      LIFELABS_PDF_URL_PREFIX,
      `${LIFELABS_PDF_URL_PREFIX}x.pdf?y=1`,
      'https://example.com/import/lifelabs-pdf/x.pdf',
      'https://ehr.example/Patient/1',
    ]) {
      expect(LifeLabsReportResponseKind.tryRecognize(url, Option.some('GET'))).toEqual(
        Option.none()
      )
    }
  })
})

describe('LifeLabsReportResponseKind.parse', () => {
  it('property: decodes the body through the dialect and synthesis, in the header zone', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const body = JSON.stringify(layoutDocument(reports))

        const resources = Effect.runSync(LifeLabsReportResponseKind.parse(response(body, 'UTC')))

        const rows = reports.flatMap((r) =>
          r.sections.flatMap((s) => s.groups.flatMap((g) => g.rows))
        )
        expect(resources.filter((r) => r.resourceType === 'Observation')).toHaveLength(rows.length)
        expect(resources.filter((r) => r.resourceType === 'DiagnosticReport')).toHaveLength(
          reports.length
        )
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('reads the zone off the header: the same clock time lands on different instants per zone', () => {
    const [report] = fc.sample(reportArbitrary, { numRuns: 1, seed: 3 })
    if (report === undefined) throw new Error('unreachable: one sample requested')
    const body = JSON.stringify(layoutDocument([{ ...report, dateOfService: 'Aug 13 2026 13:02' }]))

    const toronto = Effect.runSync(
      LifeLabsReportResponseKind.parse(response(body, 'America/Toronto'))
    )
    const vancouver = Effect.runSync(
      LifeLabsReportResponseKind.parse(response(body, 'America/Vancouver'))
    )
    const defaulted = Effect.runSync(LifeLabsReportResponseKind.parse(response(body)))

    const effectiveOf = (resources: readonly FhirResource[]): number | undefined =>
      resources.find((r) => r.resourceType === 'DiagnosticReport')?.effectiveDateTime?.epochMillis
    expect(effectiveOf(toronto)).toBe(Date.parse('2026-08-13T17:02:00.000Z'))
    expect(effectiveOf(vancouver)).toBe(Date.parse('2026-08-13T20:02:00.000Z'))
    expect(effectiveOf(defaulted)).toBe(effectiveOf(toronto))
  })

  it('fails as a ParseError for a zone the runtime does not know, and for a body that is not the format', () => {
    const body = JSON.stringify(layoutDocument([]))

    const badZone = runParse(LifeLabsReportResponseKind, response(body, 'Mars/Olympus'))
    const badBody = runParse(LifeLabsReportResponseKind, response('{"format":"har"}', 'UTC'))

    expect(Either.isLeft(badZone) && ParseResult.isParseError(badZone.left)).toBe(true)
    expect(Either.isLeft(badBody) && ParseResult.isParseError(badBody.left)).toBe(true)
  })
})

describe('lifeLabsPdfResponseKinds (adopted)', () => {
  it('property: re-keys every resource under the LifeLabs system and keeps the report pointing at its observations', () => {
    fc.assert(
      fc.property(fc.array(reportArbitrary, { minLength: 1, maxLength: 2 }), (reports) => {
        const body = JSON.stringify(layoutDocument(reports))

        const raw = Effect.runSync(LifeLabsReportResponseKind.parse(response(body, 'UTC')))
        const resources = Effect.runSync(adopted.parse(response(body, 'UTC')))

        expect(resources.map((r) => r.id)).toEqual(
          raw.map((r) => localResourceId(LIFELABS_SYSTEM, r.resourceType, r.id ?? ''))
        )
        const ids = new Set(resources.map((r) => `${r.resourceType}/${r.id}`))
        for (const resource of resources) {
          if (resource.resourceType === 'DiagnosticReport') {
            for (const result of resource.result) expect(ids.has(result.reference ?? '')).toBe(true)
            expect(ids.has(resource.subject?.reference ?? '')).toBe(true)
          }
          if (resource.resourceType === 'Observation') {
            expect(ids.has(resource.subject?.reference ?? '')).toBe(true)
          }
          if (resource.resourceType === 'Patient') {
            for (const gp of resource.generalPractitioner)
              expect(ids.has(gp.reference ?? '')).toBe(true)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })
})

import { DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { HttpArchive } from 'http-archive'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { asOfArbitrary, shoppersCaseArbitrary } from '../arbitraries.test-helpers.ts'
import type { ShoppersAccount } from './shoppers-account.ts'
import * as ShoppersHar from './shoppers-har.ts'

/**
 * Covers the renderer's determinism and dating over generated family
 * accounts, and that its output is an archive `http-archive` reads, in the
 * collector's page order. What the
 * importer makes of it is `shoppers-har.round-trip.test.ts`'s.
 */

const RUNS = numRunsFor({ base: 25 })

const accountArbitrary: fc.Arbitrary<ShoppersAccount> = shoppersCaseArbitrary.map(
  ({ account }) => account
)

/** Every calendar date in the archive — entry times and the portal's dates alike — in order. */
const datesIn = (har: string): readonly number[] =>
  [...har.matchAll(/\b(\d{4}-\d{2}-\d{2})(?:T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z)?\b/g)].map(
    ([timestamp]) => Date.parse(timestamp)
  )

const decodeLog = Schema.decodeUnknownSync(HttpArchive.LogFromHarJson)

/** A prescription's status XHR, keyed by its uuid. */
const STATUS_URL =
  /^https:\/\/mypharmacy\.shoppersdrugmart\.ca\/api\/v1\/prescriptions\/[0-9a-f-]{36}\/prescription-status$/

/** The status body's fillability fields: whether the portal still offers a fill. */
const decodeStatusBody = Schema.decodeUnknownSync(
  Schema.parseJson(
    Schema.Struct({
      expired: Schema.Boolean,
      archived: Schema.Boolean,
      renewable: Schema.Boolean,
      nextFillDate: Schema.optional(Schema.String),
      status: Schema.Struct({ type: Schema.String }),
    })
  )
)

const prescriptionCountOf = (account: ShoppersAccount): number =>
  account.patients.reduce((count, patient) => count + patient.story.prescriptions.length, 0)

describe('ShoppersHar.render', () => {
  test('property: is byte-identical for any two instants on the same as-of day', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        fc.integer({ min: 0, max: 86_399_999 }),
        accountArbitrary,
        (asOf, millisIntoDay, account) => {
          const sameDay = DateTime.add(DateTime.startOf(asOf, 'day'), { millis: millisIntoDay })
          expect(ShoppersHar.render(sameDay, account)).toBe(ShoppersHar.render(asOf, account))
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('property: moving the as-of date moves every date in the archive by the same days', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        fc.integer({ min: -400, max: 400 }),
        accountArbitrary,
        (asOf, shiftDays, account) => {
          const shifted = datesIn(
            ShoppersHar.render(DateTime.add(asOf, { days: shiftDays }), account)
          )
          const original = datesIn(ShoppersHar.render(asOf, account))
          expect(shifted).toHaveLength(original.length)
          expect(shifted.map((epochMillis, index) => epochMillis - (original[index] ?? 0))).toEqual(
            original.map(() => shiftDays * 86_400_000)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('property: every fill in the bodies precedes the capture', () => {
    fc.assert(
      fc.property(asOfArbitrary, accountArbitrary, (asOf, account) => {
        const har = ShoppersHar.render(asOf, account)
        const [firstEntry] = decodeLog(har).entries
        const captureStart = firstEntry?.startedAt.epochMillis ?? Number.NaN
        const fillDates = [
          ...har.matchAll(/\\"(?:dispenseDate|lastFillDate)\\":\\"([^\\]+)\\"/g),
        ].map(([, date]) => Date.parse(date ?? ''))
        expect(fillDates.length).toBeGreaterThan(prescriptionCountOf(account))
        for (const epochMillis of fillDates) {
          expect(epochMillis).toBeLessThan(captureStart)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('property: a status body offers a fill only while the prescription is neither archived nor expired', () => {
    fc.assert(
      fc.property(asOfArbitrary, accountArbitrary, (asOf, account) => {
        const statusBodies = decodeLog(ShoppersHar.render(asOf, account))
          .entries.filter((entry) => STATUS_URL.test(entry.url))
          .map((entry) => decodeStatusBody(new TextDecoder().decode(entry.body)))
        expect(statusBodies).toHaveLength(prescriptionCountOf(account))
        for (const body of statusBodies) {
          const fillable = !body.archived && !body.expired
          expect(body.renewable).toBe(fillable)
          if (!fillable) {
            expect(body.status.type).toBe('UNABLE_TO_RENEW_ONLINE')
            expect(body.nextFillDate).toBeUndefined()
          }
        }
      }),
      { numRuns: RUNS }
    )
  })

  test("property: decodes as a HAR of the collector's session, every request distinct, every body stored", () => {
    fc.assert(
      fc.property(asOfArbitrary, accountArbitrary, (asOf, account) => {
        const log = decodeLog(ShoppersHar.render(asOf, account))
        const urls = log.entries.map((entry) => entry.url)
        const { pcid } = account
        expect(urls.map((url) => (STATUS_URL.test(url) ? 'prescription-status' : url))).toEqual([
          'https://mypharmacy.shoppersdrugmart.ca/en/login',
          'https://mypharmacy.shoppersdrugmart.ca/en/healthdashboard/',
          'https://mypharmacy.shoppersdrugmart.ca/en/prescription-dashboard/?nav=featured-services/prescription-icon',
          ...Array.from({ length: prescriptionCountOf(account) }, () => 'prescription-status'),
          'https://mypharmacy.shoppersdrugmart.ca/en/prescription-history',
          `https://mypharmacy.shoppersdrugmart.ca/api/v1/prescription-history?customerId=${pcid}`,
          `https://mypharmacy.shoppersdrugmart.ca/api/v1/customers/pcid/${pcid}?expand=patients%2Cstores`,
        ])
        expect(new Set(urls).size).toBe(urls.length)
        expect(log.entries.every((entry) => !entry.bodyAbsent && entry.status === 200)).toBe(true)
        expect(
          log.entries
            .map((entry) => entry.startedAt.epochMillis)
            .every((startedAt, index, all) => index === 0 || startedAt > (all[index - 1] ?? 0))
        ).toBe(true)
      }),
      { numRuns: RUNS }
    )
  })
})

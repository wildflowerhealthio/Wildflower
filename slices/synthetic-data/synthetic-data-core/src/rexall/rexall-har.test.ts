import { DateTime, Schema } from 'effect'
import * as fc from 'fast-check'
import { HttpArchive } from 'http-archive'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import {
  asOfArbitrary,
  rexallAccountArbitrary,
  storyCaseArbitrary,
} from '../arbitraries.test-helpers.ts'
import type { Story } from '../story.ts'
import type { RexallAccount } from './rexall-account.ts'
import * as RexallHar from './rexall-har.ts'

/**
 * Covers the renderer's determinism and dating over generated stories, and
 * that its output is an archive `http-archive` reads. What the importer makes of it is
 * `rexall-har.round-trip.test.ts`'s.
 */

const RUNS = numRunsFor({ base: 25 })

/** A generated story and the account it is filled under. */
const filledArbitrary: fc.Arbitrary<{ readonly story: Story; readonly account: RexallAccount }> =
  fc.record({
    story: storyCaseArbitrary('person-1').map(({ story }) => story),
    account: rexallAccountArbitrary,
  })

/** Every carebook timestamp (`…+00:00`) in the archive's bodies, in order. */
const carebookTimestampsIn = (har: string): readonly number[] =>
  [...har.matchAll(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00/g)].map(([timestamp]) =>
    Date.parse(timestamp)
  )

const decodeLog = Schema.decodeUnknownSync(HttpArchive.LogFromHarJson)

describe('RexallHar.render', () => {
  test('property: is byte-identical for any two instants on the same as-of day', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        fc.integer({ min: 0, max: 86_399_999 }),
        filledArbitrary,
        (asOf, millisIntoDay, { story, account }) => {
          const sameDay = DateTime.add(DateTime.startOf(asOf, 'day'), { millis: millisIntoDay })
          expect(RexallHar.render(sameDay, story, account)).toBe(
            RexallHar.render(asOf, story, account)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('property: moving the as-of date moves every carebook timestamp by the same days', () => {
    fc.assert(
      fc.property(
        asOfArbitrary,
        fc.integer({ min: -400, max: 400 }),
        filledArbitrary,
        (asOf, shiftDays, { story, account }) => {
          const shifted = carebookTimestampsIn(
            RexallHar.render(DateTime.add(asOf, { days: shiftDays }), story, account)
          )
          const original = carebookTimestampsIn(RexallHar.render(asOf, story, account))
          expect(shifted).toHaveLength(original.length)
          expect(shifted.map((epochMillis, index) => epochMillis - (original[index] ?? 0))).toEqual(
            original.map(() => shiftDays * 86_400_000)
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('property: every carebook timestamp precedes the capture', () => {
    fc.assert(
      fc.property(asOfArbitrary, filledArbitrary, (asOf, { story, account }) => {
        const har = RexallHar.render(asOf, story, account)
        const [firstEntry] = decodeLog(har).entries
        const captureStart = firstEntry?.startedAt.epochMillis ?? Number.NaN
        for (const epochMillis of carebookTimestampsIn(har)) {
          expect(epochMillis).toBeLessThan(captureStart)
        }
      }),
      { numRuns: RUNS }
    )
  })

  test('property: decodes as a HAR of the session, every request distinct, every body stored', () => {
    fc.assert(
      fc.property(asOfArbitrary, filledArbitrary, (asOf, { story, account }) => {
        const log = decodeLog(RexallHar.render(asOf, story, account))
        expect(log.entries.map((entry) => entry.url)).toEqual([
          'https://letsbewell.ca/sign-in',
          'https://app.letsbewell.ca/health/prescriptions',
          'https://rexall-prd-tunnel.letsbewell.ca/enduser/profile/v2/me',
          expect.stringMatching(
            /^https:\/\/rexall-prd-tunnel\.letsbewell\.ca\/enduser\/health\/v1\/fhir\/stu3\/pharmacy\/Location\?subject=Patient\/[^&]+&_id=[^&]+&_query=lastActiveOnly&/
          ),
        ])
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

import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import * as TimeDomain from './time-domain.ts'

const RUNS = numRunsFor({ base: 200 })

const instant = fc.integer({ min: 0, max: 4e12 }).map((millis) => DateTime.unsafeMake(millis))
const extent: fc.Arbitrary<TimeDomain.TimeDomain> = fc
  .tuple(instant, instant)
  .map(([left, right]): TimeDomain.TimeDomain =>
    left.epochMillis <= right.epochMillis ? [left, right] : [right, left]
  )

describe('TimeDomain.pointsWithin', () => {
  test('keeps exactly the points inside the domain, in input order', () => {
    fc.assert(
      fc.property(fc.array(instant, { maxLength: 20 }), extent, (times, domain) => {
        const points = times.map((time, index) => ({ time, index }))
        const kept = TimeDomain.pointsWithin(points, domain)
        expect(kept).toEqual(
          points.filter(
            (point) =>
              point.time.epochMillis >= domain[0].epochMillis &&
              point.time.epochMillis <= domain[1].epochMillis
          )
        )
      }),
      { numRuns: RUNS }
    )
  })

  test('the domain endpoints are included', () => {
    fc.assert(
      fc.property(extent, (domain) => {
        const points = [{ time: domain[0] }, { time: domain[1] }]
        expect(TimeDomain.pointsWithin(points, domain)).toEqual(points)
      }),
      { numRuns: RUNS }
    )
  })
})

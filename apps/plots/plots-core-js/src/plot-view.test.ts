import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { medicationSource } from '@wildflowerhealthio/plots-medications'
import { observationSource } from '@wildflowerhealthio/plots-observations'
import { PLOT_VIEWS, type ScatterAxes, scatterAxesOf, shownViewOf } from './plot-view.ts'

const RUNS = numRunsFor({ base: 200 })

const code = fc.string({ maxLength: 8 })

/** An id of a value series: an observation's point series or a medication's level series. */
const valueSeriesIdArb: fc.Arbitrary<string> = fc.oneof(
  code.map((value) =>
    observationSource.seriesIdOf({ kind: 'points', system: null, code: value, unit: null })
  ),
  code.map((medication) =>
    medicationSource.seriesIdOf({ medication, doseUnit: null, doseBasis: 'administration' })
  )
)

/** An id of an observation span series, drawn as a lane. */
const spanSeriesIdArb: fc.Arbitrary<string> = code.map((value) =>
  observationSource.seriesIdOf({ kind: 'spans', system: null, code: value })
)

describe('scatterAxesOf', () => {
  test('pairs the first two value series, X then Y, whatever lanes or junk sit among them', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(valueSeriesIdArb, { minLength: 2, maxLength: 2 }),
        fc.array(fc.oneof(spanSeriesIdArb, fc.constant('not a series id')), { maxLength: 3 }),
        fc.nat(),
        (valueIds, others, position) => {
          const ids = [...others]
          ids.splice(position % (ids.length + 1), 0, ...valueIds)
          expect(scatterAxesOf(ids)).toEqual({
            kind: 'paired',
            xSeriesId: valueIds[0],
            ySeriesId: valueIds[1],
          })
        }
      ),
      { numRuns: RUNS }
    )
  })

  test('says how many value series there are when it is not two', () => {
    fc.assert(
      fc.property(
        fc
          .uniqueArray(valueSeriesIdArb, { maxLength: 5 })
          .filter((valueIds) => valueIds.length !== 2),
        fc.array(spanSeriesIdArb, { maxLength: 2 }),
        (valueIds, spanIds) => {
          const valueSeriesCount = valueIds.length
          expect(scatterAxesOf([...spanIds, ...valueIds])).toEqual({
            kind: valueSeriesCount < 2 ? 'too-few-value-series' : 'too-many-value-series',
            valueSeriesCount,
          })
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('shownViewOf', () => {
  const paired: ScatterAxes = { kind: 'paired', xSeriesId: 'x', ySeriesId: 'y' }
  const tooFew: ScatterAxes = { kind: 'too-few-value-series', valueSeriesCount: 1 }

  test.each(PLOT_VIEWS)('shows the %s view the selection asks for when it can be made', (view) => {
    expect(shownViewOf(view, paired)).toBe(view)
  })

  test('shows the chart for a scatter the selection cannot make, and every other view as asked', () => {
    expect(shownViewOf('scatter', tooFew)).toBe('chart')
    expect(shownViewOf('table', tooFew)).toBe('table')
    expect(shownViewOf('chart', tooFew)).toBe('chart')
  })
})

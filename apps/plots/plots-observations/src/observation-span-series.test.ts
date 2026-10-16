import { Observation } from '@wildflowerhealthio/fhir-r4/resources'
import { HealthActivity } from '@wildflowerhealthio/fhir-sync-pebble-core/pkjs'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { SpanSeries } from '@wildflowerhealthio/plots-fundamentals'
import { Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'

import { parseObservationSeriesId } from './observation-series-key.ts'
import { observationsToSeries } from './observation-series.ts'

const RUNS = numRunsFor({ base: 100 })

const decodeObservation = Schema.decodeUnknownSync(Observation.Schema)

/** The watch FHIR Sync for Pebble's activities are recorded by, in its reference form. */
const watch = { display: 'Pebble Time 2', identifier: { system: 'urn:test:watch', value: 'w1' } }

/** One Pebble activity on the wire, as FHIR Sync for Pebble's own writer turns it into an Observation. */
const pebbleActivityWire = (
  activityType: number,
  startSeconds: number,
  endSeconds: number
): HealthActivity.Observation =>
  HealthActivity.toObservation(
    HealthActivity.decodeMessage({
      ActivityType: activityType,
      ActivityStart: startSeconds,
      ActivityEnd: endSeconds,
    }),
    'patient-1',
    watch
  )

/** {@link pebbleActivityWire}, decoded — what the reader is handed. */
const pebbleActivity = (
  activityType: number,
  startSeconds: number,
  endSeconds: number
): typeof Observation.Schema.Type =>
  decodeObservation(pebbleActivityWire(activityType, startSeconds, endSeconds))

const { HealthActivityType } = HealthActivity

/** 2026-10-01T22:00:00Z, in Unix seconds. */
const NIGHT = 1_790_892_000
const HOUR = 3600

describe('observationsToSeries — spans', () => {
  test('a night of Pebble activities is one span series, a span per activity', () => {
    const { series, undated, dropped } = observationsToSeries([
      pebbleActivity(HealthActivityType.Sleep, NIGHT, NIGHT + 8 * HOUR),
      pebbleActivity(HealthActivityType.RestfulSleep, NIGHT + 2 * HOUR, NIGHT + 3 * HOUR),
      pebbleActivity(HealthActivityType.Walk, NIGHT + 9 * HOUR, NIGHT + 10 * HOUR),
    ])
    expect({ undated, dropped }).toEqual({ undated: 0, dropped: 0 })
    expect(series).toHaveLength(1)
    const [lane] = series
    if (lane.kind !== 'spans') throw new Error('expected a span series')
    expect(lane.label).toBe('Pebble Health Activity')
    expect(lane.category).toBe('activity')
    expect(parseObservationSeriesId(lane.id)).toEqual(lane.key)
    expect(lane.key.kind).toBe('spans')
    expect(
      lane.spans.map((span) => ({
        start: span.start.epochMillis / 1000,
        end: span.end.epochMillis / 1000,
        label: span.category.label,
      }))
    ).toEqual([
      { start: NIGHT, end: NIGHT + 8 * HOUR, label: 'Sleeping' },
      { start: NIGHT + 2 * HOUR, end: NIGHT + 3 * HOUR, label: 'Restful Sleeping' },
      { start: NIGHT + 9 * HOUR, end: NIGHT + 10 * HOUR, label: 'Walking' },
    ])
  })

  test('each activity FHIR Sync for Pebble writes keeps its own category and lane colour', () => {
    const activityTypes = Object.values(HealthActivityType)
    const { series } = observationsToSeries(
      activityTypes.map((activityType, index) =>
        pebbleActivity(activityType, NIGHT + index * HOUR, NIGHT + index * HOUR + 60)
      )
    )
    expect(series).toHaveLength(1)
    const [lane] = series
    if (lane.kind !== 'spans') throw new Error('expected a span series')
    const categories = SpanSeries.categoriesOf(lane)
    expect(categories).toHaveLength(activityTypes.length)
    const slots = categories.map((category) => category.colourSlot)
    expect(new Set(slots).size).toBe(activityTypes.length)
    for (const slot of slots) {
      expect(slot).not.toBeNull()
      expect(slot).toBeGreaterThanOrEqual(0)
      expect(slot).toBeLessThan(SpanSeries.COLOUR_SLOTS)
    }
  })

  test('the same activity read twice lands in one category; spans sort by start', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            activityType: fc.constantFrom(...Object.values(HealthActivityType)),
            start: fc.integer({ min: NIGHT, max: NIGHT + 30 * 24 * HOUR }),
            length: fc.integer({ min: 0, max: 12 * HOUR }),
          }),
          { minLength: 1, maxLength: 12 }
        ),
        (drafts) => {
          const { series, dropped } = observationsToSeries(
            drafts.map(({ activityType, start, length }) =>
              pebbleActivity(activityType, start, start + length)
            )
          )
          expect(dropped).toBe(0)
          expect(series).toHaveLength(1)
          const [lane] = series
          if (lane.kind !== 'spans') throw new Error('expected a span series')
          expect(lane.spans).toHaveLength(drafts.length)
          const starts = lane.spans.map((span) => span.start.epochMillis)
          expect(starts).toEqual(starts.toSorted((left, right) => left - right))
          expect(SpanSeries.categoriesOf(lane)).toHaveLength(
            new Set(drafts.map((draft) => draft.activityType)).size
          )
        }
      ),
      { numRuns: RUNS }
    )
  })

  describe('a coded value that is not a span is dropped', () => {
    const { effectivePeriod, ...sleep } = pebbleActivityWire(
      HealthActivityType.Sleep,
      NIGHT,
      NIGHT + 8 * HOUR
    )

    test.each([
      ['dated by an instant', { ...sleep, effectiveDateTime: effectivePeriod.start }],
      [
        'dated by a period with no end',
        { ...sleep, effectivePeriod: { start: effectivePeriod.start } },
      ],
      [
        'ending before it starts',
        { ...sleep, effectivePeriod: { start: effectivePeriod.end, end: effectivePeriod.start } },
      ],
      ['without a code', { ...sleep, effectivePeriod, code: { coding: [] } }],
    ])('%s', (_, wire) => {
      expect(observationsToSeries([decodeObservation(wire)])).toEqual({
        series: [],
        undated: 0,
        dropped: 1,
      })
    })
  })
})

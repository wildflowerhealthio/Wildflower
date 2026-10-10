/**
 * fast-check arbitraries for the FHIR Sync for Pebble generator's inputs: a
 * physiology over some days before the as-of day, the watch that recorded it
 * and the patient it is for, shared through the
 * `synthetic-data-fhir-sync-pebble/test-helpers` subpath. Each comes paired
 * with the Sleep and RestfulSleep stretches it must render as, laid out here
 * as each night is built rather than worked out by the generator's own
 * functions.
 *
 * @packageDocumentation
 */
import * as fc from 'fast-check'

import type { StoryDay } from '@wildflowerhealthio/synthetic-data-fundamentals/story'
import * as PebbleWatch from './pebble-watch.ts'
import type { Night, Physiology, PhysiologyDay, Span, Walk } from './physiology.ts'

/** A Span on a day, the way an activity's period is reckoned. */
interface DaySpan {
  readonly day: StoryDay.StoryDay
  readonly span: Span
}

interface PhysiologyCase {
  readonly physiology: Physiology
  readonly watch: PebbleWatch.PebbleWatch
  readonly patientId: string
  /** Every stretch of sleep between falling asleep, wake-ups and waking. */
  readonly sleeps: readonly DaySpan[]
  readonly restfulSleeps: readonly DaySpan[]
}

/** The daytime a day's walks and charges fall in: four slots of 150 minutes from 11:00. */
const DAYTIME_START_MINUTE = 660
const SLOT_MINUTES = 150
const SLOTS = 4

interface NightInputs {
  readonly asleepMinute: number
  readonly lengthMinutes: number
  readonly wakeUpDurations: readonly number[]
  /** One per stretch of sleep; `null` for no restful block in it. */
  readonly restfulDurations: readonly (number | null)[]
}

const nightInputsArbitrary: fc.Arbitrary<NightInputs> = fc.record({
  // 21:00 to 1:00.
  asleepMinute: fc.integer({ min: -180, max: 60 }),
  lengthMinutes: fc.integer({ min: 300, max: 600 }),
  wakeUpDurations: fc.array(fc.integer({ min: 5, max: 40 }), { maxLength: 3 }),
  restfulDurations: fc.array(fc.option(fc.integer({ min: 20, max: 90 })), {
    minLength: 4,
    maxLength: 4,
  }),
})

/**
 * A night and its stretches of sleep: `k` wake-ups centred at even fractions
 * of the night, so each stretch is at least a quarter of five hours less half
 * of a forty-minute wake-up, and a restful block 20 minutes into a stretch.
 */
const nightOf = (inputs: NightInputs): { night: Night; stretches: readonly Span[] } => {
  const { asleepMinute, lengthMinutes, wakeUpDurations } = inputs
  const awakeMinute = asleepMinute + lengthMinutes
  const wakeUps = wakeUpDurations.map((durationMinutes, index) => ({
    startMinute:
      asleepMinute +
      Math.round((lengthMinutes * (index + 1)) / (wakeUpDurations.length + 1)) -
      Math.floor(durationMinutes / 2),
    durationMinutes,
  }))
  const starts = [asleepMinute, ...wakeUps.map((w) => w.startMinute + w.durationMinutes)]
  const ends = [...wakeUps.map((w) => w.startMinute), awakeMinute]
  const stretches = starts.map((startMinute, index) => ({
    startMinute,
    durationMinutes: (ends[index] ?? awakeMinute) - startMinute,
  }))
  const restfulSleeps = stretches.flatMap((stretch, index) => {
    const duration = inputs.restfulDurations[index] ?? null
    return duration === null
      ? []
      : [
          {
            startMinute: stretch.startMinute + 20,
            durationMinutes: Math.min(duration, stretch.durationMinutes - 30),
          },
        ]
  })
  return { night: { asleepMinute, awakeMinute, wakeUps, restfulSleeps }, stretches }
}

/** What fills one daytime slot: nothing, a walk, or the watch on its charger. */
type Slot =
  | { readonly kind: 'idle' }
  | {
      readonly kind: 'walk'
      readonly offset: number
      readonly duration: number
      readonly stepsPerMinute: number
      readonly heartRateRiseBpm: number
    }
  | { readonly kind: 'charging'; readonly offset: number; readonly duration: number }

const slotArbitrary: fc.Arbitrary<Slot> = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: 'idle' as const }) },
  {
    weight: 3,
    arbitrary: fc.record({
      kind: fc.constant('walk' as const),
      offset: fc.integer({ min: 0, max: 30 }),
      duration: fc.integer({ min: 5, max: 110 }),
      stepsPerMinute: fc.integer({ min: 60, max: 140 }),
      heartRateRiseBpm: fc.integer({ min: 5, max: 50 }),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      kind: fc.constant('charging' as const),
      offset: fc.integer({ min: 0, max: 30 }),
      duration: fc.integer({ min: 20, max: 110 }),
    }),
  }
)

const slotStartOf = (index: number, offset: number): number =>
  DAYTIME_START_MINUTE + index * SLOT_MINUTES + offset

interface DayInputs {
  readonly worn: boolean
  readonly restingHeartRateBpm: number
  readonly night: NightInputs | null
  readonly slots: readonly Slot[]
}

const dayInputsArbitrary: fc.Arbitrary<DayInputs> = fc.record({
  worn: fc.oneof({ weight: 7, arbitrary: fc.constant(true) }, fc.constant(false)),
  restingHeartRateBpm: fc.integer({ min: 50, max: 100 }),
  night: fc.option(nightInputsArbitrary, { freq: 6 }),
  slots: fc.array(slotArbitrary, { minLength: SLOTS, maxLength: SLOTS }),
})

/**
 * A physiology over the `dayCount` days before the as-of day, now and then
 * one left unworn: a resting heart rate a day, most nights' sleep (falling
 * asleep between 21:00 and 1:00, five to ten hours, up to three wake-ups,
 * restful blocks), and up to four daytime walks or charges, never
 * overlapping, all worn by a watch keyed after a generated person.
 */
const physiologyCaseArbitrary = ({
  minDays,
  maxDays,
}: {
  readonly minDays: number
  readonly maxDays: number
}): fc.Arbitrary<PhysiologyCase> =>
  fc
    .integer({ min: minDays, max: maxDays })
    .chain((dayCount) =>
      fc.record({
        utcOffsetHours: fc.integer({ min: -10, max: 12 }),
        amplitudeBpm: fc.integer({ min: 0, max: 12 }),
        nadirMinute: fc.integer({ min: 0, max: 1439 }),
        days: fc.array(dayInputsArbitrary, { minLength: dayCount, maxLength: dayCount }),
        watchKey: fc.nat({ max: 999 }),
        patientId: fc.uuid({ version: 4 }),
      })
    )
    .filter(({ days }) => days.some(({ worn }) => worn))
    .map(({ utcOffsetHours, amplitudeBpm, nadirMinute, days, watchKey, patientId }) => {
      const laidOut = days.flatMap((inputs, index) => {
        if (!inputs.worn) return []
        const day = index - days.length
        const night = inputs.night === null ? null : nightOf(inputs.night)
        const walks: Walk[] = []
        const charging: Span[] = []
        for (const [slotIndex, slot] of inputs.slots.entries()) {
          if (slot.kind === 'walk') {
            walks.push({
              startMinute: slotStartOf(slotIndex, slot.offset),
              durationMinutes: slot.duration,
              stepsPerMinute: slot.stepsPerMinute,
              heartRateRiseBpm: slot.heartRateRiseBpm,
            })
          }
          if (slot.kind === 'charging') {
            charging.push({
              startMinute: slotStartOf(slotIndex, slot.offset),
              durationMinutes: slot.duration,
            })
          }
        }
        const physiologyDay: PhysiologyDay = {
          day,
          restingHeartRateBpm: inputs.restingHeartRateBpm,
          night: night?.night ?? null,
          walks,
          charging,
        }
        return [{ physiologyDay, stretches: night?.stretches ?? [] }]
      })
      return {
        physiology: {
          utcOffsetHours,
          circadian: { amplitudeBpm, nadirMinute },
          days: laidOut.map(({ physiologyDay }) => physiologyDay),
        },
        watch: PebbleWatch.watchOf([`person-${watchKey}`]),
        patientId,
        sleeps: laidOut.flatMap(({ physiologyDay, stretches }) =>
          stretches.map((span) => ({ day: physiologyDay.day, span }))
        ),
        restfulSleeps: laidOut.flatMap(({ physiologyDay }) =>
          (physiologyDay.night?.restfulSleeps ?? []).map((span) => ({
            day: physiologyDay.day,
            span,
          }))
        ),
      }
    })

export { physiologyCaseArbitrary }
export type { DaySpan, PhysiologyCase }

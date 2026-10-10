import type { MinuteHistory } from '@wildflowerhealthio/fhir-sync-pebble-core'

import type { Night, Physiology, PhysiologyDay, Span } from './physiology.ts'

/**
 * A physiology's minute history, minute by minute: what the watch's
 * HealthService would hold for each local minute of the days it lists.
 *
 * @remarks
 * Minutes are counted on the story's local clock from the as-of day's local
 * midnight (`day * 1440 + minute`), so the values do not depend on the as-of
 * date and moving it moves only the timestamps. The small wobble a real
 * sensor shows is hashed from the minute and the watch's seed, one draw per
 * minute and channel, so the same inputs always give the same minutes.
 */

const MINUTES_PER_DAY = 1440

/** What the wearer is doing in a minute, as far as the sensors can tell. */
type Stage = 'awake' | 'asleep' | 'restful' | 'woken'

/** How far each stage moves the heart rate from the day's rhythm. */
const STAGE_HEART_RATE_OFFSET_BPM: Readonly<Record<Stage, number>> = {
  awake: 0,
  asleep: -4,
  restful: -8,
  woken: 6,
}

/** Minutes a walk takes to raise the heart rate fully, and to let it fall back after. */
const WALK_RAMP_MINUTES = 3
const WALK_RECOVERY_MINUTES = 5

/** How often an awake minute away from a walk has steps (moving about the house), and at most how many. */
const IDLE_STEP_CHANCE = 0.2
const IDLE_STEPS_MAX = 40

/** Steps in each of the first minutes of getting up in the night. */
const WOKEN_STEP_MINUTES = 2
const WOKEN_STEPS = 12

/** The most a minute's heart rate strays from the model, either way. */
const HEART_RATE_WOBBLE_BPM = 2
/** The most a walking minute's steps stray from the cadence, either way. */
const CADENCE_WOBBLE_STEPS = 3

/** The wire's ceilings: a byte for steps and heart rate, 16 bits for vmc. */
const BYTE_MAX = 255
const VMC_MAX = 65_535

/** Channels of the per-minute wobble, so each quantity draws independently. */
const CHANNEL_HEART_RATE = 0
const CHANNEL_STEPS = 1
const CHANNEL_STEP_COUNT = 2
const CHANNEL_VMC = 3
const CHANNELS = 4

/**
 * lowbias32 (Chris Wellons's 32-bit integer hash): every input bit flips each
 * output bit with probability close to a half.
 */
const mix32 = (value: number): number => {
  let mixed = value >>> 0
  mixed ^= mixed >>> 16
  mixed = Math.imul(mixed, 0x7feb352d)
  mixed ^= mixed >>> 15
  mixed = Math.imul(mixed, 0x846ca68b)
  mixed ^= mixed >>> 16
  return mixed >>> 0
}

/** A draw in `[0, 1)` for `storyMinute` on `channel`, under the watch's `seed`. */
const drawOf = (seed: number, storyMinute: number, channel: number): number =>
  mix32(seed ^ mix32(storyMinute * CHANNELS + channel)) / 2 ** 32

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value))

/** A day's local minutes: `[day * 1440 + span.startMinute, …)` on the story clock. */
const storyMinutesOf = (day: number, span: Span): { start: number; end: number } => ({
  start: day * MINUTES_PER_DAY + span.startMinute,
  end: day * MINUTES_PER_DAY + span.startMinute + span.durationMinutes,
})

/**
 * The stretches of sleep a night's wake-ups split it into, each from its
 * night's wake day's midnight: falling asleep to the first wake-up, between
 * wake-ups, the last wake-up to waking.
 */
const sleepStretchesOf = (night: Night): readonly Span[] => {
  const bounds = [
    night.asleepMinute,
    ...night.wakeUps.flatMap((wakeUp) => [
      wakeUp.startMinute,
      wakeUp.startMinute + wakeUp.durationMinutes,
    ]),
    night.awakeMinute,
  ]
  return Array.from({ length: bounds.length / 2 }, (_, index) => {
    const startMinute = bounds[index * 2] ?? night.asleepMinute
    const endMinute = bounds[index * 2 + 1] ?? night.awakeMinute
    return { startMinute, durationMinutes: endMinute - startMinute }
  })
}

/** The minute history of every day `physiology` lists, and the story minute it starts on. */
interface MinuteTimeline {
  /** The story minute of `minutes[0]`: a local midnight. */
  readonly firstStoryMinute: number
  /** One per local minute from the first listed day to the last; null where the watch holds none. */
  readonly minutes: ReadonlyArray<MinuteHistory.Minute | null>
}

/**
 * The minutes `physiology` describes, with `seed` choosing the sensor's wobble.
 *
 * @param seed - A 32-bit integer; the watch's, so one watch always wobbles the same way
 */
const minuteTimelineOf = (physiology: Physiology, seed: number): MinuteTimeline => {
  const days = physiology.days.map(({ day }) => day)
  if (days.length === 0) return { firstStoryMinute: 0, minutes: [] }
  const firstDay = Math.min(...days)
  const firstStoryMinute = firstDay * MINUTES_PER_DAY
  const length = (Math.max(...days) - firstDay + 1) * MINUTES_PER_DAY
  const indexRangeOf = ({ start, end }: { start: number; end: number }): number[] => {
    const from = clamp(start - firstStoryMinute, 0, length)
    const to = clamp(end - firstStoryMinute, 0, length)
    return Array.from({ length: Math.max(0, to - from) }, (_, offset) => from + offset)
  }

  const worn = Array.from({ length }, (): boolean => false)
  const restingBpm = Array.from({ length }, (): number => 0)
  const stage = Array.from({ length }, (): Stage => 'awake')
  const cadence = Array.from({ length }, (): number => 0)
  const walkRiseBpm = Array.from({ length }, (): number => 0)
  const minutesIntoWakeUp = Array.from({ length }, (): number => 0)

  const markDay = (physiologyDay: PhysiologyDay): void => {
    const { day } = physiologyDay
    for (const index of indexRangeOf(
      storyMinutesOf(day, { startMinute: 0, durationMinutes: MINUTES_PER_DAY })
    )) {
      worn[index] = true
      restingBpm[index] = physiologyDay.restingHeartRateBpm
    }
  }
  const markNight = (day: number, night: Night): void => {
    for (const stretch of sleepStretchesOf(night)) {
      for (const index of indexRangeOf(storyMinutesOf(day, stretch))) stage[index] = 'asleep'
    }
    for (const restful of night.restfulSleeps) {
      for (const index of indexRangeOf(storyMinutesOf(day, restful))) stage[index] = 'restful'
    }
    for (const wakeUp of night.wakeUps) {
      const { start } = storyMinutesOf(day, wakeUp)
      for (const index of indexRangeOf(storyMinutesOf(day, wakeUp))) {
        stage[index] = 'woken'
        minutesIntoWakeUp[index] = index + firstStoryMinute - start
      }
    }
  }
  const markWalks = (physiologyDay: PhysiologyDay): void => {
    for (const walk of physiologyDay.walks) {
      const { start, end } = storyMinutesOf(physiologyDay.day, walk)
      for (const index of indexRangeOf({ start, end })) {
        const minutesIn = index + firstStoryMinute - start
        cadence[index] = walk.stepsPerMinute
        walkRiseBpm[index] =
          walk.heartRateRiseBpm * Math.min(1, (minutesIn + 1) / WALK_RAMP_MINUTES)
      }
      for (const index of indexRangeOf({ start: end, end: end + WALK_RECOVERY_MINUTES })) {
        const minutesAfter = index + firstStoryMinute - end + 1
        const recovering = walk.heartRateRiseBpm * (1 - minutesAfter / (WALK_RECOVERY_MINUTES + 1))
        walkRiseBpm[index] = Math.max(walkRiseBpm[index] ?? 0, recovering)
      }
    }
  }

  for (const physiologyDay of physiology.days) markDay(physiologyDay)
  for (const physiologyDay of physiology.days) {
    if (physiologyDay.night !== null) markNight(physiologyDay.day, physiologyDay.night)
    markWalks(physiologyDay)
  }
  for (const physiologyDay of physiology.days) {
    for (const charge of physiologyDay.charging) {
      for (const index of indexRangeOf(storyMinutesOf(physiologyDay.day, charge))) {
        worn[index] = false
      }
    }
  }

  const { amplitudeBpm, nadirMinute } = physiology.circadian
  const minuteAt = (index: number): MinuteHistory.Minute | null => {
    if (!worn[index]) return null
    const storyMinute = firstStoryMinute + index
    const minuteOfDay = storyMinute - Math.floor(storyMinute / MINUTES_PER_DAY) * MINUTES_PER_DAY
    const draw = (channel: number): number => drawOf(seed, storyMinute, channel)
    const minuteStage = stage[index] ?? 'awake'
    const walkingCadence = cadence[index] ?? 0
    const rhythmBpm =
      -amplitudeBpm * Math.cos((2 * Math.PI * (minuteOfDay - nadirMinute)) / MINUTES_PER_DAY)
    const wobbleBpm = Math.floor(draw(CHANNEL_HEART_RATE) * (2 * HEART_RATE_WOBBLE_BPM + 1))
    const heartRateBpm = clamp(
      Math.round(
        (restingBpm[index] ?? 0) +
          rhythmBpm +
          STAGE_HEART_RATE_OFFSET_BPM[minuteStage] +
          (walkRiseBpm[index] ?? 0)
      ) +
        wobbleBpm -
        HEART_RATE_WOBBLE_BPM,
      1,
      BYTE_MAX
    )
    const steps = ((): number => {
      if (walkingCadence > 0) {
        const wobble = Math.floor(draw(CHANNEL_STEPS) * (2 * CADENCE_WOBBLE_STEPS + 1))
        return clamp(walkingCadence + wobble - CADENCE_WOBBLE_STEPS, 0, BYTE_MAX)
      }
      if (minuteStage === 'woken') {
        return (minutesIntoWakeUp[index] ?? 0) < WOKEN_STEP_MINUTES ? WOKEN_STEPS : 0
      }
      if (minuteStage !== 'awake' || draw(CHANNEL_STEPS) >= IDLE_STEP_CHANCE) return 0
      return 1 + Math.floor(draw(CHANNEL_STEP_COUNT) * IDLE_STEPS_MAX)
    })()
    const vmcDraw = draw(CHANNEL_VMC)
    const vmc = ((): number => {
      if (walkingCadence > 0) return steps * 30 + vmcDraw * 400
      if (minuteStage === 'asleep') return vmcDraw * 60
      if (minuteStage === 'restful') return vmcDraw * 10
      return 150 + steps * 25 + vmcDraw * 300
    })()
    return {
      steps,
      yawBin: 0,
      pitchBin: 0,
      vmc: clamp(Math.round(vmc), 0, VMC_MAX),
      light: 0,
      heartRateBpm,
    }
  }

  return { firstStoryMinute, minutes: Array.from({ length }, (_, index) => minuteAt(index)) }
}

export { MINUTES_PER_DAY, minuteTimelineOf, sleepStretchesOf }
export type { MinuteTimeline }

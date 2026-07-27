import { Duration, Effect, Either, Schema } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'

import { DurationFromFhirDuration, UCUM_TIME_CODES } from './fhir-duration.ts'
import { UCUM_MILLISECOND_CODE, UCUM_SYSTEM } from './systems.ts'

const decode = Schema.decodeUnknown(DurationFromFhirDuration)
const encode = Schema.encode(DurationFromFhirDuration)

/** `Duration.millis` is canonical only at microsecond resolution or coarser. */
const durationArbitrary = fc
  .integer({ min: 0, max: 86_400_000 })
  .map((millis) => Duration.millis(millis))

const failureOf = async (quantity: unknown): Promise<string> => {
  const outcome = await Effect.runPromise(Effect.either(decode(quantity)))
  expect(outcome._tag).toBe('Left')
  return Either.isLeft(outcome) ? outcome.left.message : ''
}

describe('DurationFromFhirDuration', () => {
  test('property: every duration round-trips through a FHIR Duration', async () => {
    await fc.assert(
      fc.asyncProperty(durationArbitrary, async (duration) => {
        const quantity = await Effect.runPromise(encode(duration))
        expect(await Effect.runPromise(decode(quantity))).toEqual(duration)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('encoding writes milliseconds with the UCUM code drt-1 requires', async () => {
    expect(await Effect.runPromise(encode(Duration.seconds(1.5)))).toMatchObject({
      value: 1500,
      unit: UCUM_MILLISECOND_CODE,
      system: UCUM_SYSTEM,
      code: UCUM_MILLISECOND_CODE,
    })
  })

  // The point of the schema: the code says what the number means, so a duration
  // written by anything other than this codec is read in its own unit rather
  // than passing for milliseconds.
  test.each([
    { code: 'ms', value: 250, expected: Duration.millis(250) },
    { code: 's', value: 1.5, expected: Duration.millis(1500) },
    { code: 'min', value: 2, expected: Duration.minutes(2) },
    { code: 'h', value: 1, expected: Duration.hours(1) },
    { code: 'd', value: 1, expected: Duration.days(1) },
    { code: 'wk', value: 1, expected: Duration.weeks(1) },
  ])('$value $code decodes as $code, not as milliseconds', async ({ code, value, expected }) => {
    const decoded = await Effect.runPromise(decode({ value, code, system: UCUM_SYSTEM }))
    expect(decoded).toEqual(expected)
    if (code !== 'ms') expect(decoded).not.toEqual(Duration.millis(value))
  })

  test('property: a value in seconds is exactly a thousand times the same value in millis', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 0, max: 86_400 }), async (value) => {
        const seconds = await Effect.runPromise(decode({ value, code: 's', system: UCUM_SYSTEM }))
        const millis = await Effect.runPromise(decode({ value, code: 'ms', system: UCUM_SYSTEM }))
        expect(Duration.toMillis(seconds)).toBe(Duration.toMillis(millis) * 1000)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  // `mo` and `a` are UCUM time codes, so the only thing keeping them out is the
  // deliberate omission from the table — neither has a fixed length.
  test.each(['mo', 'a'])(
    '%s has no fixed length, so it is rejected rather than averaged',
    async (code) => {
      expect(UCUM_TIME_CODES[code]).toBeUndefined()
      expect(await failureOf({ value: 1, code, system: UCUM_SYSTEM })).toContain(code)
    }
  )

  test('an unrecognized unit fails instead of being read as milliseconds', async () => {
    expect(await failureOf({ value: 5, code: 'furlong', system: UCUM_SYSTEM })).toContain('furlong')
  })

  test('a duration with no unit code fails — the number alone means nothing', async () => {
    expect(await failureOf({ value: 5 })).toContain('UCUM time code')
  })

  test('a code from some other system is not read as UCUM', async () => {
    expect(await failureOf({ value: 5, code: 's', system: 'http://example.org/units' })).toContain(
      'not UCUM'
    )
  })

  test('a duration with no value fails', async () => {
    expect(await failureOf({ code: 'ms', system: UCUM_SYSTEM })).toContain('no value')
  })
})

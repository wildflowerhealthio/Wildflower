import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Array, Duration, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import {
  choiceValue,
  idleTtlChoices,
  isSamePolicy,
  limitLabel,
  limitOfChoice,
  maxTtlChoices,
} from './session-lifetime-choices.ts'

describe('limitLabel', () => {
  it('reads a limit in its largest whole unit', () => {
    expect(limitLabel(Duration.minutes(30))).toBe('30 minutes')
    expect(limitLabel(Duration.hours(1))).toBe('1 hour')
    expect(limitLabel(Duration.hours(36))).toBe('36 hours')
    expect(limitLabel(Duration.days(365))).toBe('365 days')
    expect(limitLabel(Duration.seconds(90))).toBe('90 seconds')
  })
})

describe('the limit choices', () => {
  it('offer no limit first, then the presets shortest first', () => {
    // Act
    const choices = idleTtlChoices(Option.some(Duration.hours(2)))

    // Assert
    expect(choices.map(({ label }) => label)).toEqual([
      'No limit',
      '15 minutes',
      '30 minutes',
      '1 hour',
      '2 hours',
      '8 hours',
      '1 day',
      '7 days',
      '30 days',
    ])
  })

  it('keep a stored limit that is no preset, in its place', () => {
    // Act
    const choices = maxTtlChoices(Option.some(Duration.days(365)))

    // Assert
    expect(choices.map(({ label }) => label)).toEqual([
      'No limit (365 days at most)',
      '1 day',
      '7 days',
      '30 days',
      '90 days',
      '365 days',
    ])
  })

  it('should map every choice’s value back to its limit, whatever limit is stored', () => {
    fc.assert(
      fc.property(
        fc.option(
          fc.integer({ min: 1, max: 365 * 86_400 }).map((seconds) => Duration.seconds(seconds)),
          { nil: undefined }
        ),
        (stored) => {
          // Arrange
          const current = Option.fromNullable(stored)
          const choices = [...idleTtlChoices(current), ...maxTtlChoices(current)]

          // Assert
          for (const choice of choices) {
            expect(choiceValue(choice.limit)).toBe(choice.value)
            expect(limitOfChoice(choices, choice.value)).toEqual(Option.some(choice.limit))
          }
          expect(Array.some(choices, (choice) => choice.value === choiceValue(current))).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('know no choice for a value none of them has', () => {
    expect(limitOfChoice(idleTtlChoices(Option.none()), '42')).toEqual(Option.none())
  })
})

describe('isSamePolicy', () => {
  it('compares each limit by its length, and the session tie', () => {
    // Arrange
    const policy = {
      idleTtl: Option.some(Duration.hours(2)),
      maxTtl: Option.none(),
      endsWithBrowserSession: true,
    }

    // Act / Assert
    expect(isSamePolicy(policy, { ...policy, idleTtl: Option.some(Duration.minutes(120)) })).toBe(
      true
    )
    expect(isSamePolicy(policy, { ...policy, maxTtl: Option.some(Duration.days(1)) })).toBe(false)
    expect(isSamePolicy(policy, { ...policy, endsWithBrowserSession: false })).toBe(false)
  })
})

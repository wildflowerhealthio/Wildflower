import { Duration, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { RefreshPolicy } from './index.ts'

describe('RefreshPolicy.equivalence', () => {
  it('compares each limit by its length, and the session tie', () => {
    // Arrange
    const policy: RefreshPolicy.Type = {
      idleTtl: Option.some(Duration.hours(2)),
      maxTtl: Option.none(),
      endsWithBrowserSession: true,
    }

    // Act / Assert
    expect(
      RefreshPolicy.equivalence(policy, { ...policy, idleTtl: Option.some(Duration.minutes(120)) })
    ).toBe(true)
    expect(RefreshPolicy.equivalence(policy, { ...policy, idleTtl: Option.none() })).toBe(false)
    expect(
      RefreshPolicy.equivalence(policy, { ...policy, maxTtl: Option.some(Duration.days(1)) })
    ).toBe(false)
    expect(RefreshPolicy.equivalence(policy, { ...policy, endsWithBrowserSession: false })).toBe(
      false
    )
  })
})

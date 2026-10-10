import { Option } from 'effect'
import * as fc from 'fast-check'
import { arrivingSmartLaunchFrom, isAuthorizationResponse } from 'gatekeeper-core/smart-client'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it, vi } from 'vite-plus/test'

import { resetAuthControlsOnBackForwardRestore, searchSettledFrom } from './arrival.ts'

describe('searchSettledFrom', () => {
  it('should drop the authorization server’s iss (RFC 9207) from a return leg', () => {
    // Act
    const settled = searchSettledFrom(
      '?server=https%3A%2F%2Fruth.wildflowerhealth.io&code=abc&state=xyz' +
        '&iss=https%3A%2F%2Fruth.wildflowerhealth.io'
    )

    // Assert — the reloaded page keeps its target and reads no launch
    expect(settled).toBe('?server=https%3A%2F%2Fruth.wildflowerhealth.io')
    expect(arrivingSmartLaunchFrom(settled)).toStrictEqual(Option.none())
  })

  it('should turn a SMART launch into the server its iss names', () => {
    // Act / Assert
    expect(
      searchSettledFrom('?iss=https%3A%2F%2Fruth.wildflowerhealth.io%2Ffhir-r4&launch=xyz')
    ).toBe('?server=https%3A%2F%2Fruth.wildflowerhealth.io')
  })

  it('should leave an ordinary load as it arrived', () => {
    // Act / Assert
    expect(searchSettledFrom('?server=https%3A%2F%2Fruth.wildflowerhealth.io')).toBe(
      '?server=https%3A%2F%2Fruth.wildflowerhealth.io'
    )
    expect(searchSettledFrom('')).toBe('')
  })

  it('should settle on a query a reload reads as neither a return nor a launch', () => {
    fc.assert(
      fc.property(
        fc.dictionary(fc.string(), fc.string()),
        fc.subarray(ARRIVAL_PARAMS),
        fc.string(),
        (noise, arrived, value) => {
          // Arrange — any mix of a return leg's and a launch's params, beside noise
          const params = new URLSearchParams(noise)
          for (const name of arrived) params.set(name, value)

          // Act
          const settled = searchSettledFrom(`?${params.toString()}`)

          // Assert
          expect(isAuthorizationResponse(settled)).toBe(false)
          expect(arrivingSmartLaunchFrom(settled)).toStrictEqual(Option.none())
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('resetAuthControlsOnBackForwardRestore', () => {
  it('should reset the controls when the page is restored from the back-forward cache', () => {
    // Arrange
    const page = new EventTarget()
    const resetAuthControls = vi.fn()
    resetAuthControlsOnBackForwardRestore(page, resetAuthControls)

    // Act
    page.dispatchEvent(pageshow({ persisted: true }))

    // Assert
    expect(resetAuthControls).toHaveBeenCalledOnce()
  })

  it('should leave the controls alone on an ordinary pageshow', () => {
    // Arrange
    const page = new EventTarget()
    const resetAuthControls = vi.fn()
    resetAuthControlsOnBackForwardRestore(page, resetAuthControls)

    // Act
    page.dispatchEvent(pageshow({ persisted: false }))

    // Assert
    expect(resetAuthControls).not.toHaveBeenCalled()
  })
})

// Helpers

/** Every param a return leg (RFC 6749 §4.1.2, RFC 9207) or a SMART launch arrives with. */
const ARRIVAL_PARAMS = ['code', 'state', 'error', 'error_description', 'error_uri', 'iss', 'launch']

/**
 * A `pageshow` event as the browser dispatches it. Node has no
 * `PageTransitionEvent`, so `persisted` is set on a plain `Event`.
 */
const pageshow = ({ persisted }: { persisted: boolean }): Event =>
  Object.assign(new Event('pageshow'), { persisted })

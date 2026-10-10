import { act, cleanup, renderHook } from '@testing-library/react'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import {
  readConsent,
  type TelemetryConsent,
  writeConsent,
} from '@wildflowerhealthio/telemetry-core'
import * as fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { mapConsentStorage } from './telemetry-consent.test-helpers.ts'
import { useTelemetryConsent } from './use-telemetry-consent.ts'

const CURRENT_VERSION = 3
const NOW = new Date('2026-09-29T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const storedConsent = (overrides: Partial<TelemetryConsent> = {}): TelemetryConsent => ({
  version: CURRENT_VERSION,
  crashReports: true,
  performance: false,
  decidedAt: '2026-09-01T08:00:00.000Z',
  ...overrides,
})

describe('useTelemetryConsent', () => {
  it('should leave the dialog open and report nothing while no answer is stored', () => {
    // Arrange
    const onDecided = vi.fn()

    // Act
    const { result } = renderHook(() =>
      useTelemetryConsent({ storage: mapConsentStorage(), version: CURRENT_VERSION, onDecided })
    )

    // Assert
    expect(result.current.consent).toBeUndefined()
    expect(result.current.dialogOpen).toBe(true)
    expect(onDecided).not.toHaveBeenCalled()
  })

  it('should re-ask when the stored answer is for another copy version', () => {
    // Arrange
    const storage = mapConsentStorage()
    writeConsent(storage, storedConsent({ version: CURRENT_VERSION - 1 }))
    const onDecided = vi.fn()

    // Act
    const { result } = renderHook(() =>
      useTelemetryConsent({ storage, version: CURRENT_VERSION, onDecided })
    )

    // Assert
    expect(result.current.consent).toBeUndefined()
    expect(result.current.dialogOpen).toBe(true)
    expect(onDecided).not.toHaveBeenCalled()
  })

  it('should skip the dialog and report a stored current answer on mount', () => {
    // Arrange
    const storage = mapConsentStorage()
    const stored = storedConsent()
    writeConsent(storage, stored)
    const onDecided = vi.fn()

    // Act
    const { result } = renderHook(() =>
      useTelemetryConsent({ storage, version: CURRENT_VERSION, onDecided })
    )

    // Assert
    expect(result.current.consent).toStrictEqual(stored)
    expect(result.current.dialogOpen).toBe(false)
    expect(onDecided).toHaveBeenCalledTimes(1)
    expect(onDecided).toHaveBeenCalledWith(stored)
  })

  it('should keep any answer with the copy version and the time, close the dialog and report it', () => {
    fc.assert(
      fc.property(fc.boolean(), fc.boolean(), (crashReports, performance) => {
        // Arrange
        const storage = mapConsentStorage()
        const onDecided = vi.fn()
        const { result } = renderHook(() =>
          useTelemetryConsent({ storage, version: CURRENT_VERSION, onDecided })
        )

        // Act
        act(() => result.current.decide({ crashReports, performance }))

        // Assert
        const expected: TelemetryConsent = {
          version: CURRENT_VERSION,
          crashReports,
          performance,
          decidedAt: NOW.toISOString(),
        }
        expect(readConsent(storage, CURRENT_VERSION)).toStrictEqual(expected)
        expect(result.current.consent).toStrictEqual(expected)
        expect(result.current.dialogOpen).toBe(false)
        expect(onDecided).toHaveBeenCalledTimes(1)
        expect(onDecided).toHaveBeenCalledWith(expected)
        cleanup()
      }),
      { numRuns: numRunsFor({ base: 8 }) }
    )
  })

  it('should reopen the dialog over a given answer and close it on the next decision', () => {
    // Arrange
    const storage = mapConsentStorage()
    writeConsent(storage, storedConsent({ crashReports: true, performance: true }))
    const onDecided = vi.fn()
    const { result } = renderHook(() =>
      useTelemetryConsent({ storage, version: CURRENT_VERSION, onDecided })
    )

    // Act
    act(() => result.current.reopen())

    // Assert
    expect(result.current.dialogOpen).toBe(true)
    expect(result.current.consent?.crashReports).toBe(true)

    // Act
    act(() => result.current.decide({ crashReports: false, performance: false }))

    // Assert
    expect(result.current.dialogOpen).toBe(false)
    expect(readConsent(storage, CURRENT_VERSION)?.crashReports).toBe(false)
    expect(onDecided).toHaveBeenLastCalledWith(
      storedConsent({ crashReports: false, performance: false, decidedAt: NOW.toISOString() })
    )
  })

  it('should throw from decide, keeping the dialog open, when storage refuses the answer', () => {
    // Arrange
    const quotaError = new Error('QuotaExceededError')
    const storage = {
      ...mapConsentStorage(),
      setItem: () => {
        throw quotaError
      },
    }
    const onDecided = vi.fn()
    const { result } = renderHook(() =>
      useTelemetryConsent({ storage, version: CURRENT_VERSION, onDecided })
    )

    // Act + Assert
    expect(() => result.current.decide({ crashReports: true, performance: true })).toThrow(
      quotaError
    )
    expect(result.current.dialogOpen).toBe(true)
    expect(onDecided).not.toHaveBeenCalled()
  })
})

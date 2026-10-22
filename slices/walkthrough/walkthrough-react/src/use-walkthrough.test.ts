import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import {
  readSeenWalkthrough,
  type SeenWalkthrough,
  writeSeenWalkthrough,
} from '@wildflowerhealthio/walkthrough-core'
import { DateTime } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { useWalkthrough } from './use-walkthrough.ts'
import { mapWalkthroughStorage } from './walkthrough.test-helpers.ts'

const WALKTHROUGH_ID = 'home'
const CURRENT_VERSION = 2
const NOW = new Date('2026-10-22T12:00:00.000Z')

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const storedRecord = (overrides: Partial<SeenWalkthrough> = {}): SeenWalkthrough => ({
  version: CURRENT_VERSION,
  outcome: 'Finished',
  decidedAt: DateTime.unsafeMake('2026-10-01T08:00:00.000Z'),
  ...overrides,
})

describe('useWalkthrough', () => {
  it('should open while nothing is recorded', () => {
    // Act
    const { result } = renderHook(() =>
      useWalkthrough({
        storage: mapWalkthroughStorage(),
        id: WALKTHROUGH_ID,
        version: CURRENT_VERSION,
      })
    )

    // Assert
    expect(result.current.open).toBe(true)
  })

  it('should stay closed when the current version is recorded', () => {
    // Arrange
    const storage = mapWalkthroughStorage()
    writeSeenWalkthrough(storage, WALKTHROUGH_ID, storedRecord({ outcome: 'Skipped' }))

    // Act
    const { result } = renderHook(() =>
      useWalkthrough({ storage, id: WALKTHROUGH_ID, version: CURRENT_VERSION })
    )

    // Assert
    expect(result.current.open).toBe(false)
  })

  it('should open again when the record is for an earlier version', () => {
    // Arrange
    const storage = mapWalkthroughStorage()
    writeSeenWalkthrough(storage, WALKTHROUGH_ID, storedRecord({ version: CURRENT_VERSION - 1 }))

    // Act
    const { result } = renderHook(() =>
      useWalkthrough({ storage, id: WALKTHROUGH_ID, version: CURRENT_VERSION })
    )

    // Assert
    expect(result.current.open).toBe(true)
  })

  it.each([
    { label: 'finish', outcome: 'Finished' },
    { label: 'skip', outcome: 'Skipped' },
  ] as const)(
    'should record $outcome with the version and the time on $label, and close',
    ({ label, outcome }) => {
      // Arrange
      const storage = mapWalkthroughStorage()
      const { result } = renderHook(() =>
        useWalkthrough({ storage, id: WALKTHROUGH_ID, version: CURRENT_VERSION })
      )

      // Act
      act(() => result.current[label]())

      // Assert
      expect(readSeenWalkthrough(storage, WALKTHROUGH_ID, CURRENT_VERSION)).toStrictEqual({
        version: CURRENT_VERSION,
        outcome,
        decidedAt: DateTime.unsafeMake(NOW),
      })
      expect(result.current.open).toBe(false)
    }
  )

  it('should reopen over a record and replace it on the next outcome', () => {
    // Arrange
    const storage = mapWalkthroughStorage()
    writeSeenWalkthrough(storage, WALKTHROUGH_ID, storedRecord({ outcome: 'Skipped' }))
    const { result } = renderHook(() =>
      useWalkthrough({ storage, id: WALKTHROUGH_ID, version: CURRENT_VERSION })
    )

    // Act
    act(() => result.current.reopen())

    // Assert
    expect(result.current.open).toBe(true)

    // Act
    act(() => result.current.finish())

    // Assert
    expect(result.current.open).toBe(false)
    expect(readSeenWalkthrough(storage, WALKTHROUGH_ID, CURRENT_VERSION)).toStrictEqual(
      storedRecord({ outcome: 'Finished', decidedAt: DateTime.unsafeMake(NOW) })
    )
  })

  it('should throw from finish, closed with nothing kept, when storage refuses the record', async () => {
    // Arrange
    const quotaError = new Error('QuotaExceededError')
    const storage = {
      ...mapWalkthroughStorage(),
      setItem: () => {
        throw quotaError
      },
    }
    const { result } = renderHook(() =>
      useWalkthrough({ storage, id: WALKTHROUGH_ID, version: CURRENT_VERSION })
    )

    // Act + Assert
    expect(() => result.current.finish()).toThrow(quotaError)
    await waitFor(() => {
      expect(result.current.open).toBe(false)
    })
    expect(readSeenWalkthrough(storage, WALKTHROUGH_ID, CURRENT_VERSION)).toBeUndefined()
  })

  it('should close on postpone without recording, and open again on reopen', () => {
    // Arrange
    const storage = mapWalkthroughStorage()
    const { result } = renderHook(() =>
      useWalkthrough({ storage, id: WALKTHROUGH_ID, version: CURRENT_VERSION })
    )

    // Act
    act(() => result.current.postpone())

    // Assert
    expect(result.current.open).toBe(false)
    expect(readSeenWalkthrough(storage, WALKTHROUGH_ID, CURRENT_VERSION)).toBeUndefined()

    // Act
    act(() => result.current.reopen())

    // Assert
    expect(result.current.open).toBe(true)
  })

  it('should read the record again when the id or version changes', () => {
    // Arrange
    const storage = mapWalkthroughStorage()
    writeSeenWalkthrough(storage, 'finished', storedRecord())
    const { result, rerender } = renderHook(
      ({ id, version }: { readonly id: string; readonly version: number }) =>
        useWalkthrough({ storage, id, version }),
      { initialProps: { id: 'finished', version: CURRENT_VERSION } }
    )
    expect(result.current.open).toBe(false)

    // Act
    rerender({ id: 'unseen', version: CURRENT_VERSION })

    // Assert
    expect(result.current.open).toBe(true)

    // Act
    rerender({ id: 'finished', version: CURRENT_VERSION })

    // Assert
    expect(result.current.open).toBe(false)

    // Act
    rerender({ id: 'finished', version: CURRENT_VERSION + 1 })

    // Assert
    expect(result.current.open).toBe(true)
  })
})

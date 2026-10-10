import { act, renderHook } from '@testing-library/react'
import type { TelemetryConsent } from 'telemetry-core'
import type * as TelemetryWeb from 'telemetry-web'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { useConsentedTelemetryStart } from './use-consented-telemetry-start.ts'

// Starting the SDK is stubbed at the module boundary: each test reads back
// what the hook handed it, and decides whether that answer started anything.
// The rest of the module stays real, so the config is the one an app gets.
const { initConsentedTelemetryMock } = vi.hoisted(() => ({
  initConsentedTelemetryMock: vi.fn<typeof TelemetryWeb.initConsentedTelemetry>(() => false),
}))
vi.mock('telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  initConsentedTelemetry: initConsentedTelemetryMock,
}))

const APP_DSN = 'https://key@sentry.example/9'
const TAGS = { app: 'launcher-web', entry: 'main-web' } as const

const consentWith = (switches: {
  readonly crashReports: boolean
  readonly performance: boolean
}): TelemetryConsent => ({ version: 1, decidedAt: '2026-09-29T12:00:00.000Z', ...switches })

const YES = consentWith({ crashReports: true, performance: true })
const NO = consentWith({ crashReports: false, performance: false })

afterEach(() => {
  vi.unstubAllEnvs()
  vi.resetAllMocks()
})

describe('useConsentedTelemetryStart', () => {
  it('should hand the answer, the app’s DSN, its service name and its tags to the SDK start', () => {
    // Arrange
    const { result } = renderHook(() => useConsentedTelemetryStart({ dsn: APP_DSN, tags: TAGS }))

    // Act
    act(() => {
      result.current.startTelemetry(YES)
    })

    // Assert
    expect(initConsentedTelemetryMock).toHaveBeenCalledTimes(1)
    const [{ consent, config, tags }] = initConsentedTelemetryMock.mock.calls[0]
    expect(consent).toBe(YES)
    expect(config.sentry.dsn).toBe(APP_DSN)
    expect(config.otel.serviceName).toBe(TAGS.app)
    expect(tags).toStrictEqual(TAGS)
  })

  it.each([
    { case: 'its own DSN', appDsn: APP_DSN },
    { case: 'no DSN of its own', appDsn: '' },
  ])('should never let a shared VITE_SENTRY_DSN stand in when the app has $case', ({ appDsn }) => {
    // Arrange
    vi.stubEnv('VITE_SENTRY_DSN', 'https://shared@sentry.example/1')
    const { result } = renderHook(() => useConsentedTelemetryStart({ dsn: appDsn, tags: TAGS }))

    // Act
    act(() => {
      result.current.startTelemetry(YES)
    })

    // Assert
    expect(initConsentedTelemetryMock.mock.calls[0][0].config.sentry.dsn).toBe(appDsn)
  })

  it('should report not started, and skip the first-start call, while no answer starts the SDK', () => {
    // Arrange
    const onFirstStart = vi.fn<() => void>()
    const { result } = renderHook(() =>
      useConsentedTelemetryStart({ dsn: APP_DSN, tags: TAGS, onFirstStart })
    )

    // Act
    act(() => {
      result.current.startTelemetry(NO)
    })

    // Assert
    expect(result.current.telemetryStarted).toBe(false)
    expect(onFirstStart).not.toHaveBeenCalled()
  })

  it('should report started, and make the first-start call once, across every answer that starts it', () => {
    // Arrange
    initConsentedTelemetryMock.mockReturnValue(true)
    const onFirstStart = vi.fn<() => void>()
    const { result } = renderHook(() =>
      useConsentedTelemetryStart({ dsn: APP_DSN, tags: TAGS, onFirstStart })
    )

    // Act
    act(() => {
      result.current.startTelemetry(YES)
    })
    act(() => {
      result.current.startTelemetry(consentWith({ crashReports: true, performance: false }))
    })

    // Assert
    expect(result.current.telemetryStarted).toBe(true)
    expect(onFirstStart).toHaveBeenCalledTimes(1)
  })

  it('should make the first-start call on the first answer that starts it, after one that did not', () => {
    // Arrange
    const onFirstStart = vi.fn<() => void>()
    const { result } = renderHook(() =>
      useConsentedTelemetryStart({ dsn: APP_DSN, tags: TAGS, onFirstStart })
    )
    act(() => {
      result.current.startTelemetry(NO)
    })

    // Act
    initConsentedTelemetryMock.mockReturnValue(true)
    act(() => {
      result.current.startTelemetry(YES)
    })

    // Assert
    expect(onFirstStart).toHaveBeenCalledTimes(1)
    expect(result.current.telemetryStarted).toBe(true)
  })
})

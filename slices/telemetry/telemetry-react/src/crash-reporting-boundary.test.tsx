import { cleanup, render, screen } from '@testing-library/react'
import type * as TelemetryWeb from 'telemetry-web'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { CrashReportingBoundary } from './crash-reporting-boundary.tsx'

/** The part of Sentry's `captureException` hint the boundary sets. */
interface CaptureHint {
  readonly extra?: { readonly componentStack?: string }
}

// Sentry is the collaborator the boundary reports to: stubbed at the module
// boundary so each test reads back what was reported.
const { captureExceptionMock } = vi.hoisted(() => ({
  captureExceptionMock: vi.fn<(exception: unknown, hint?: CaptureHint) => string>(() => 'event-id'),
}))
vi.mock('telemetry-web', async (importOriginal) => ({
  ...(await importOriginal<typeof TelemetryWeb>()),
  Sentry: { captureException: captureExceptionMock },
}))

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  captureExceptionMock.mockClear()
})

describe('CrashReportingBoundary', () => {
  it('should render its children, and report nothing, while they render', () => {
    // Arrange / Act
    render(
      <CrashReportingBoundary extraContext={{ app: 'medications-app' }}>
        <p>the app</p>
      </CrashReportingBoundary>
    )

    // Assert
    expect(screen.getByText('the app')).toBeDefined()
    expect(captureExceptionMock).not.toHaveBeenCalled()
  })

  it('should report a render error with its component stack, and show the fallback at the heading level asked for', () => {
    // Arrange
    const renderFailure = new Error('the app failed to render')

    // Act
    render(
      <CrashReportingBoundary extraContext={{ entry: 'main-web' }} headingLevel={2}>
        <Throws error={renderFailure} />
      </CrashReportingBoundary>
    )

    // Assert
    expect(captureExceptionMock).toHaveBeenCalledTimes(1)
    const [reported, hint] = captureExceptionMock.mock.calls[0]
    expect(reported).toBe(renderFailure)
    expect(hint?.extra?.componentStack).toContain('Throws')
    expect(screen.getByRole('heading', { level: 2, name: 'Something went wrong' })).toBeDefined()
  })

  it('should show its context, with the build mode, in the fallback', () => {
    // Arrange / Act
    render(
      <CrashReportingBoundary extraContext={{ entry: 'main-web' }}>
        <Throws error={new Error('boom')} />
      </CrashReportingBoundary>
    )

    // Assert
    const contextPane = screen.getByText('Context').closest('details')?.querySelector('pre')
    const shownContext: unknown = JSON.parse(contextPane?.textContent ?? '{}')
    expect(shownContext).toMatchObject({ entry: 'main-web', mode: import.meta.env.MODE })
  })
})

/** Throws `error` from render, as a crashing app does. */
function Throws({ error }: { readonly error: Error }): never {
  throw error
}

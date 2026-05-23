import { render, screen } from '@testing-library/react'
import type { ErrorInfo, JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { ErrorBoundary } from './error-boundary.tsx'

const Boom = ({ message }: { readonly message: string }): JSX.Element => {
  throw new Error(message)
}

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('ErrorBoundary', () => {
  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <p>healthy</p>
      </ErrorBoundary>
    )
    expect(screen.getByText('healthy')).toBeTruthy()
  })

  it('renders the fallback with the error name and message when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom message="network unreachable" />
      </ErrorBoundary>
    )
    expect(screen.getByRole('heading', { name: 'Something went wrong' })).toBeTruthy()
    // The stack panel also contains the message; scope to the alert summary line.
    expect(screen.getByRole('alertdialog').textContent).toContain('Error: network unreachable')
  })

  it('uses a custom title when provided', () => {
    render(
      <ErrorBoundary title="App crashed">
        <Boom message="x" />
      </ErrorBoundary>
    )
    expect(screen.getByRole('heading', { name: 'App crashed' })).toBeTruthy()
  })

  it('invokes onError with the error and a componentStack', () => {
    const onError = vi.fn<(error: unknown, info: ErrorInfo) => void>()
    render(
      <ErrorBoundary onError={onError}>
        <Boom message="reportable" />
      </ErrorBoundary>
    )
    expect(onError).toHaveBeenCalledTimes(1)
    const [error, info] = onError.mock.calls[0]
    if (!(error instanceof Error)) throw new Error('expected an Error instance')
    expect(error.message).toBe('reportable')
    expect(info.componentStack).toMatch(/Boom/)
  })

  it('renders the Reload and Copy buttons', () => {
    render(
      <ErrorBoundary>
        <Boom message="x" />
      </ErrorBoundary>
    )
    expect(screen.getByRole('button', { name: 'Reload' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Copy details' })).toBeTruthy()
  })

  it('renders extraContext entries inside the Context details pane', () => {
    render(
      <ErrorBoundary extraContext={{ buildCommit: 'abc1234', mode: 'production' }}>
        <Boom message="x" />
      </ErrorBoundary>
    )
    const contextPre = screen.getByText(/buildCommit/)
    expect(contextPre.textContent).toContain('abc1234')
    expect(contextPre.textContent).toContain('production')
    expect(contextPre.textContent).toMatch(/capturedAt/)
  })
})

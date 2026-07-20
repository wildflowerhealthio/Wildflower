import { cleanup, render, screen } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import { ErrorBanner } from './error-banner.tsx'
import { ErrorBodyRendererContext, type ErrorBodyRenderer } from './error-body-renderer.ts'

afterEach(() => {
  cleanup()
})

/** Mount `ErrorBanner` under an optional ambient renderer. */
const renderBanner = (
  error: unknown,
  renderer?: ErrorBodyRenderer,
  override?: ErrorBodyRenderer
): ReturnType<typeof render> =>
  render(
    <ErrorBodyRendererContext.Provider value={renderer ?? null}>
      <ErrorBanner error={error} renderError={override} />
    </ErrorBodyRendererContext.Provider>
  )

describe('ErrorBanner', () => {
  it('renders nothing in the resting (no-error) state', () => {
    const { container: nullContainer } = renderBanner(null)
    expect(nullContainer.firstChild).toBeNull()
    const { container: undefinedContainer } = renderBanner(undefined)
    expect(undefinedContainer.firstChild).toBeNull()
  })

  it("shows an Error's message in an alert callout", () => {
    renderBanner(new Error('deletion failed'))
    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('deletion failed')
  })

  it('stringifies a non-Error value', () => {
    renderBanner('plain string failure')
    expect(screen.getByRole('alert').textContent).toContain('plain string failure')
  })

  it('defers to the ambient renderer when it recognises the error', () => {
    const error = new Error('403')
    const renderer: ErrorBodyRenderer = (value): ReactNode =>
      value === error ? <div data-testid="surface">no permission</div> : null
    renderBanner(error, renderer)
    expect(screen.getByTestId('surface')).toBeTruthy()
    // The recognised surface replaces the message callout, not nests in it.
    expect(screen.queryByText('403')).toBeNull()
  })

  it('falls through to the message when the ambient renderer returns null', () => {
    const renderer: ErrorBodyRenderer = () => null
    renderBanner(new Error('unrecognised'), renderer)
    expect(screen.getByRole('alert').textContent).toContain('unrecognised')
  })

  it('prefers the renderError prop over the ambient renderer', () => {
    const ambient: ErrorBodyRenderer = () => <div data-testid="ambient">ambient</div>
    const override: ErrorBodyRenderer = () => <div data-testid="override">override</div>
    renderBanner(new Error('boom'), ambient, override)
    expect(screen.getByTestId('override')).toBeTruthy()
    expect(screen.queryByTestId('ambient')).toBeNull()
  })
})

import { act, render, screen, waitFor } from '@testing-library/react'
import { Suspense, type JSX } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { Awaited } from './awaited.tsx'

afterEach(() => {
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

beforeEach(() => {
  // CatchBoundary logs caught errors through console.error; silence the noise
  // so the test output stays readable while still exercising the error path.
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

/**
 * Render `node` inside a `<Suspense>` boundary. `Awaited`'s underlying
 * `<Await>` suspends on the deferred promise, so the boundary is required
 * for the initial pending → resolved transition to show up in the DOM.
 */
const renderSuspended = (node: JSX.Element): ReturnType<typeof render> =>
  render(<Suspense fallback={<p>loading</p>}>{node}</Suspense>)

describe('Awaited', () => {
  it('renders children with the resolved value once the promise settles', async () => {
    // Arrange — a promise that resolves with a known payload. The generic
    // is left to be inferred from `Promise.resolve('hello')` to verify
    // that the resolved-value type flows into `children` without an
    // explicit annotation on the render-prop parameter.
    const promise = Promise.resolve('hello')

    // Act
    await act(async () => {
      renderSuspended(
        <Awaited promise={promise}>{(value) => <p data-testid="resolved">{value}</p>}</Awaited>
      )
      await promise
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByTestId('resolved').textContent).toBe('hello')
    })
  }, 15_000)

  it('renders the default AsyncErrorView with the configured errorTitle on rejection', async () => {
    // Arrange — a rejected promise. The caught copy keeps Node from
    // logging an unhandled rejection while leaving the thrown value
    // intact for React to observe via `use()`.
    const failure = new Error('not found')
    const promise = Promise.reject<string>(failure)
    const settled = promise.catch(() => {})

    // Act
    await act(async () => {
      renderSuspended(
        <Awaited promise={promise} errorTitle="Not Found">
          {(value) => <p>{value}</p>}
        </Awaited>
      )
      await settled
    })

    // Assert — the CatchBoundary renders AsyncErrorView, which surfaces
    // the configured title and the error's message via PageError.
    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Not Found' })).toBeTruthy()
    })
    expect(screen.getByText('not found')).toBeTruthy()
  }, 15_000)

  it('invokes a custom errorComponent with the thrown value, bypassing the default view', async () => {
    // Arrange — supply both `errorComponent` and verify (a) it receives
    // the original thrown value and (b) it replaces the default
    // AsyncErrorView entirely.
    const failure = new Error('boom')
    const promise = Promise.reject<string>(failure)
    const settled = promise.catch(() => {})
    const errorComponent = vi.fn((error: unknown) => (
      <p data-testid="custom-error">custom: {error instanceof Error ? error.message : 'unknown'}</p>
    ))

    // Act
    await act(async () => {
      renderSuspended(
        <Awaited promise={promise} errorComponent={errorComponent}>
          {(value) => <p>{value}</p>}
        </Awaited>
      )
      await settled
    })

    // Assert
    await waitFor(() => {
      expect(screen.getByTestId('custom-error').textContent).toBe('custom: boom')
    })
    expect(errorComponent).toHaveBeenCalledWith(failure)
    // The default view should not render alongside the override.
    expect(screen.queryByRole('heading')).toBeNull()
  }, 15_000)

  it('clears a previously-displayed error when resetKey changes', async () => {
    // Arrange — render with a rejected promise + initial `resetKey`,
    // confirm the error is visible, then re-render with a fresh
    // resolved promise and a bumped `resetKey`. The CatchBoundary
    // should reset and surface the new resolved value.
    const failure = new Error('first failure')
    const failed = Promise.reject<string>(failure)
    const failedSettled = failed.catch(() => {})

    let rendered: ReturnType<typeof render> | undefined
    await act(async () => {
      rendered = renderSuspended(
        <Awaited promise={failed} resetKey="v1" errorTitle="Boom">
          {(value) => <p data-testid="resolved">{value}</p>}
        </Awaited>
      )
      await failedSettled
    })
    if (rendered === undefined) throw new Error('render did not run')
    const { rerender } = rendered

    await waitFor(() => {
      expect(screen.getByRole('heading', { name: 'Boom' })).toBeTruthy()
    })

    // Act — swap in a resolved promise under a new resetKey.
    const recovered = Promise.resolve('recovered')
    await act(async () => {
      rerender(
        <Suspense fallback={<p>loading</p>}>
          <Awaited promise={recovered} resetKey="v2" errorTitle="Boom">
            {(value) => <p data-testid="resolved">{value}</p>}
          </Awaited>
        </Suspense>
      )
      await recovered
    })

    // Assert — the resolved value displaces the prior error UI.
    await waitFor(() => {
      expect(screen.getByTestId('resolved').textContent).toBe('recovered')
    })
    expect(screen.queryByRole('heading', { name: 'Boom' })).toBeNull()
  }, 15_000)
})

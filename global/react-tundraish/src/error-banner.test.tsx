import { cleanup, render, screen } from '@testing-library/react'
import { Data, Effect } from 'effect'
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

  it("reveals an Error's stack behind a Show details disclosure", () => {
    const error = new Error('deletion failed')
    error.stack =
      'Error: deletion failed\n    at deleteThing (thing.ts:42)\n    at handleClick (button.tsx:7)'
    renderBanner(error)
    const summary = screen.getByText('Show details')
    // The stack lives inside the closed <details>, so it is in the DOM but
    // hidden from the accessibility tree — assert against textContent.
    const details = summary.closest('details')
    if (details === null) throw new Error('expected a <details> element around the summary')
    expect(details.open).toBe(false)
    expect(details.textContent).toContain('deleteThing (thing.ts:42)')
    expect(details.textContent).toContain('handleClick (button.tsx:7)')
  })

  it('walks the .cause chain into the disclosure', () => {
    const root = new Error('socket closed')
    const wrapped = new Error('anonymize failed', { cause: root })
    renderBanner(wrapped)
    const details = screen.getByText('Show details').closest('details')
    if (details === null) throw new Error('expected a <details> element')
    expect(details.textContent).toContain('caused by Error: socket closed')
  })

  it('surfaces a subclass toString that pretty-prints beyond the message', () => {
    class FiberFailureLike extends Error {
      override name = 'FiberFailureLike'
      override toString(): string {
        return 'FiberFailureLike: An error has occurred\nCause: DecodeError { path: /entries/3/response/status }'
      }
    }
    const error = new FiberFailureLike('An error has occurred')
    renderBanner(error)
    const details = screen.getByText('Show details').closest('details')
    if (details === null) throw new Error('expected a <details> element')
    expect(details.textContent).toContain('DecodeError')
    expect(details.textContent).toContain('/entries/3/response/status')
  })

  it('omits the disclosure when there is nothing to add', () => {
    renderBanner('plain string failure')
    expect(screen.queryByText('Show details')).toBeNull()
  })

  it("serialises a tagged error's own fields into the disclosure", () => {
    class Tagged extends Data.TaggedError('PseudonymSpaceExhausted')<{
      readonly shape: string
      readonly attempts: number
    }> {}
    renderBanner(new Tagged({ shape: 'digit(1)', attempts: 100 }))
    const details = screen.getByText('Show details').closest('details')
    if (details === null) throw new Error('expected a <details> element')
    expect(details.textContent).toContain('"shape": "digit(1)"')
    expect(details.textContent).toContain('"attempts": 100')
  })

  it("unwraps a FiberFailure so the wrapped tagged error's fields surface", async () => {
    // The path the anonymize screen actually takes: `Effect.runPromise` on a
    // `Data.TaggedError` failure rejects with a `FiberFailure` whose own
    // `.message` is Effect's generic "An error has occurred" and whose
    // instance carries none of the tagged fields — those live inside
    // `.toJSON().cause.failure`.
    class Tagged extends Data.TaggedError('PseudonymSpaceExhausted')<{
      readonly shape: string
      readonly attempts: number
    }> {}
    const rejected = await Effect.runPromise(
      Effect.fail(new Tagged({ shape: 'digit(1)', attempts: 100 }))
    ).then(
      () => {
        throw new Error('expected the effect to reject')
      },
      (cause: unknown) => cause
    )
    renderBanner(rejected)
    const details = screen.getByText('Show details').closest('details')
    if (details === null) throw new Error('expected a <details> element')
    expect(details.textContent).toContain('"_tag": "PseudonymSpaceExhausted"')
    expect(details.textContent).toContain('"shape": "digit(1)"')
    expect(details.textContent).toContain('"attempts": 100')
  })
})

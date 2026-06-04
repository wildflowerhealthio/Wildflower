import { Component, type ErrorInfo, type ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './error-boundary.module.css'
import pageLayout from './page-layout.module.css'

type Json = string | number | boolean | null | readonly Json[] | { readonly [k: string]: Json }

interface ErrorBoundaryProps {
  readonly children: ReactNode
  /** Heading shown above the summary line. Defaults to "Something went wrong". */
  readonly title?: string
  /** Heading level for the title. Defaults to 1. */
  readonly headingLevel?: 1 | 2 | 3 | 4 | 5 | 6
  /**
   * Invoked after the boundary captures a render-tree error. Forward to
   * your telemetry sink — e.g. `Sentry.captureException(error, { extra: { componentStack } })`.
   */
  readonly onError?: (error: unknown, info: ErrorInfo) => void
  /**
   * App-specific context to merge into the "Context" details pane and
   * the copyable JSON blob. Use for build/version info, feature flags,
   * embedded-vs-standalone, etc. — anything not derivable from `window`
   * inside this library.
   */
  readonly extraContext?: { readonly [k: string]: Json }
}

interface CaughtError {
  readonly error: unknown
  readonly componentStack: string | null
  readonly capturedAt: string
}

interface ErrorBoundaryState {
  readonly caught: CaughtError | null
}

function normalizeError(error: unknown): {
  name: string
  message: string
  stack: string | null
} {
  if (error instanceof Error) {
    return { name: error.name, message: error.message, stack: error.stack ?? null }
  }
  return { name: 'NonErrorThrown', message: String(error), stack: null }
}

/**
 * Catch-all React error boundary. Renders a summary line plus collapsed
 * `<details>` panes for the error stack, component stack, and a context
 * blob, with buttons to copy the full debug JSON or reload the page.
 *
 * Pass {@link ErrorBoundaryProps.onError} to forward to a telemetry sink.
 * Use {@link ErrorBoundaryProps.extraContext} to inject app-specific
 * build/environment fields.
 *
 * @remarks
 * Unlike most surfaces in `react-tundraish`, the rendered fallback wraps
 * itself in `pageLayout.page`. This is a deliberate exception: the
 * boundary mounts at the React root, above the router and above any
 * layout-route page shell, so a render-tree crash inside a `.page`-
 * providing layout still gets a centered, padded shell from the boundary
 * itself. Every other surface in this package (`<PageBodyError>`,
 * `<PageLoading>`) renders as a body and expects its caller's layout to
 * supply the `.page` shell.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { caught: null }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState({
      caught: {
        error,
        componentStack: info.componentStack ?? null,
        capturedAt: new Date().toISOString(),
      },
    })
    this.props.onError?.(error, info)
  }

  render(): ReactNode {
    if (this.state.caught === null) return this.props.children
    const title = this.props.title ?? 'Something went wrong'
    const headingLevel = this.props.headingLevel ?? 1
    const { error, componentStack, capturedAt } = this.state.caught
    const { name: errorName, message: errorMessage, stack: errorStack } = normalizeError(error)

    const context = {
      ...this.props.extraContext,
      capturedAt,
      url: window.location.href,
      userAgent: navigator.userAgent,
    }

    const contextJson = JSON.stringify(context, null, 2)
    const debugBlob = JSON.stringify(
      { errorName, errorMessage, errorStack, componentStack, ...context },
      null,
      2
    )

    const onCopy = (): void => {
      if (navigator.clipboard === undefined) return
      void navigator.clipboard.writeText(debugBlob)
    }

    const Heading = `h${headingLevel}` as const

    const panels = [
      { label: 'Error stack', content: errorStack ?? '(no stack)' },
      { label: 'Component stack', content: componentStack ?? '(no component stack)' },
      { label: 'Context', content: contextJson },
    ]

    return (
      <div
        className={pageLayout['page']}
        role="alertdialog"
        aria-labelledby="error-boundary-heading"
      >
        <Heading id="error-boundary-heading" className="text-heading-4">
          {title}
        </Heading>
        <p className={cn(pageLayout['error'], 'text-body-3')}>
          {errorName}: {errorMessage}
        </p>
        <div className={styles['actions']}>
          <button type="button" className="button-3 outline" onClick={onCopy}>
            Copy details
          </button>
          <button
            type="button"
            className="button-3 outline"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
        {panels.map(({ label, content }) => (
          <details key={label}>
            <summary className={styles['summary']}>{label}</summary>
            <pre className={styles['pre']}>{content}</pre>
          </details>
        ))}
      </div>
    )
  }
}

export { ErrorBoundary }
export type { ErrorBoundaryProps }

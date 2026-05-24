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

const reloadPage = (): void => {
  if (typeof window !== 'undefined') window.location.reload()
}

/**
 * Catch-all React error boundary. Renders a summary line plus collapsed
 * `<details>` panes for the error stack, component stack, and a context
 * blob, with buttons to copy the full debug JSON or reload the page.
 *
 * Pass {@link ErrorBoundaryProps.onError} to forward to a telemetry sink.
 * Use {@link ErrorBoundaryProps.extraContext} to inject app-specific
 * build/environment fields.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { caught: null }

  // `getDerivedStateFromError` runs during the render phase so the
  // fallback is committed even if `componentDidCatch` (commit-phase)
  // never runs — important under SSR / partial hydration.
  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return {
      caught: { error, componentStack: null, capturedAt: new Date().toISOString() },
    }
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    // `componentDidCatch` runs after `getDerivedStateFromError`; merge
    // the component stack into the state captured there so the fallback
    // can render it.
    this.setState({
      caught: {
        error,
        componentStack: info.componentStack ?? null,
        capturedAt: new Date().toISOString(),
      },
    })
    // Always echo to console — wildflower's TransportProvider forwards
    // `console.error` over the host bridge in embedded mode, so the
    // native host sees the crash even when the WebView is opaque.
    // oxlint-disable-next-line no-console -- intentional diagnostic surface
    console.error('[ErrorBoundary] caught render-tree error', error, info.componentStack)
    this.props.onError?.(error, info)
  }

  render(): ReactNode {
    if (this.state.caught === null) return this.props.children
    const title = this.props.title ?? 'Something went wrong'
    const headingLevel = this.props.headingLevel ?? 1
    const { error, componentStack, capturedAt } = this.state.caught
    const { name: errorName, message: errorMessage, stack: errorStack } = normalizeError(error)

    // Window/navigator guards keep the fallback SSR-safe — the boundary
    // ships in a package that may be rendered on the server.
    const context = {
      ...this.props.extraContext,
      capturedAt,
      url: typeof window === 'undefined' ? null : window.location.href,
      userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
      embedded: typeof window !== 'undefined' && 'ReactNativeWebView' in window,
    }

    const contextJson = JSON.stringify(context, null, 2)
    const debugBlob = JSON.stringify(
      { errorName, errorMessage, errorStack, componentStack, ...context },
      null,
      2
    )

    const onCopy = (): void => {
      if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return
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
          <button type="button" className="button-3 outline" onClick={reloadPage}>
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

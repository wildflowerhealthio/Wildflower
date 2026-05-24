import { Component, type ErrorInfo, type ReactNode } from 'react'
import { cn } from 'react-kitchen-sink'

import styles from './error-boundary.module.css'
import pageLayout from './page-layout.module.css'

interface ErrorBoundaryProps {
  readonly children: ReactNode
  /** Heading shown above the summary line. Defaults to "Something went wrong". */
  readonly title?: string
  /**
   * Invoked after the boundary captures a render-tree error. Forward to
   * your telemetry sink — e.g. `Sentry.captureException(error, { extra: { componentStack } })`.
   */
  readonly onCatch?: (error: unknown, info: ErrorInfo) => void
  /**
   * App-specific context to merge into the "Context" details pane and
   * the copyable JSON blob. Use for build/version info, feature flags,
   * embedded-vs-standalone, etc. — anything not derivable from `window`
   * inside this library.
   */
  readonly extraContext?: Readonly<Record<string, unknown>>
}

interface CaughtError {
  readonly error: unknown
  readonly componentStack: string | null
  readonly capturedAt: string
}

interface ErrorBoundaryState {
  readonly caught: CaughtError | null
}

const reloadPage = (): void => {
  if (typeof window !== 'undefined') window.location.reload()
}

/**
 * Catch-all React error boundary. Renders a summary line plus collapsed
 * `<details>` panes for the error stack, component stack, and a context
 * blob, with buttons to copy the full debug JSON or reload the page.
 *
 * Always echoes the caught error to `console.error`; pass `onCatch` to
 * additionally forward to a telemetry sink. Use
 * {@link ErrorBoundaryProps.extraContext} to inject app-specific
 * build/environment fields.
 */
class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { caught: null }

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
    this.props.onCatch?.(error, info)
  }

  render(): ReactNode {
    if (this.state.caught === null) return this.props.children
    const title = this.props.title ?? 'Something went wrong'
    const { error, componentStack, capturedAt } = this.state.caught
    const errorName = error instanceof Error ? error.name : 'NonErrorThrown'
    const errorMessage = error instanceof Error ? error.message : String(error)
    const errorStack = error instanceof Error ? (error.stack ?? null) : null

    const context: Readonly<Record<string, unknown>> = {
      capturedAt,
      url: typeof window === 'undefined' ? null : window.location.href,
      userAgent: typeof navigator === 'undefined' ? null : navigator.userAgent,
      embedded: typeof window !== 'undefined' && 'ReactNativeWebView' in window,
      ...this.props.extraContext,
    }

    const debugBlob = JSON.stringify(
      { errorName, errorMessage, errorStack, componentStack, ...context },
      null,
      2
    )

    const onCopy = (): void => {
      if (typeof navigator === 'undefined' || navigator.clipboard === undefined) return
      void navigator.clipboard.writeText(debugBlob)
    }

    return (
      <div className={pageLayout['page']} role="alert">
        <h1 className="text-heading-4">{title}</h1>
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
        <details>
          <summary className={styles['summary']}>Error stack</summary>
          <pre className={styles['pre']}>{errorStack ?? '(no stack)'}</pre>
        </details>
        <details>
          <summary className={styles['summary']}>Component stack</summary>
          <pre className={styles['pre']}>{componentStack ?? '(no component stack)'}</pre>
        </details>
        <details>
          <summary className={styles['summary']}>Context</summary>
          <pre className={styles['pre']}>{JSON.stringify(context, null, 2)}</pre>
        </details>
      </div>
    )
  }
}

export { ErrorBoundary }
export type { ErrorBoundaryProps }

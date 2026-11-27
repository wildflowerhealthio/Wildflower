import { cn } from '@wildflowerhealthio/react-kitchen-sink'
import type { JSX } from 'react'

import { useErrorBodyRenderer, type ErrorBodyRenderer } from './error-body-renderer.ts'
import { formatErrorDetails } from './error-details.ts'
import { Notice } from './notice.tsx'
import styles from './error-banner.module.css'

/** An `Error`'s message, or a best-effort string for any other thrown value. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

interface ErrorBannerProps {
  /**
   * The error to surface — a rejected mutation/query value — or `null`/`undefined`
   * for the resting (no-error) state, where the banner renders nothing. Kept
   * nullable so a caller can pass `mutation.error` straight through without a
   * wrapping conditional.
   */
  readonly error: unknown
  /**
   * Override how a recognised error shape renders. When it returns a node, that
   * node replaces the default message banner (e.g. an authorization-failure
   * surface for a `403 InsufficientScope`); returning `null` falls through to the
   * message banner. Defaults to the ambient {@link ErrorBodyRendererContext}, so
   * an app's bespoke surfaces apply without threading a prop through every screen.
   */
  readonly renderError?: ErrorBodyRenderer
  readonly className?: string
}

/**
 * An inline **error banner** for an action that failed while its screen stays
 * usable — the mutation counterpart to {@link PageBodyError} (which owns a whole
 * error-boundary body). Given a nullable `error`, it:
 *
 * - renders nothing when `error` is `null`/`undefined` (the resting state), so a
 *   caller can mount it unconditionally and pass `mutation.error` straight in;
 * - defers to the ambient (or prop) {@link ErrorBodyRenderer} when it recognises
 *   the error — e.g. a `403 InsufficientScope` shows its authorization-failure
 *   surface in place of a bare message; and
 * - otherwise renders the error's message in a danger {@link Notice} (a
 *   `role="alert"` callout), with a **Show details** disclosure under it when
 *   {@link formatErrorDetails} has more to say.
 *
 * The renderer consult is the same one {@link PageBodyError} uses, so a query
 * error (surfaced by a boundary) and a mutation error (surfaced by this banner)
 * render a recognised shape identically.
 */
const ErrorBanner = ({ error, renderError, className }: ErrorBannerProps): JSX.Element | null => {
  // Read the ambient renderer unconditionally (hooks rule) before the resting
  // early-return below.
  const ambientRenderer = useErrorBodyRenderer()
  if (error === null || error === undefined) return null

  const surface = (renderError ?? ambientRenderer)?.(error) ?? null
  // A recognised shape owns its own chrome (the surface is a full block), so it
  // replaces the message callout rather than nesting inside it.
  if (surface !== null) return <>{surface}</>

  const details = formatErrorDetails(error)
  return (
    <Notice
      tone="danger"
      className={className}
      details={
        details === null ? undefined : (
          <details>
            <summary className={cn(styles['error-banner__summary'], 'text-label-3')}>
              Show details
            </summary>
            <pre className={cn(styles['error-banner__pre'], 'text-body-3')}>{details}</pre>
          </details>
        )
      }
    >
      {messageOf(error)}
    </Notice>
  )
}

export { ErrorBanner }
export type { ErrorBannerProps }

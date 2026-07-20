import type { JSX } from 'react'
import { cn } from 'react-kitchen-sink'

import { useErrorBodyRenderer, type ErrorBodyRenderer } from './error-body-renderer.ts'
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
 * - otherwise renders the error's message in a danger-toned `role="alert"` callout.
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

  const message = messageOf(error)
  return (
    <div className={cn(styles['banner'], className)} role="alert">
      <span aria-hidden="true" className={styles['icon']}>
        ⚠
      </span>
      <p className={cn(styles['message'], 'text-body-3')}>
        <span className="sr-only">Error: </span>
        {message}
      </p>
    </div>
  )
}

export { ErrorBanner }
export type { ErrorBannerProps }

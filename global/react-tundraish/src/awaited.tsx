import { Await, CatchBoundary } from '@tanstack/react-router'
import type { JSX, ReactNode } from 'react'

import { AsyncErrorView } from './async-error-view.tsx'

interface AwaitedProps<T> {
  /** Promise to suspend on; resolved value flows into `children`. */
  readonly promise: Promise<T>
  /**
   * Forces the error boundary to reset when changed. Pass any value
   * that changes when callers want a previously-displayed error to be
   * cleared (e.g. a refresh counter or a path-param string).
   */
  readonly resetKey?: number | string
  /** Heading rendered by the default error view, if no `errorComponent` is given. */
  readonly errorTitle?: string
  readonly errorClassName?: string
  readonly errorTitleClassName?: string
  /**
   * Override the default `AsyncErrorView`-based error view. Receives the
   * thrown error and should return a renderable node.
   */
  readonly errorComponent?: (error: unknown) => ReactNode
  readonly children: (resolved: T) => ReactNode
}

/**
 * Suspense-aware wrapper around TanStack Router's `<Await>` that
 * forwards rejections to an `<AsyncErrorView>`-backed
 * `<CatchBoundary>` — matching the `react-router` `<Await errorElement>`
 * affordance the rest of the codebase used to rely on.
 *
 * @remarks
 * Callers still wrap this in `<Suspense fallback={…}>` to control the
 * pending UI; the helper only handles the resolved + error halves.
 */
const Awaited = <T,>({
  promise,
  resetKey = 0,
  errorTitle,
  errorClassName,
  errorTitleClassName,
  errorComponent,
  children,
}: AwaitedProps<T>): JSX.Element => (
  <CatchBoundary
    getResetKey={() => resetKey}
    errorComponent={({ error }) =>
      errorComponent !== undefined ? (
        errorComponent(error)
      ) : (
        <AsyncErrorView
          error={error}
          title={errorTitle}
          className={errorClassName}
          titleClassName={errorTitleClassName}
        />
      )
    }
  >
    <Await promise={promise}>{children}</Await>
  </CatchBoundary>
)

export { Awaited }
export type { AwaitedProps }

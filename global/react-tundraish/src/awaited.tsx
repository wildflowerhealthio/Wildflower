import { Await, CatchBoundary } from '@tanstack/react-router'
import type { JSX, ReactNode } from 'react'

import { AsyncErrorView } from './async-error-view.tsx'

/**
 * Props shared by every {@link Awaited} variant.
 *
 * @typeParam T - The type the `promise` resolves to; inferred from
 *   `promise` and re-used (non-inferentially) by `children`.
 */
interface AwaitedBaseProps<T> {
  /** Promise to suspend on; resolved value flows into `children`. */
  readonly promise: Promise<T>
  /**
   * Forces the error boundary to reset when changed.
   *
   * @remarks
   * Pass any value that changes when callers want a previously-displayed
   * error to be cleared (e.g. a refresh counter or a path-param string).
   *
   * **Footgun:** when omitted, `resetKey` defaults to a constant `0`,
   * so the error boundary will never reset on its own — a thrown error
   * stays rendered until the surrounding tree unmounts. Pass an
   * explicit `resetKey` whenever the surface needs to recover after the
   * promise input changes.
   */
  readonly resetKey?: number | string
  /**
   * Render-prop for the resolved value.
   *
   * @remarks
   * Typed with `NoInfer<T>` so `T` is inferred solely from `promise` —
   * callers don't need to annotate the parameter to keep inference
   * stable.
   */
  readonly children: (resolved: NoInfer<T>) => ReactNode
}

/**
 * Variant that delegates error rendering to a caller-supplied component.
 *
 * @remarks
 * The discriminator is the presence of `errorComponent`. Combining this
 * variant with any of the styled-default props
 * ({@link AwaitedDefaultErrorProps}) is a type error — those props would
 * be silently ignored, so the type forbids them outright.
 */
interface AwaitedCustomErrorProps {
  /**
   * Override the default `AsyncErrorView`-based error view. Receives
   * the thrown error and should return a renderable node.
   */
  readonly errorComponent: (error: unknown) => ReactNode
  readonly errorTitle?: never
  readonly errorTitleClassName?: never
}

/**
 * Variant that renders the built-in {@link AsyncErrorView} on rejection.
 *
 * @remarks
 * The discriminator is the absence of `errorComponent`. Both styling
 * props are optional — supplying none renders the default
 * `AsyncErrorView` with no heading.
 */
interface AwaitedDefaultErrorProps {
  readonly errorComponent?: never
  /** Heading rendered by the default error view. */
  readonly errorTitle?: string
  /** Class applied to the default error view's heading. */
  readonly errorTitleClassName?: string
}

/**
 * Props for {@link Awaited}.
 *
 * @typeParam T - The type the `promise` resolves to.
 *
 * @remarks
 * The error-handling props form a discriminated union: callers either
 * pass `errorComponent` to render their own view, or omit it and
 * (optionally) pass `errorTitle` / `errorTitleClassName` to style the
 * built-in {@link AsyncErrorView}. Passing `errorComponent` alongside
 * any styled-default prop is a type error — the styled props would have
 * been silently ignored.
 */
type AwaitedProps<T> = AwaitedBaseProps<T> & (AwaitedCustomErrorProps | AwaitedDefaultErrorProps)

/**
 * Suspense-aware wrapper around TanStack Router's `<Await>` that
 * forwards rejections to an `<AsyncErrorView>`-backed
 * `<CatchBoundary>` — matching the `react-router` `<Await errorElement>`
 * affordance the rest of the codebase used to rely on.
 *
 * @typeParam T - The type the `promise` resolves to; inferred from the
 *   `promise` prop. The `children` parameter type follows automatically.
 *
 * @remarks
 * Callers still wrap this in `<Suspense fallback={…}>` to control the
 * pending UI; the helper only handles the resolved + error halves.
 *
 * `resetKey` defaults to `0`, meaning a thrown error is **never**
 * automatically cleared. Provide an explicit `resetKey` (e.g. a path
 * param or a refresh counter) whenever the surface needs to recover
 * from a rejection without an unmount.
 *
 * The error-handling props are discriminated on `errorComponent`:
 * either pass `errorComponent` to render a custom error UI, or omit it
 * and rely on the built-in {@link AsyncErrorView} (optionally styled
 * via `errorTitle` / `errorTitleClassName`). The type forbids mixing
 * the two so the styling props can't be silently dropped.
 */
const Awaited = <T,>(props: AwaitedProps<T>): JSX.Element => {
  const { promise, resetKey = 0, children } = props
  return (
    <CatchBoundary
      getResetKey={() => resetKey}
      errorComponent={({ error }) =>
        props.errorComponent !== undefined ? (
          props.errorComponent(error)
        ) : (
          <AsyncErrorView
            error={error}
            title={props.errorTitle}
            titleClassName={props.errorTitleClassName}
          />
        )
      }
    >
      <Await promise={promise}>{children}</Await>
    </CatchBoundary>
  )
}

export { Awaited }
export type { AwaitedProps }

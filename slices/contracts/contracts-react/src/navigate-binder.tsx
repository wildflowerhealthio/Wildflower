import { type JSX, useEffect } from 'react'
import { useNavigate } from 'react-router'

/**
 * Mutable nav-handle a {@link NavigationBridge} receiver closes over.
 * The embedded-app aggregator builds this before the transport so the
 * `HostBackRequested` / `HostRequestedWebNavigation` handlers can push
 * pending navigations into a shared queue when `current === null`
 * (pre-mount), and route directly through `current(...)` once
 * `<NavigateBinder>` mounts and resolves `useNavigate()`.
 *
 * Lives in `contracts-react` rather than `effect-messaging-react`
 * because the queue is specifically tied to the navigation contract —
 * the bridge schemas and React Router glue are co-located.
 */
interface NavRef {
  current: ((to: number | string) => void) | null
}

interface NavigateBinderProps {
  /** Set on mount to `useNavigate()`; cleared on unmount. */
  readonly navRef: NavRef
  /**
   * Pre-mount queue, mutated in place by the navigation receiver
   * layer's handler. The binder drains it via `while (queue.length > 0)`
   * after assigning `navRef`, catching any entries that arrived during
   * the React mount window. `-1` represents "go back"; a string is a
   * path to navigate to.
   */
  readonly queue: Array<-1 | string>
}

/**
 * Mount under a React Router router (e.g. `<MemoryRouter>`). Wires
 * `navRef.current` to `useNavigate()` and drains any pre-mount
 * navigation events the receiver layer's handler accumulated. Renders
 * no DOM.
 *
 * One binder handles both back-requests (`-1`) and path-pushes
 * (string).
 */
function NavigateBinder({ navRef, queue }: NavigateBinderProps): JSX.Element | null {
  const navigate = useNavigate()
  useEffect(() => {
    const handler = (to: number | string): void => {
      // react-router's NavigateFunction is overloaded: numbers are
      // delta navigations, strings are paths. The void return matches
      // the underlying call signatures.
      if (typeof to === 'number') void navigate(to)
      else void navigate(to)
    }
    navRef.current = handler
    while (queue.length > 0) {
      const entry = queue.shift()
      if (entry === undefined) break
      handler(entry)
    }
    return (): void => {
      if (navRef.current === handler) navRef.current = null
    }
  }, [navigate, navRef, queue])
  return null
}

export { NavigateBinder }
export type { NavigateBinderProps, NavRef }

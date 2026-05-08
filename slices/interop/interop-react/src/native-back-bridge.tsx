/* oxlint-disable react/only-export-components -- This file deliberately
   pairs each bridge factory with the component that binds it; React Refresh
   isn't a goal for these single-purpose, low-churn components. */
import type { AppNavigationRequested, MessageReader, NativeBackRequested } from 'interop-core'
import { type JSX, useEffect } from 'react'
import { useNavigate } from 'react-router'

/**
 * Bridge that decouples a plain-JS `NativeBackRequested` listener
 * (registered before React mounts) from React Router's `useNavigate`
 * (only available after mount).
 *
 * Lifecycle:
 *
 * 1. Caller creates the bridge before render and `subscribe`s it to the
 *    web `MessageHandler`. Any `NativeBackRequested` events that arrive
 *    before mount accumulate in an internal counter.
 * 2. On mount, `<NativeBackBinder bridge={bridge}/>` calls `bind(navigate)`,
 *    which flushes the pending count by invoking `navigate(-1)` once per
 *    queued event, then routes future events live.
 * 3. On unmount, the binder's effect cleanup unbinds; subsequent events
 *    queue again until the next bind.
 */
interface NativeBackBridge {
  subscribe(
    reader: MessageReader<{ readonly NativeBackRequested: typeof NativeBackRequested }>
  ): () => void
  bind(navigateBack: () => void): () => void
}

const createNativeBackBridge = (): NativeBackBridge => {
  let bound: (() => void) | null = null
  let pending = 0
  return {
    subscribe(reader) {
      return reader.setMessageListener('NativeBackRequested', () => {
        if (bound !== null) bound()
        else pending += 1
      })
    },
    bind(navigateBack) {
      bound = navigateBack
      while (pending > 0) {
        pending -= 1
        navigateBack()
      }
      return (): void => {
        if (bound === navigateBack) bound = null
      }
    },
  }
}

interface NativeBackBinderProps {
  readonly bridge: NativeBackBridge
}

/**
 * Mount under a React Router router (e.g. `<MemoryRouter>`) — calls
 * `bridge.bind` with the router's `navigate(-1)` so queued
 * `NativeBackRequested` events flush, then routes future events live.
 * Returns no DOM.
 */
function NativeBackBinder({ bridge }: NativeBackBinderProps): JSX.Element | null {
  const navigate = useNavigate()
  useEffect(
    () =>
      bridge.bind(() => {
        void navigate(-1)
      }),
    [bridge, navigate]
  )
  return null
}

/**
 * Bridge that decouples a plain-JS `AppNavigationRequested` listener
 * (registered before React mounts) from React Router's imperative
 * `navigate(path)` (only available after mount). Mirrors
 * {@link NativeBackBridge} for path-bearing host navigations — typical
 * use is the host pushing a new route into the embedded SPA at runtime.
 *
 * Note: `__INITIAL_MESSAGES__` carrying an initial `AppNavigationRequested`
 * is normally drained synchronously via `handler.consumeBuffered(...)`
 * to seed `<MemoryRouter initialEntries>`. This bridge only sees
 * navigations that arrive *after* the consumeBuffered call (or during
 * the React-mount window before bind).
 */
interface AppNavigationBridge {
  subscribe(
    reader: MessageReader<{
      readonly AppNavigationRequested: typeof AppNavigationRequested
    }>
  ): () => void
  bind(navigateTo: (path: string) => void): () => void
}

const createAppNavigationBridge = (): AppNavigationBridge => {
  let bound: ((path: string) => void) | null = null
  const queue: string[] = []
  return {
    subscribe(reader) {
      return reader.setMessageListener('AppNavigationRequested', ({ path }) => {
        if (bound !== null) bound(path)
        else queue.push(path)
      })
    },
    bind(navigateTo) {
      bound = navigateTo
      while (queue.length > 0) {
        const path = queue.shift()
        if (path !== undefined) navigateTo(path)
      }
      return (): void => {
        if (bound === navigateTo) bound = null
      }
    },
  }
}

interface AppNavigationBinderProps {
  readonly bridge: AppNavigationBridge
}

function AppNavigationBinder({ bridge }: AppNavigationBinderProps): JSX.Element | null {
  const navigate = useNavigate()
  useEffect(
    () =>
      bridge.bind((path: string) => {
        void navigate(path)
      }),
    [bridge, navigate]
  )
  return null
}

export { AppNavigationBinder, createAppNavigationBridge, createNativeBackBridge, NativeBackBinder }
export type {
  AppNavigationBinderProps,
  AppNavigationBridge,
  NativeBackBinderProps,
  NativeBackBridge,
}

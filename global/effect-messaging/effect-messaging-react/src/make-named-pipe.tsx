import { Effect } from 'effect'
import type { Bridge, BridgeTransport } from 'effect-messaging-core'
import { useCallback, type FC as ReactFC, type RefObject } from 'react'
import { makeOutlet } from './outlet.tsx'

interface MadeNamedPipe<
  TName extends string,
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TDirection extends Bridge.Direction,
> {
  /**
   * Renders the pipe's context. Its `displayName` is `${TName}PipeProvider`,
   * so it shows up under that friendly tag in React DevTools.
   */
  readonly Provider: ReactFC<{ children: React.ReactNode }> & {
    displayName: `${TName}PipeProvider`
  }
  /**
   * Register a typed sender as the active downstream for this pipe.
   */
  readonly useAsOutlet: (sender: BridgeTransport.MessageSender<TBridges, TDirection>) => void
  /**
   * Get the typed sender for this pipe. The returned function is
   * identity-stable for the lifetime of the surrounding Provider — safe
   * to include in `useEffect` / `useMemo` deps. It reads
   * `handlerRef.current` at suspend time, so callers don't need to
   * re-render to see a sender registered later. Pre-mount sends route
   * through the default warn-and-drop handler until
   * {@link MadeNamedPipe.useAsOutlet} commits its effect.
   */
  readonly useSender: () => BridgeTransport.MessageSender<TBridges, TDirection>
  /**
   * Returns the underlying RefObject holding the active sender.
   * Identity-stable across renders. Initially points at
   * {@link MadeNamedPipe.defaultSender} (the pipe's built-in
   * warn-and-drop) and is updated by {@link MadeNamedPipe.useAsOutlet}
   * when a sender is registered.
   *
   * Direct mutation of `.current` is a supported pattern — reach for
   * it when the registration site cannot run inside a `useEffect`
   * (e.g. capturing a transport sender from inside an
   * `onTransportReady` `Effect.sync` callback).
   */
  readonly useSenderRef: () => RefObject<BridgeTransport.MessageSender<TBridges, TDirection>>
  /**
   * The pipe's built-in warn-and-drop sender — what
   * {@link MadeNamedPipe.useSender} resolves to before any
   * {@link MadeNamedPipe.useAsOutlet} call commits.
   *
   * Exposed so consumers gating registration on a not-yet-ready upstream
   * (e.g. `useAsOutlet(realSender ?? defaultSender)`) can plug the same
   * default in directly instead of re-implementing their own
   * warn-and-drop wrapper.
   */
  readonly defaultSender: BridgeTransport.MessageSender<TBridges, TDirection>
}

/**
 * Factory for a typed, friendly-named React pipe carrying a
 * {@link BridgeTransport.MessageSender} for the given bridge tuple and
 * outbound direction.
 *
 * Each call returns a `{ Provider, useAsOutlet, useSender, useSenderRef,
 * defaultSender }` quintuple where `Provider.displayName` is
 * `${TName}PipeProvider`. Consumers typically destructure-and-rename:
 *
 * ```ts
 * const pipe = makeNamedPipe('BrowserSniffer', [BrowserSnifferBridge] as const, 'HostToWeb')
 * export const {
 *   Provider: MessageSenderToBrowserSnifferProvider,
 *   useAsOutlet: useAsMessageSenderToBrowserSniffer,
 *   useSender: useMessageSenderToBrowserSniffer,
 * } = pipe
 * ```
 */
const makeNamedPipe = <
  const TName extends string,
  const TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  const TDirection extends Bridge.Direction,
>(
  name: TName,
  _bridges: TBridges,
  _direction: TDirection
): MadeNamedPipe<TName, TBridges, TDirection> => {
  // `_bridges` and `_direction` are type witnesses — they bind
  // TBridges/TDirection into the returned closure so downstream types flow
  // without runtime generics.

  const defaultSender: BridgeTransport.MessageSender<TBridges, TDirection> = (msg) =>
    Effect.logWarning(
      `[effect-messaging] no ${name}Pipe handler registered; dropping message "${JSON.stringify(msg)}"`
    )

  // A named pipe is an `Outlet` specialized to a transport sender. The
  // `Pipe` suffix keeps the historical `${name}PipeProvider` DevTools tag.
  const outlet = makeOutlet(`${name}Pipe`, defaultSender)

  const useSender = (): BridgeTransport.MessageSender<TBridges, TDirection> => {
    const handlerRef = outlet.useValueRef()
    // Identity-stable across renders, and reads `.current` at suspend time
    // so a sender registered later is seen without re-rendering.
    return useCallback((message) => Effect.suspend(() => handlerRef.current(message)), [handlerRef])
  }

  return {
    Provider: outlet.Provider,
    useSenderRef: outlet.useValueRef,
    useAsOutlet: outlet.useRegister,
    useSender,
    defaultSender,
  }
}

export { makeNamedPipe }
export type { MadeNamedPipe }

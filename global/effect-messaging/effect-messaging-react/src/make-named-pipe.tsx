import { Effect } from 'effect'
import type { Bridge, BridgeTransport } from 'effect-messaging-core'
import {
  createContext,
  useCallback,
  useEffect,
  useRef,
  type FC as ReactFC,
  type JSX,
  type RefObject,
} from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

interface MadeNamedPipe<
  TName extends string,
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TSide extends 'Host' | 'Web',
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
  readonly useAsSource: (sender: BridgeTransport.MessageSender<TBridges, TSide>) => void
  /**
   * Get the typed sender for this pipe. The returned function is
   * identity-stable for the lifetime of the surrounding Provider — safe
   * to include in `useEffect` / `useMemo` deps. It reads
   * `handlerRef.current` at suspend time, so callers don't need to
   * re-render to see a sender registered later. Pre-mount sends route
   * through the default warn-and-drop handler until
   * {@link MadeNamedPipe.useAsSource} commits its effect.
   */
  readonly useSender: () => BridgeTransport.MessageSender<TBridges, TSide>
  /**
   * Returns the underlying RefObject holding the active sender.
   * Identity-stable across renders. Initially points at
   * {@link MadeNamedPipe.defaultSender} (the pipe's built-in
   * warn-and-drop) and is updated by {@link MadeNamedPipe.useAsSource}
   * when a sender is registered.
   *
   * Direct mutation of `.current` is a supported pattern — reach for
   * it when the registration site cannot run inside a `useEffect`
   * (e.g. capturing a transport sender from inside an
   * `onTransportReady` `Effect.sync` callback).
   */
  readonly useSenderRef: () => RefObject<BridgeTransport.MessageSender<TBridges, TSide>>
  /**
   * The pipe's built-in warn-and-drop sender — what
   * {@link MadeNamedPipe.useSender} resolves to before any
   * {@link MadeNamedPipe.useAsSource} call commits.
   *
   * Exposed so consumers gating registration on a not-yet-ready upstream
   * (e.g. `useAsSource(realSender ?? defaultSender)`) can plug the same
   * default in directly instead of re-implementing their own
   * warn-and-drop wrapper.
   */
  readonly defaultSender: BridgeTransport.MessageSender<TBridges, TSide>
}

/**
 * Factory for a typed, friendly-named React pipe carrying a
 * {@link BridgeTransport.MessageSender} for the given bridge tuple and
 * side.
 *
 * Each call returns a `{ Provider, useAsSource, useSender, useSenderRef,
 * defaultSender }` quintuple where `Provider.displayName` is
 * `${TName}PipeProvider`. Consumers typically destructure-and-rename:
 *
 * ```ts
 * const pipe = makeNamedPipe('BrowserSniffer', [BrowserSnifferBridge] as const, 'Host')
 * export const {
 *   Provider: MessageSenderToBrowserSnifferProvider,
 *   useAsSource: useAsMessageSenderToBrowserSniffer,
 *   useSender: useMessageSenderToBrowserSniffer,
 * } = pipe
 * ```
 */
const makeNamedPipe = <
  const TName extends string,
  const TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  const TSide extends 'Host' | 'Web',
>(
  name: TName,
  _bridges: TBridges,
  _side: TSide
): MadeNamedPipe<TName, TBridges, TSide> => {
  // `_bridges` and `_side` are type witnesses — they bind TBridges/TSide into
  // the returned closure so downstream types flow without runtime generics.

  const defaultSender: BridgeTransport.MessageSender<TBridges, TSide> = (msg) =>
    Effect.logWarning(
      `[effect-messaging] no ${name}Pipe handler registered; dropping message "${JSON.stringify(msg)}"`
    )

  const Context = createContext<RefObject<BridgeTransport.MessageSender<TBridges, TSide>> | null>(
    null
  )
  Context.displayName = `${name}PipeContext`

  // oxlint-disable-next-line react-refresh/only-export-components
  const Provider = ({ children }: { children: React.ReactNode }): JSX.Element => {
    const handlerRef = useRef<BridgeTransport.MessageSender<TBridges, TSide>>(defaultSender)

    return <Context.Provider value={handlerRef}>{children}</Context.Provider>
  }
  Provider.displayName = `${name}PipeProvider`

  const useSender = (): BridgeTransport.MessageSender<TBridges, TSide> => {
    const handlerRef = useContextOrThrow(Context)
    return useCallback((message) => Effect.suspend(() => handlerRef.current(message)), [handlerRef])
  }

  const useAsSource = (sender: BridgeTransport.MessageSender<TBridges, TSide>): void => {
    const handlerRef = useContextOrThrow(Context)
    useEffect(() => {
      handlerRef.current = sender
    }, [sender, handlerRef])
  }

  const useSenderRef = (): RefObject<BridgeTransport.MessageSender<TBridges, TSide>> =>
    useContextOrThrow(Context)

  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    Provider: Provider as ReactFC<{ children: React.ReactNode }> & {
      displayName: `${TName}PipeProvider`
    },
    useSenderRef,
    useAsSource,
    useSender,
    defaultSender,
  }
}

export { makeNamedPipe }
export type { MadeNamedPipe }

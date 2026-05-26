import { Effect } from 'effect'
import type { Bridge, BridgeTransport } from 'effect-messaging-core'
import {
  createContext,
  useCallback,
  useRef,
  type RefObject,
  type FC as ReactFC,
  useEffect,
  type JSX,
} from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

interface MadeMessageSenderPipe<
  TName extends string,
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TSide extends 'Host' | 'Web',
> {
  Provider: React.FC<{ children: React.ReactNode }> & {
    displayName: `${TName}MessageSenderPipeContext`
  }
  usePipeMessageSender: () => BridgeTransport.MessageSender<TBridges, TSide>
  useAsPipeMessageSender: (sender: BridgeTransport.MessageSender<TBridges, TSide>) => void
  /**
   * The pipe's built-in warn-and-drop sender — what
   * {@link usePipeMessageSender} resolves to before any
   * {@link useAsPipeMessageSender} call commits.
   *
   * Exposed so consumers gating registration on a not-yet-ready upstream
   * (e.g. `useAsPipeMessageSender(realSender ?? defaultSender)`) can plug
   * the same default in directly instead of re-implementing their own
   * warn-and-drop wrapper.
   */
  defaultSender: BridgeTransport.MessageSender<TBridges, TSide>
}

const makeMessageSenderPipe = <
  const TName extends string,
  const TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  const TSide extends 'Host' | 'Web',
>(
  name: TName,
  _bridges: TBridges,
  _side: TSide
): MadeMessageSenderPipe<TName, TBridges, TSide> => {
  // `_bridges` and `_side` are type witnesses — they bind TBridges/TSide into
  // the returned closure so downstream types flow without runtime generics.

  const defaultSender: BridgeTransport.MessageSender<TBridges, TSide> = (msg) =>
    Effect.logWarning(
      `[effect-messaging] no ${name}MessageSenderPipe handler registered; dropping message "${JSON.stringify(msg)}"`
    )

  const Context = createContext<RefObject<BridgeTransport.MessageSender<TBridges, TSide>> | null>(
    null
  )
  Context.displayName = `${name}MessageSenderPipeContext`

  // oxlint-disable-next-line react-refresh/only-export-components
  const Provider = ({ children }: { children: React.ReactNode }): JSX.Element => {
    const handlerRef = useRef<BridgeTransport.MessageSender<TBridges, TSide>>(defaultSender)

    return <Context.Provider value={handlerRef}>{children}</Context.Provider>
  }
  Provider.displayName = `${name}MessageSenderPipeContext`

  /**
   * Returns a stable sender that reads `handlerRef.current` at suspend
   * time, so callers don't need to re-render to see a sender registered
   * later. Pre-mount sends route through the default warn-and-drop
   * handler until {@link useAsPipeMessageSender} commits its effect.
   *
   * The returned function is identity-stable for the lifetime of the
   * surrounding Provider — safe to include in `useEffect` / `useMemo`
   * deps.
   */
  const usePipeMessageSender = (): BridgeTransport.MessageSender<TBridges, TSide> => {
    const handlerRef = useContextOrThrow(Context)
    return useCallback((message) => Effect.suspend(() => handlerRef.current(message)), [handlerRef])
  }

  const useAsPipeMessageSender = (sender: BridgeTransport.MessageSender<TBridges, TSide>): void => {
    const handlerRef = useContextOrThrow(Context)
    useEffect(() => {
      handlerRef.current = sender
    }, [sender, handlerRef])
  }

  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    Provider: Provider as ReactFC<{ children: React.ReactNode }> & {
      displayName: `${TName}MessageSenderPipeContext`
    },
    usePipeMessageSender,
    useAsPipeMessageSender,
    defaultSender,
  }
}

export { makeMessageSenderPipe }
export type { MadeMessageSenderPipe }

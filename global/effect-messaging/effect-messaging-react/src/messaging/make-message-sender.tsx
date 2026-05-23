import { Effect } from 'effect'
/* oxlint-disable react/only-export-components -- the provider and the hook
   share an in-file context; splitting them would force a cross-file import
   of an otherwise-private context just to satisfy fast-refresh's rule. */
import type { Bridge } from 'effect-messaging-core'
import { createContext, useMemo, type Context, type FC, type ReactNode } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

import type { MessageSender, SenderContextValue } from './types.ts'
import { widen } from './widen.ts'

interface MessageSenderProviderProps<
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TSide extends 'Host' | 'Web',
> {
  readonly sendMessage: Bridge.MessageSender<TBridges, TSide>
  readonly children: ReactNode
}

interface MadeMessageSender<
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TSide extends 'Host' | 'Web',
> {
  /** Internal context — also consumed by {@link makeHoistedMessageSender}. */
  readonly Context: Context<SenderContextValue<TBridges, TSide> | null>
  readonly MessageSenderProvider: FC<MessageSenderProviderProps<TBridges, TSide>>
  readonly useMessageSender: <B extends TBridges[number]>(
    bridge: B
  ) => MessageSender<Bridge.SendableMessage<readonly [B], TSide>>
}

/**
 * Build a sender provider + hook pair bound to a known bridge tuple and side.
 *
 * The internal context is returned so the hoisted-sender factory can write
 * to the same value the regular Provider holds (i.e. both providers feed the
 * same `useMessageSender`).
 */
const makeMessageSender = <
  const TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  const TSide extends 'Host' | 'Web',
>(
  _bridges: TBridges,
  _side: TSide
): MadeMessageSender<TBridges, TSide> => {
  // `_bridges` and `_side` are type witnesses — they bind TBridges/TSide into
  // the returned closure so downstream types flow without runtime generics.

  const Context = createContext<SenderContextValue<TBridges, TSide> | null>(null)
  Context.displayName = 'MessageSenderContext'

  const MessageSenderProvider: FC<MessageSenderProviderProps<TBridges, TSide>> = ({
    sendMessage,
    children,
  }) => {
    const value = useMemo<SenderContextValue<TBridges, TSide>>(
      () => ({ sendEffect: widen<TBridges, TSide>(sendMessage) }),
      [sendMessage]
    )
    return <Context.Provider value={value}>{children}</Context.Provider>
  }

  // `bridge` is a compile-time type witness — `B extends TBridges[number]`
  // narrows the returned sender to that bridge's outbound messages. The
  // runtime dispatches by `_tag`; bridge identity is not consulted.
  const useMessageSender = <B extends TBridges[number]>(
    _bridge: B
  ): MessageSender<Bridge.SendableMessage<readonly [B], TSide>> => {
    const ctx = useContextOrThrow(Context)
    return useMemo(() => {
      type Narrow = Bridge.SendableMessage<readonly [B], TSide>
      const sendEffect = (message: Narrow): Effect.Effect<void> => ctx.sendEffect(message)
      const send = (message: Narrow): void => {
        Effect.runFork(sendEffect(message).pipe(Effect.tapErrorCause(Effect.logError)))
      }
      return { send, sendEffect }
    }, [ctx])
  }

  return { Context, MessageSenderProvider, useMessageSender }
}

export { makeMessageSender }
export type { MadeMessageSender, MessageSenderProviderProps }

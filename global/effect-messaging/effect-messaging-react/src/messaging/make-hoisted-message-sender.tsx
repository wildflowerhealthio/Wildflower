/* oxlint-disable react/only-export-components -- the provider and the hook
   share an in-file context; splitting them would force a cross-file import
   of an otherwise-private context just to satisfy fast-refresh's rule. */
import { Effect } from 'effect'
import type { Bridge } from 'effect-messaging-core'
import {
  createContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type Context,
  type FC,
  type ReactNode,
  type RefObject,
} from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

import type { SenderContextValue } from './types.ts'
import { widen, type Outbound } from './widen.ts'

interface HoistedMessageSenderProviderProps {
  readonly children: ReactNode
}

interface MadeHoistedMessageSender<
  TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  TSide extends 'Host' | 'Web',
> {
  readonly HoistedMessageSenderProvider: FC<HoistedMessageSenderProviderProps>
  readonly useRegisterMessageSender: (sender: Bridge.MessageSender<TBridges, TSide> | null) => void
}

/**
 * Build a deferred-binding sender provider whose `sendMessage` resolves
 * through a ref slot the subtree populates later. Use when the tree that owns
 * the live transport mounts BELOW the tree that needs to send through it
 * (e.g. a router `<Stack>` whose `index` screen owns the WebView while a
 * sibling modal screen needs to send into it).
 *
 * The hoisted provider writes its computed `SenderContextValue` into the
 * SAME `senderContext` that `makeMessageSender` produces, so `useMessageSender`
 * works identically under either provider.
 *
 * Sends issued before any transport has registered warn via
 * `Effect.logWarning` and drop silently — symmetric with the bridge
 * transport's "no peer attached" semantics.
 */
const makeHoistedMessageSender = <
  const TBridges extends ReadonlyArray<Bridge.AnyBridge>,
  const TSide extends 'Host' | 'Web',
>(
  _bridges: TBridges,
  _side: TSide,
  senderContext: Context<SenderContextValue<TBridges, TSide> | null>
): MadeHoistedMessageSender<TBridges, TSide> => {
  const RefContext = createContext<RefObject<Bridge.MessageSender<TBridges, TSide> | null> | null>(
    null
  )
  RefContext.displayName = 'HoistedMessageSenderRefContext'

  const HoistedMessageSenderProvider: FC<HoistedMessageSenderProviderProps> = ({ children }) => {
    const senderRef = useRef<Bridge.MessageSender<TBridges, TSide> | null>(null)
    const sendMessage = useCallback(
      (message: Outbound<TBridges, TSide>): Effect.Effect<void> =>
        Effect.suspend(() => {
          const sender = senderRef.current
          if (sender === null) {
            const tag = (message as { readonly _tag: string })._tag
            return Effect.logWarning(
              `[effect-messaging] sender not registered yet; dropping "${tag}"`
            )
          }
          return widen<TBridges, TSide>(sender)(message)
        }),
      []
    )
    const value = useMemo<SenderContextValue<TBridges, TSide>>(
      () => ({ sendEffect: sendMessage }),
      [sendMessage]
    )
    return (
      <RefContext.Provider value={senderRef}>
        <senderContext.Provider value={value}>{children}</senderContext.Provider>
      </RefContext.Provider>
    )
  }

  const useRegisterMessageSender = (sender: Bridge.MessageSender<TBridges, TSide> | null): void => {
    const ref = useContextOrThrow(RefContext)
    useEffect((): (() => void) => {
      ref.current = sender
      return (): void => {
        // Cleanup only if the slot still holds *our* sender — avoids a stale
        // unmount clobbering a later registrant during effect interleaving.
        if (ref.current === sender) ref.current = null
      }
    }, [ref, sender])
  }

  return { HoistedMessageSenderProvider, useRegisterMessageSender }
}

export { makeHoistedMessageSender }
export type { HoistedMessageSenderProviderProps, MadeHoistedMessageSender }

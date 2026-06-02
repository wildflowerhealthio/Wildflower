/* oxlint-disable react/only-export-components -- a sender pipe is a
   Provider component paired with its companion `use*` hooks; keeping them
   in one module is the whole point of the pattern. */
import type { BrowserSnifferBridge } from 'browser-sniffer-core/bridge'
import type { CollectorBridge } from 'collector-fundamentals/bridge'
import { Effect } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import { useLateBoundSender } from 'effect-messaging-react'
import { createContext, useEffect, useRef, type JSX, type ReactNode, type RefObject } from 'react'
import { useContextOrThrow } from 'react-kitchen-sink'

type BrowserSnifferSender = BridgeTransport.MessageSender<
  readonly [typeof BrowserSnifferBridge],
  'HostToWeb'
>
type CollectorSender = BridgeTransport.MessageSender<readonly [typeof CollectorBridge], 'HostToWeb'>

// --- BrowserSniffer pipe ---------------------------------------------------
// Sniffer events (Click / CancelSnifferRequest) the collector forwards reach
// a sender that only exists once the modal's `<BrowserSnifferWebView>` mounts;
// the ref's warn-and-drop default covers the pre-mount window.
const browserSnifferWarnAndDrop: BrowserSnifferSender = (msg) =>
  Effect.logWarning(
    `[effect-messaging] no BrowserSniffer sender registered; dropping message "${JSON.stringify(msg)}"`
  )

const BrowserSnifferSenderContext = createContext<RefObject<BrowserSnifferSender> | null>(null)
BrowserSnifferSenderContext.displayName = 'BrowserSnifferSenderContext'

const BrowserSnifferPipeProvider = ({ children }: { children: ReactNode }): JSX.Element => {
  const ref = useRef<BrowserSnifferSender>(browserSnifferWarnAndDrop)

  return (
    <BrowserSnifferSenderContext.Provider value={ref}>
      {children}
    </BrowserSnifferSenderContext.Provider>
  )
}

const useBrowserSnifferSenderRef = (): RefObject<BrowserSnifferSender> =>
  useContextOrThrow(BrowserSnifferSenderContext)

const useBrowserSnifferSender = (): BrowserSnifferSender =>
  useLateBoundSender(useBrowserSnifferSenderRef())

/** Register the active sniffer sender for the registrant's mounted lifetime. */
const useAsBrowserSnifferOutlet = (sender: BrowserSnifferSender): void => {
  const ref = useBrowserSnifferSenderRef()
  useEffect(() => {
    ref.current = sender
  }, [ref, sender])
}

// --- Collector pipe --------------------------------------------------------
// The collector sender is the host transport's outbound `sendMessage`,
// installed into the ref from `onTransportReady` (see `useCollectorHostBinding`).
const collectorWarnAndDrop: CollectorSender = (msg) =>
  Effect.logWarning(
    `[effect-messaging] no Collector sender registered; dropping message "${JSON.stringify(msg)}"`
  )

const CollectorSenderContext = createContext<RefObject<CollectorSender> | null>(null)
CollectorSenderContext.displayName = 'CollectorSenderContext'

const CollectorPipeProvider = ({ children }: { children: ReactNode }): JSX.Element => {
  const ref = useRef<CollectorSender>(collectorWarnAndDrop)

  return <CollectorSenderContext.Provider value={ref}>{children}</CollectorSenderContext.Provider>
}

const useCollectorSenderRef = (): RefObject<CollectorSender> =>
  useContextOrThrow(CollectorSenderContext)

const useCollectorSender = (): CollectorSender => useLateBoundSender(useCollectorSenderRef())

export {
  BrowserSnifferPipeProvider,
  CollectorPipeProvider,
  useAsBrowserSnifferOutlet,
  useBrowserSnifferSender,
  useCollectorSender,
  useCollectorSenderRef,
}

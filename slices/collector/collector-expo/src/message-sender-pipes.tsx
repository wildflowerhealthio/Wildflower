/* oxlint-disable react/only-export-components -- this file exports the
   per-slice pipe `Provider` components alongside the matching
   `useAs*` / `use*` hooks; splitting them across files would force the
   hooks to cross-import the otherwise-private pipe instances. */
import BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import CollectorBridge from 'collector-fundamentals/bridge'
import { makeMessageSenderPipe } from 'effect-messaging-react'

/**
 * Pipe carrying host→sniffer-page sends. The Expo modal mounting
 * `<BrowserSnifferWebView>` registers the WebView's ref-exposed
 * typed sender via {@link useAsMessageSenderToBrowserSniffer}; the
 * collector receiver layer reads it via
 * {@link useMessageSenderToBrowserSniffer} to forward decoded
 * `Click` / `CancelSnifferRequest` messages from the embedded
 * Collector SPA into the sniffer page.
 */
const BrowserSnifferPipe = makeMessageSenderPipe(
  'BrowserSniffer',
  [BrowserSnifferBridge] as const,
  'Host'
)

/**
 * Pipe carrying host→collector-SPA sends. The Expo app shell's
 * `<BridgedWebView>` (the one mounting the Collector SPA) registers
 * its ref-exposed typed sender via {@link useAsMessageSenderToCollector};
 * `<CollectorModalScreen>` reads it via {@link useMessageSenderToCollector}
 * to forward decoded sniffer events back through `CollectorBridge.hostToWeb`
 * so the SPA's bridge dispatches them.
 */
const CollectorPipe = makeMessageSenderPipe('Collector', [CollectorBridge] as const, 'Host')

const {
  Provider: MessageSenderToBrowserSnifferProvider,
  useAsPipeMessageSender: useAsMessageSenderToBrowserSniffer,
  usePipeMessageSender: useMessageSenderToBrowserSniffer,
} = BrowserSnifferPipe

const {
  Provider: MessageSenderToCollectorProvider,
  useAsPipeMessageSender: useAsMessageSenderToCollector,
  usePipeMessageSender: useMessageSenderToCollector,
} = CollectorPipe

export {
  MessageSenderToBrowserSnifferProvider,
  MessageSenderToCollectorProvider,
  useAsMessageSenderToBrowserSniffer,
  useAsMessageSenderToCollector,
  useMessageSenderToBrowserSniffer,
  useMessageSenderToCollector,
}

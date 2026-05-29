/* oxlint-disable react/only-export-components -- destructures Provider
   components alongside their companion `useAs*` / `use*` hooks; the
   pipe factory's own file already documents the rationale for keeping
   them paired. */
import { BrowserSnifferBridge } from 'browser-sniffer-core/bridge'
import { CollectorBridge } from 'collector-fundamentals/bridge'
import type { BridgeTransport } from 'effect-messaging-core'
import { type MadeNamedPipe, makeNamedPipe } from 'effect-messaging-react'

// The `useAs*` / `use*` hooks below are destructured-and-renamed off the
// `makeNamedPipe(...)` result, so tsgo re-infers each renamed binding's type
// at the export site — where the inferred `BridgeTransport.MessageSender<...>`
// has no nameable import path and dts emission fails with TS2883. Annotating
// each pipe with its `MadeNamedPipe<...>` type and giving the hook bindings an
// explicit type (with `BridgeTransport` imported, so `MessageSender` is
// nameable) makes the emitted `.d.ts` portable.
type BrowserSnifferSender = BridgeTransport.MessageSender<
  readonly [typeof BrowserSnifferBridge],
  'Host'
>
type CollectorSender = BridgeTransport.MessageSender<readonly [typeof CollectorBridge], 'Host'>

const browserSnifferPipe: MadeNamedPipe<
  'BrowserSniffer',
  readonly [typeof BrowserSnifferBridge],
  'Host'
> = makeNamedPipe('BrowserSniffer', [BrowserSnifferBridge] as const, 'Host')

const { Provider: BrowserSnifferPipeProvider } = browserSnifferPipe
const useAsBrowserSnifferOutlet: (sender: BrowserSnifferSender) => void =
  browserSnifferPipe.useAsOutlet
const useBrowserSnifferSender: () => BrowserSnifferSender = browserSnifferPipe.useSender

const collectorPipe: MadeNamedPipe<'Collector', readonly [typeof CollectorBridge], 'Host'> =
  makeNamedPipe('Collector', [CollectorBridge] as const, 'Host')

const { Provider: CollectorPipeProvider } = collectorPipe
const useAsCollectorOutlet: (sender: CollectorSender) => void = collectorPipe.useAsOutlet
const useCollectorSender: () => CollectorSender = collectorPipe.useSender

export {
  BrowserSnifferPipeProvider,
  CollectorPipeProvider,
  useAsBrowserSnifferOutlet,
  useAsCollectorOutlet,
  useBrowserSnifferSender,
  useCollectorSender,
}

/* oxlint-disable react/only-export-components -- destructures Provider
   components alongside their companion `useAs*` / `use*` hooks; the
   pipe factory's own file already documents the rationale for keeping
   them paired. */
import BrowserSnifferBridge from 'browser-sniffer-core/bridge'
import CollectorBridge from 'collector-fundamentals/bridge'
import { makeNamedPipe } from 'effect-messaging-react'

const {
  Provider: BrowserSnifferPipeProvider,
  useAsSource: useAsBrowserSnifferSource,
  useSender: useBrowserSnifferSender,
} = makeNamedPipe('BrowserSniffer', [BrowserSnifferBridge] as const, 'Host')

const {
  Provider: CollectorPipeProvider,
  useAsSource: useAsCollectorSource,
  useSender: useCollectorSender,
} = makeNamedPipe('Collector', [CollectorBridge] as const, 'Host')

export {
  BrowserSnifferPipeProvider,
  CollectorPipeProvider,
  useAsBrowserSnifferSource,
  useAsCollectorSource,
  useBrowserSnifferSender,
  useCollectorSender,
}

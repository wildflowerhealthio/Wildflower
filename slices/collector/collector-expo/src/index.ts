import { HostProvider } from './collector-host-context.tsx'
import { useHostBinding } from './use-host-binding.ts'
import { useReceiverLayer } from './use-receiver-layer.ts'

/**
 * Curated namespace for collector-expo's host wiring — what app
 * shells reach for. Internal hooks (`useCollectorHost`) and the pipe
 * source/sender hooks are kept off the namespace; the pipe hooks are
 * top-level exports below since their names read well without a
 * prefix.
 */
const CollectorBridgeExpo = { HostProvider, useHostBinding, useReceiverLayer } as const

export { CollectorBridgeExpo }
export type { HostProviderProps } from './collector-host-context.tsx'
export {
  useAsBrowserSnifferSource,
  useAsCollectorSource,
  useBrowserSnifferSender,
  useCollectorSender,
} from './message-sender-pipes.tsx'
export {
  CollectorModalScreen,
  type CollectorModalScreenProps,
} from './screens/CollectorModalScreen.tsx'
export { CollectorModalRoute } from './screens/CollectorModalRoute.tsx'

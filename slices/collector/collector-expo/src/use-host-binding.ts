import { CollectorBridge } from 'collector-fundamentals/bridge'
import type { HostBinding } from 'effect-messaging-core'
import { useMemo } from 'react'

import { useCollectorReceiverLayer } from './use-receiver-layer.ts'

/**
 * Host binding for the collector bridge. Wraps
 * {@link useCollectorReceiverLayer} (which reads from the surrounding
 * {@link CollectorHostProvider} context) so the binding shape matches
 * stateless slices.
 *
 * No per-slice options today; the hook exists for shape parity with
 * `useNavigationHostBinding` and other slice host bindings.
 */
const useCollectorHostBinding = (): HostBinding.HostBinding<typeof CollectorBridge> => {
  const receiverLayer = useCollectorReceiverLayer()
  return useMemo(() => ({ bridge: CollectorBridge, receiverLayer }), [receiverLayer])
}

export { useCollectorHostBinding }

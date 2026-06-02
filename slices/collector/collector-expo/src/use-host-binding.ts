import { CollectorBridge } from 'collector-fundamentals/bridge'
import { Effect } from 'effect'
import { HostBindings } from 'effect-messaging-core'
import { useMemo } from 'react'

import { useCollectorSenderRef } from './message-sender-pipes.tsx'
import { useCollectorHostHandlers } from './use-host-handlers.ts'

/**
 * Host binding for the collector bridge.
 *
 * Wraps {@link useCollectorHostHandlers} (which reads from the
 * surrounding {@link CollectorHostProvider} context) and installs the
 * host-built transport's outbound `CollectorSender` into the
 * {@link CollectorPipe} via its sender ref on `onTransportReady`.
 * Without that install, `useCollectorSender()` falls through to the
 * pipe's warn-and-drop default — observable as
 * `"[effect-messaging] no Collector sender registered; dropping
 * message ..."` for every sniffer event the modal forwards.
 *
 * Mirrors the navigation slice's pattern
 * (`useNavigationHostBinding` → `useNavigationSenderRef` →
 * `onTransportReady`): writing to the ref directly avoids calling a hook
 * from inside the Effect callback the transport fires asynchronously
 * after mount.
 *
 * Must be called under {@link CollectorHostProvider} —
 * `useCollectorSenderRef` throws otherwise.
 */
const useCollectorHostBinding = (): HostBindings.HostBindings<
  readonly [typeof CollectorBridge]
> => {
  const handlers = useCollectorHostHandlers()
  const collectorSenderRef = useCollectorSenderRef()
  return useMemo(
    () =>
      HostBindings.single({
        bridge: CollectorBridge,
        handlers,
        onTransportReady: (send) =>
          Effect.sync(() => {
            collectorSenderRef.current = send
          }),
      }),
    [handlers, collectorSenderRef]
  )
}

export { useCollectorHostBinding }

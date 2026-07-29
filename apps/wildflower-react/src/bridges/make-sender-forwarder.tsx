import { type JSX, type ReactNode, type FC as ReactFC } from 'react'

import { type ReactTransport, useBridgeTransport } from './transport-context.ts'

type TransportSender = ReactTransport['sendMessage']

interface SliceSenderForwarderProps {
  readonly children: ReactNode
}

/**
 * A slice's sender-context provider, viewed through the widest sender
 * the forwarder feeds it. A concrete slice provider declares `send` as
 * its own narrower sender; it fits here by props contravariance —
 * `transport.sendMessage` (the function-intersection over every wired
 * bridge's outbound message) is assignable to any single slice sender,
 * so no cast is needed at the call site.
 */
type SliceSenderProvider = (props: {
  readonly send: TransportSender
  readonly children: ReactNode
}) => JSX.Element

/**
 * Build a "sender forwarder": a component that reads the live
 * `BridgeTransport` from {@link useBridgeTransport} and feeds its
 * `sendMessage` into a slice's sender `Provider`, so slice screens can
 * dispatch their bridge's Web→Host messages without depending on the
 * app-level transport directly. Mount inside a
 * `<TransportContext.Provider>` (the `app-root.tsx` `AppRoot` supplies
 * one above `<RouterProvider>`).
 *
 * The returned component carries the supplied {@link displayName} so it
 * reads correctly in React DevTools and render-order assertions.
 */
const makeSliceSenderForwarder = (
  displayName: string,
  Provider: SliceSenderProvider
): ReactFC<SliceSenderForwarderProps> => {
  // The rule misses that the body captures `Provider` (a JSX element name
  // isn't tracked as a reference), so hoisting is impossible, not deferred.
  // oxlint-disable-next-line unicorn/consistent-function-scoping react/only-export-components
  const SliceSenderForwarder = ({ children }: SliceSenderForwarderProps): JSX.Element => {
    const transport = useBridgeTransport()
    return <Provider send={transport.sendMessage}>{children}</Provider>
  }
  SliceSenderForwarder.displayName = displayName
  return SliceSenderForwarder
}

export { makeSliceSenderForwarder }
export type { SliceSenderForwarderProps, SliceSenderProvider }

import { Effect } from 'effect'
import type { Bridge, BridgeTransport } from 'effect-messaging-core'
import { useCallback, type RefObject } from 'react'

/**
 * A stable transport sender backed by a late-bound {@link RefObject}.
 *
 * @remarks
 * The read half of the host-side "sender pipe" pattern: a transport's
 * outbound sender is built before the React component that dispatches
 * through it mounts (or a sibling registers it later), so a consumer
 * holds a stable wrapper that reads `senderRef.current` at *send* time
 * (via `Effect.suspend`). The returned function is identity-stable across
 * renders — safe in `useEffect` / `useMemo` deps — and a sender written
 * into the ref later is picked up on the next send without re-rendering.
 * Pre-registration, the ref's seeded default (typically a warn-and-drop)
 * handles sends.
 *
 * Registration is the mirror half — just assign `senderRef.current`,
 * either directly (e.g. from an `onTransportReady` Effect callback) or in
 * a mount effect.
 */
const useLateBoundSender = <
  B extends ReadonlyArray<Bridge.AnyBridge>,
  Dir extends Bridge.Direction,
>(
  senderRef: RefObject<BridgeTransport.MessageSender<B, Dir>>
): BridgeTransport.MessageSender<B, Dir> =>
  useCallback((message) => Effect.suspend(() => senderRef.current(message)), [senderRef])

export { useLateBoundSender }

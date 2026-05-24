import * as fc from 'fast-check'

/**
 * Outbound message tag → arbitrary payload generator. Mirrors the fixture
 * bridges in `./bridges.ts`. Each entry yields a fully-decoded message object
 * matching the bridge schema; tests can feed these straight into
 * `useMessageSender(...).sendEffect`.
 */
const hostOutboundMessageArb: fc.Arbitrary<{ readonly _tag: string }> = fc.oneof(
  fc.record({ _tag: fc.constant('HostBackRequested' as const) }),
  fc.record({
    _tag: fc.constant('HostRequestedWebNavigation' as const),
    path: fc.webPath(),
  }),
  fc.record({
    _tag: fc.constant('AuthTokenIssued' as const),
    token: fc.string({ minLength: 0, maxLength: 64 }),
  })
)

/**
 * Web→Host inbound message arbitrary. Mirrors `RouteChanged` from the
 * navigation fixture bridge.
 */
const webInboundMessageArb: fc.Arbitrary<{
  readonly _tag: 'RouteChanged'
  readonly pathname: string
  readonly canGoBack: boolean
}> = fc.record({
  _tag: fc.constant('RouteChanged' as const),
  pathname: fc.webPath(),
  canGoBack: fc.boolean(),
})

/**
 * Bounded sequence of outbound messages. Capped at 16 items so the React
 * render loop doesn't dominate test runtime — the property's invariant
 * (order + payload preservation) is exercised by short sequences.
 */
const outboundSequenceArb = fc.array(hostOutboundMessageArb, { minLength: 0, maxLength: 16 })

/**
 * Bounded sequence of inbound messages for receiver fanout properties.
 */
const inboundSequenceArb = fc.array(webInboundMessageArb, { minLength: 0, maxLength: 16 })

/**
 * Sender-lifecycle events for the Hoisted-provider "latest-wins" property.
 *
 * - `register`: mount a registrant with id `n` (sender becomes #n).
 * - `unregister`: unmount registrant id `n` if mounted; no-op otherwise.
 *
 * The reducer in the test threads these into a single registrant per render
 * cycle (matches React's effect ordering).
 */
type LifecycleEvent =
  | { readonly _tag: 'register'; readonly id: number }
  | { readonly _tag: 'unregister'; readonly id: number }

const lifecycleEventArb: fc.Arbitrary<LifecycleEvent> = fc.oneof(
  fc.record({
    _tag: fc.constant('register' as const),
    id: fc.integer({ min: 0, max: 3 }),
  }),
  fc.record({
    _tag: fc.constant('unregister' as const),
    id: fc.integer({ min: 0, max: 3 }),
  })
)

const lifecycleSequenceArb = fc.array(lifecycleEventArb, { minLength: 1, maxLength: 8 })

export {
  hostOutboundMessageArb,
  webInboundMessageArb,
  outboundSequenceArb,
  inboundSequenceArb,
  lifecycleEventArb,
  lifecycleSequenceArb,
}
export type { LifecycleEvent }

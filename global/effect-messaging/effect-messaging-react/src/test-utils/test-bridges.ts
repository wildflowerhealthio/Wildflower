import { Bridge, type Message } from '@wildflowerhealthio/effect-messaging-core'
import { Schema } from 'effect'

// `Message` is imported so tsgo can resolve `RecordFromPairs` through the
// public namespace when emitting declaration files (TS2883 otherwise).
type _PortableRecordFromPairs<P extends ReadonlyArray<readonly [string, never]>> =
  Message.RecordFromPairs<P>

const HostBackRequested = Schema.parseJson(Schema.TaggedStruct('HostBackRequested', {}))
const HostRequestedWebNavigation = Schema.parseJson(
  Schema.TaggedStruct('HostRequestedWebNavigation', { path: Schema.String })
)
const RouteChanged = Schema.parseJson(
  Schema.TaggedStruct('RouteChanged', { pathname: Schema.String, canGoBack: Schema.Boolean })
)

/** Fixture bridge: bi-directional navigation messages. */
const NavigationBridge = Bridge.make({
  name: 'Navigation',
  hostToWeb: [
    ['HostBackRequested', HostBackRequested],
    ['HostRequestedWebNavigation', HostRequestedWebNavigation],
  ] as const,
  webToHost: [['RouteChanged', RouteChanged]] as const,
})

const AuthTokenIssued = Schema.parseJson(
  Schema.TaggedStruct('AuthTokenIssued', { token: Schema.String })
)

/** Fixture bridge: one-way host→web auth token announcement. */
const AuthorizationBridge = Bridge.make({
  name: 'Authorization',
  hostToWeb: [['AuthTokenIssued', AuthTokenIssued]] as const,
  webToHost: [] as const,
})

const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', {}))

/** Fixture bridge: a third sibling, useful when proving multi-bridge wiring. */
const SiblingBridge = Bridge.make({
  name: 'Sibling',
  hostToWeb: [['Pong', Pong]] as const,
  webToHost: [] as const,
})

type TestBridges = readonly [typeof NavigationBridge, typeof AuthorizationBridge]
const testBridges: TestBridges = [NavigationBridge, AuthorizationBridge] as const

type TestBridgesWithSibling = readonly [
  typeof NavigationBridge,
  typeof AuthorizationBridge,
  typeof SiblingBridge,
]
const testBridgesWithSibling: TestBridgesWithSibling = [
  NavigationBridge,
  AuthorizationBridge,
  SiblingBridge,
] as const

export {
  AuthorizationBridge,
  NavigationBridge,
  SiblingBridge,
  testBridges,
  testBridgesWithSibling,
  type TestBridges,
  type TestBridgesWithSibling,
  type _PortableRecordFromPairs,
}

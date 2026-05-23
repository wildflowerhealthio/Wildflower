import { Schema } from 'effect'
import { Bridge } from 'effect-messaging-core'

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
const GatekeeperBridge = Bridge.make({
  name: 'Gatekeeper',
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

type TestBridges = readonly [typeof NavigationBridge, typeof GatekeeperBridge]
const testBridges: TestBridges = [NavigationBridge, GatekeeperBridge] as const

type TestBridgesWithSibling = readonly [
  typeof NavigationBridge,
  typeof GatekeeperBridge,
  typeof SiblingBridge,
]
const testBridgesWithSibling: TestBridgesWithSibling = [
  NavigationBridge,
  GatekeeperBridge,
  SiblingBridge,
] as const

export { GatekeeperBridge, NavigationBridge, SiblingBridge, testBridges, testBridgesWithSibling }
export type { TestBridges, TestBridgesWithSibling }

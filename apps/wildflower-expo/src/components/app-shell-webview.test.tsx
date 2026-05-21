import { render } from '@testing-library/react-native'
import { Effect as EffectType, type Layer as LayerType } from 'effect'
import * as React from 'react'
import type { ReactElement, ReactNode } from 'react'

// Hoisted module-scoped captures the mocked `effect-messaging-expo`
// populates on each render — `mock` prefix is required for
// babel-plugin-jest-hoist to leave them alone.
let mockLastBridgedWebViewProps: {
  readonly html: string
  readonly baseUrl: string
  readonly bindings: ReadonlyArray<{
    readonly bridge: { readonly name?: string }
    readonly receiverLayer: unknown
    readonly initialMessages?: ReadonlyArray<unknown>
    readonly onTransportReady?: (
      send: (msg: { readonly _tag: string }) => EffectType.Effect<void>
    ) => EffectType.Effect<void>
  }>
  readonly children?: ReactNode
} | null = null

// `BridgedWebView` is exercised in its own package's tests; capture
// the props it receives so we can assert on the binding tuple the
// shell aggregated.
jest.mock('effect-messaging-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    BridgedWebView: function MockBridgedWebView(
      props: NonNullable<typeof mockLastBridgedWebViewProps>
    ): ReactElement {
      mockLastBridgedWebViewProps = props
      return ReactInner.createElement('BridgedWebView', null, props.children)
    },
  }
})

// Stub workspace bridge modules so the receiver-layer composition is
// satisfied without actually building real bridges. The bindings
// produced by each slice's `useHostBinding` carry these stub objects
// as `bridge`; identity-equality is sufficient for the tests below.
const makeBridgeStub = (
  name: string
): { name: string; Host: { ReceiverLayer: (h: unknown) => LayerType.Layer<never> } } => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    name,
    Host: {
      ReceiverLayer: (_handlers: unknown): LayerType.Layer<never> =>
        effect.Layer.effectDiscard(effect.Effect.void),
    },
  }
}

jest.mock('navigation-core', () => ({ NavigationBridge: makeBridgeStub('Navigation') }))
jest.mock('gatekeeper-core/bridge', () => ({
  __esModule: true,
  default: makeBridgeStub('Gatekeeper'),
}))
jest.mock('collector-fundamentals/bridge', () => ({
  __esModule: true,
  default: makeBridgeStub('Collector'),
}))
jest.mock('apps-core/bridge', () => ({ __esModule: true, default: makeBridgeStub('Apps') }))

// Collector's `useHostBinding` reads from the surrounding `HostProvider`
// context. The shell doesn't mount that provider; the test stubs the
// hook to a no-op binding so the shell's binding tuple is constructable.
jest.mock('collector-expo', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    CollectorBridgeExpo: {
      useHostBinding: (): {
        readonly bridge: { name: string }
        readonly receiverLayer: LayerType.Layer<never>
      } => ({
        bridge: { name: 'Collector' },
        receiverLayer: effect.Layer.effectDiscard(effect.Effect.void),
      }),
    },
  }
})

// `TunnelStore.layerFrom(store)` is what apps-expo's `useHostBinding`
// uses to discharge `TunnelStore`. The mock returns an empty layer so
// `Layer.provide` chains without needing a real livestore.
jest.mock('tunnel-core/livestore', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    TunnelStore: {
      layerFrom: (_store: unknown): LayerType.Layer<never> =>
        effect.Layer.effectDiscard(effect.Effect.void),
    },
  }
})

// `useWildflowerStore` returns the singleton wildflower livestore; the
// stub here just needs to be a stable reference passed into the
// mocked `TunnelStore.layerFrom`.
jest.mock('../livestore/livestore-store.ts', () => ({
  useWildflowerStore: (): object => ({}),
}))

jest.mock('wildflower-react/embeddable-html', () => ({ html: '<!doctype html><html></html>' }))

jest.mock('expo-tundraish', () => ({
  Loader: (): null => null,
}))

import { AppShellWebView } from './app-shell-webview.tsx'

beforeEach(() => {
  mockLastBridgedWebViewProps = null
})

/**
 * Convenience accessor — every test asserts against the captured
 * binding tuple. Throws (failing the test) if the shell never
 * mounted `BridgedWebView`.
 */
const expectBindings = (): NonNullable<typeof mockLastBridgedWebViewProps>['bindings'] => {
  expect(mockLastBridgedWebViewProps).not.toBeNull()
  if (mockLastBridgedWebViewProps === null) throw new Error('BridgedWebView never mounted')
  return mockLastBridgedWebViewProps.bindings
}

const findBindingByBridgeName = (
  bindings: NonNullable<typeof mockLastBridgedWebViewProps>['bindings'],
  bridgeName: string
): (typeof bindings)[number] | undefined =>
  bindings.find((b): boolean => b.bridge.name === bridgeName)

describe('AppShellWebView', () => {
  it('seeds HostRequestedWebNavigation via the navigation binding initialMessages', () => {
    render(<AppShellWebView baseUrl="https://example.test" route="/apps" />)
    const bindings = expectBindings()
    const nav = findBindingByBridgeName(bindings, 'Navigation')
    expect(nav?.initialMessages).toEqual([{ _tag: 'HostRequestedWebNavigation', path: '/apps' }])
  })

  it('keeps AuthTokenIssued out of every binding initialMessages even when a token is provided', () => {
    // The token would otherwise be encoded into the WebView URL as a
    // query parameter and leaked into native logs / Sentry breadcrumbs.
    render(<AppShellWebView baseUrl="https://example.test" route="/apps" token="bearer-xyz" />)
    const bindings = expectBindings()
    const allInitial = bindings.flatMap((b) => b.initialMessages ?? [])
    const serialised = JSON.stringify(allInitial)
    expect(serialised).not.toContain('bearer-xyz')
  })

  it("issues AuthTokenIssued through the gatekeeper binding's onTransportReady when a token is provided", async () => {
    render(<AppShellWebView baseUrl="https://example.test" route="/apps" token="bearer-xyz" />)
    const bindings = expectBindings()
    const gk = findBindingByBridgeName(bindings, 'Gatekeeper')
    expect(gk?.onTransportReady).toBeDefined()
    if (gk?.onTransportReady === undefined) return
    const sent: Array<{ readonly _tag: string }> = []
    await EffectType.runPromise(gk.onTransportReady((msg) => EffectType.sync(() => sent.push(msg))))
    expect(sent).toContainEqual({ _tag: 'AuthTokenIssued', token: 'bearer-xyz' })
  })

  it('omits the gatekeeper onTransportReady when no token is provided', () => {
    render(<AppShellWebView baseUrl="https://example.test" route="/apps" />)
    const bindings = expectBindings()
    const gk = findBindingByBridgeName(bindings, 'Gatekeeper')
    expect(gk?.onTransportReady).toBeUndefined()
  })

  it('forwards baseUrl into BridgedWebView', () => {
    render(<AppShellWebView baseUrl="https://example.test" route="/apps" />)
    expect(mockLastBridgedWebViewProps?.baseUrl).toBe('https://example.test')
  })

  it('mounts a BridgedWebView with all four slice bindings in declaration order', () => {
    render(<AppShellWebView baseUrl="https://example.test" route="/apps" />)
    const bindings = expectBindings()
    expect(bindings.map((b) => b.bridge.name)).toEqual([
      'Navigation',
      'Gatekeeper',
      'Collector',
      'Apps',
    ])
  })

  it('renders without throwing with onRouteChanged and children attached (smoke)', () => {
    const onRouteChanged = jest.fn()
    expect(() =>
      render(
        <AppShellWebView
          baseUrl="https://example.test"
          route="/apps"
          onRouteChanged={onRouteChanged}
        >
          <React.Fragment />
        </AppShellWebView>
      )
    ).not.toThrow()
  })
})

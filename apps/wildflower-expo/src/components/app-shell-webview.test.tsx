import { act, render, waitFor } from '@testing-library/react-native'
import { Effect as EffectType, type Layer as LayerType } from 'effect'
import * as React from 'react'
import type { ReactElement, ReactNode } from 'react'

// `mock*` prefix is required for babel-plugin-jest-hoist to leave the
// shared captures alone when it hoists `jest.mock` calls above
// non-mock identifiers.
let mockLastBridgedWebViewProps: {
  readonly loadFrom: { readonly _tag: 'html'; readonly html: string; readonly baseUrl: string }
  readonly bindings: ReadonlyArray<{
    readonly bridge: { readonly name?: string }
    readonly receiverLayer: unknown
    readonly initialMessages?: ReadonlyArray<unknown>
    readonly onTransportReady?: (
      send: (msg: { readonly _tag: string }) => EffectType.Effect<void>
    ) => EffectType.Effect<void>
  }>
} | null = null

// `BridgedWebView` is exercised in its own package's tests; here we
// capture the props it receives so we can assert on the aggregated
// binding tuple and pull each binding's lifecycle callbacks for
// direct invocation.
jest.mock('effect-messaging-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    BridgedWebView: function MockBridgedWebView(
      props: NonNullable<typeof mockLastBridgedWebViewProps>
    ): ReactElement {
      mockLastBridgedWebViewProps = props
      return ReactInner.createElement('BridgedWebView', null, null)
    },
  }
})

// Slice host-binding hooks: each returns a stub binding shaped like
// `HostBinding.HostBinding<typeof Bridge>`. Identity-equality on
// `bridge.name` is enough for the assertions below.
let mockNavigationOptions: { initialRoute?: string; onRouteChanged?: unknown } | null = null
jest.mock('navigation-expo', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    NavigationBridgeExpo: {
      useHostBinding: (options: { initialRoute?: string; onRouteChanged?: unknown }): object => {
        mockNavigationOptions = options
        return {
          bridge: { name: 'Navigation' },
          receiverLayer: effect.Layer.effectDiscard(effect.Effect.void),
          initialMessages:
            options.initialRoute === undefined
              ? undefined
              : [{ _tag: 'HostRequestedWebNavigation' as const, path: options.initialRoute }],
        }
      },
    },
  }
})

jest.mock('gatekeeper-expo', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    GatekeeperBridgeExpo: {
      useHostBinding: (options: { token?: string } = {}): object => ({
        bridge: { name: 'Gatekeeper' },
        receiverLayer: effect.Layer.effectDiscard(effect.Effect.void),
        initialMessages: [{ _tag: 'WaitForToken' as const }],
        onTransportReady:
          options.token === undefined
            ? undefined
            : (
                send: (msg: {
                  readonly _tag: string
                  readonly [k: string]: unknown
                }) => EffectType.Effect<void>
              ) => send({ _tag: 'AuthTokenIssued', token: options.token }),
      }),
    },
  }
})

jest.mock('collector-expo', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    useCollectorHostBinding: (): object => ({
      bridge: { name: 'Collector' },
      receiverLayer: effect.Layer.effectDiscard(effect.Effect.void),
    }),
  }
})

let mockAppsOptions: { tunnelStoreLayer?: unknown } | null = null
jest.mock('apps-expo', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    AppsBridgeExpo: {
      useHostBinding: (options: { tunnelStoreLayer?: unknown }): object => {
        mockAppsOptions = options
        return {
          bridge: { name: 'Apps' },
          receiverLayer: effect.Layer.effectDiscard(effect.Effect.void),
        }
      },
    },
  }
})

// `NavigationBridge` is imported as a type witness by the shell's
// `NavigationSender` type alias; jest only cares that the import
// resolves to *some* value.
jest.mock('navigation-core', () => ({
  NavigationBridge: { name: 'Navigation' },
}))

jest.mock('tunnel-core/livestore', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  const fakeLayer = effect.Layer.effectDiscard(effect.Effect.void)
  return {
    TunnelStore: {
      layerFrom: (_store: unknown): LayerType.Layer<never> => fakeLayer,
    },
  }
})

jest.mock('../livestore/livestore-store.ts', () => ({
  useWildflowerStore: (): object => ({}),
}))

jest.mock('wildflower-react/embeddable-html', () => ({ html: '<!doctype html><html></html>' }))

jest.mock('expo-tundraish', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return { Loader: (): ReactElement => ReactInner.createElement('Loader', null, null) }
})

import { AppShellWebView } from './app-shell-webview.tsx'
import { NavigationPipeProvider, useNavigationSender } from './navigation-pipe.ts'

beforeEach(() => {
  mockLastBridgedWebViewProps = null
  mockNavigationOptions = null
  mockAppsOptions = null
})

const mountInPipe = (children: ReactNode): ReturnType<typeof render> =>
  render(<NavigationPipeProvider>{children}</NavigationPipeProvider>)

const expectBindings = (): NonNullable<typeof mockLastBridgedWebViewProps>['bindings'] => {
  expect(mockLastBridgedWebViewProps).not.toBeNull()
  if (mockLastBridgedWebViewProps === null) throw new Error('BridgedWebView never mounted')
  return mockLastBridgedWebViewProps.bindings
}

const findBindingByName = (
  bindings: NonNullable<typeof mockLastBridgedWebViewProps>['bindings'],
  name: string
): (typeof bindings)[number] | undefined => bindings.find((b): boolean => b.bridge.name === name)

describe('AppShellWebView', () => {
  it('mounts BridgedWebView with all four slice bindings in declaration order', () => {
    mountInPipe(<AppShellWebView baseUrl="https://example.test" route="/apps" />)
    const bindings = expectBindings()
    expect(bindings.map((b) => b.bridge.name)).toEqual([
      'Navigation',
      'Gatekeeper',
      'Collector',
      'Apps',
    ])
  })

  it('forwards baseUrl into BridgedWebView via loadFrom', () => {
    mountInPipe(<AppShellWebView baseUrl="https://example.test" route="/apps" />)
    expect(mockLastBridgedWebViewProps?.loadFrom.baseUrl).toBe('https://example.test')
  })

  it('passes initialRoute + onRouteChanged into the navigation host-binding hook', () => {
    const onRouteChanged = jest.fn()
    mountInPipe(
      <AppShellWebView
        baseUrl="https://example.test"
        route="/apps"
        onRouteChanged={onRouteChanged}
      />
    )
    expect(mockNavigationOptions?.initialRoute).toBe('/apps')
    expect(mockNavigationOptions?.onRouteChanged).toBe(onRouteChanged)
  })

  it('seeds HostRequestedWebNavigation via the navigation binding initialMessages', () => {
    mountInPipe(<AppShellWebView baseUrl="https://example.test" route="/apps" />)
    const nav = findBindingByName(expectBindings(), 'Navigation')
    expect(nav?.initialMessages).toEqual([{ _tag: 'HostRequestedWebNavigation', path: '/apps' }])
  })

  it('attaches an onTransportReady wrapper to the navigation binding', () => {
    // The base `useNavigationHostBinding` doesn't ship one — the shell
    // adds it so the captured transport sender can be plugged into
    // the navigation pipe.
    mountInPipe(<AppShellWebView baseUrl="https://example.test" route="/apps" />)
    const nav = findBindingByName(expectBindings(), 'Navigation')
    expect(nav?.onTransportReady).toBeDefined()
  })

  it('registers the captured navigation sender into the pipe so descendants resolve it', async () => {
    // Wrap in a single-slot tuple so the closure assignment survives
    // TS's `let` widening across async boundaries — `senderBox[0]`
    // narrows cleanly after a null check, whereas a `let` declared
    // outside the closure re-widens to `T | null` at the call site.
    type NavSender = ReturnType<typeof useNavigationSender>
    const senderBox: { current: NavSender | null } = { current: null }

    function SenderProbe(): null {
      senderBox.current = useNavigationSender()
      return null
    }

    mountInPipe(
      <>
        <AppShellWebView baseUrl="https://example.test" route="/apps" />
        <SenderProbe />
      </>
    )

    const nav = findBindingByName(expectBindings(), 'Navigation')
    const navOnTransportReady = nav?.onTransportReady
    if (navOnTransportReady === undefined) throw new Error('navigation onTransportReady missing')

    const dispatched: Array<{ readonly _tag: string }> = []
    const fakeTransportSender = (msg: {
      readonly _tag: string
      readonly [k: string]: unknown
    }): EffectType.Effect<void> => EffectType.sync(() => dispatched.push(msg))

    // Fire the binding's `onTransportReady` — the shell's wrapper
    // commits the sender into state, triggers a re-render, and
    // `useAsNavigationSource` registers it in the pipe.
    await act(async () => {
      await EffectType.runPromise(navOnTransportReady(fakeTransportSender))
    })

    // The probe resolved `useNavigationSender` against the pipe's
    // stable proxy; calling it routes through the now-registered
    // fake transport sender.
    await waitFor(() => {
      expect(senderBox.current).not.toBeNull()
    })
    const sender = senderBox.current
    if (sender === null) throw new Error('SenderProbe never resolved')
    await EffectType.runPromise(sender({ _tag: 'HostRequestedWebNavigation', path: '/test' }))
    expect(dispatched).toContainEqual({ _tag: 'HostRequestedWebNavigation', path: '/test' })
  })

  it('keeps the bearer token out of every binding initialMessages', () => {
    // Token round-trips through gatekeeper's `onTransportReady`
    // (see `useGatekeeperHostBinding`); leaking it into
    // `initialMessages` would serialize it into the WebView URL.
    mountInPipe(<AppShellWebView baseUrl="https://example.test" route="/apps" token="bearer-xyz" />)
    const bindings = expectBindings()
    const allInitial = bindings.flatMap((b) => b.initialMessages ?? [])
    expect(JSON.stringify(allInitial)).not.toContain('bearer-xyz')
  })

  it("issues AuthTokenIssued through the gatekeeper binding's onTransportReady when a token is provided", async () => {
    mountInPipe(<AppShellWebView baseUrl="https://example.test" route="/apps" token="bearer-xyz" />)
    const gk = findBindingByName(expectBindings(), 'Gatekeeper')
    if (gk?.onTransportReady === undefined) throw new Error('gatekeeper onTransportReady missing')

    const sent: Array<{ readonly _tag: string }> = []
    await EffectType.runPromise(gk.onTransportReady((msg) => EffectType.sync(() => sent.push(msg))))
    expect(sent).toContainEqual({ _tag: 'AuthTokenIssued', token: 'bearer-xyz' })
  })

  it('omits the gatekeeper onTransportReady when no token is provided', () => {
    mountInPipe(<AppShellWebView baseUrl="https://example.test" route="/apps" />)
    const gk = findBindingByName(expectBindings(), 'Gatekeeper')
    expect(gk?.onTransportReady).toBeUndefined()
  })

  it('threads the tunnelStoreLayer into the apps host binding', () => {
    mountInPipe(<AppShellWebView baseUrl="https://example.test" route="/apps" />)
    // `apps-expo`'s host binding needs `TunnelStore` discharged — the
    // shell constructs the layer from the wildflower store and hands
    // it in.
    expect(mockAppsOptions?.tunnelStoreLayer).toBeDefined()
  })
})

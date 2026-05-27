import { act, render, waitFor } from '@testing-library/react-native'
import { Effect as EffectType } from 'effect'
import type { BridgeTransport } from 'effect-messaging-core'
import type { NavigationBridge as NavigationBridgeType } from 'navigation-core'
import * as React from 'react'
import type { ReactElement, ReactNode } from 'react'

import type * as BindingMocks from './__test-support__/app-shell-binding-mocks.ts'

// `mock*` prefix is required for babel-plugin-jest-hoist to leave these
// shared captures alone when it hoists the `jest.mock` factories above
// non-mock identifiers.
type NavigationSender = BridgeTransport.MessageSender<
  readonly [typeof NavigationBridgeType],
  'Host'
>

type NavigationBindingMock = {
  readonly bridge: { readonly name: 'Navigation' }
  readonly receiverLayer: unknown
  readonly initialMessages?: ReadonlyArray<unknown>
  readonly onTransportReady?: (send: NavigationSender) => EffectType.Effect<void>
}

type GatekeeperBindingMock = {
  readonly bridge: { readonly name: 'Gatekeeper' }
  readonly receiverLayer: unknown
  readonly initialMessages?: ReadonlyArray<unknown>
  readonly onTransportReady?: (
    send: (msg: {
      readonly _tag: 'AuthTokenIssued'
      readonly token: string
    }) => EffectType.Effect<void>
  ) => EffectType.Effect<void>
}

type CollectorBindingMock = {
  readonly bridge: { readonly name: 'Collector' }
  readonly receiverLayer: unknown
  readonly initialMessages?: ReadonlyArray<unknown>
}

type AppsBindingMock = {
  readonly bridge: { readonly name: 'Apps' }
  readonly receiverLayer: unknown
  readonly initialMessages?: ReadonlyArray<unknown>
}

type LogBindingMock = {
  readonly bridge: { readonly name: 'Log' }
  readonly receiverLayer: unknown
  readonly initialMessages?: ReadonlyArray<unknown>
}

type AnyBindingMock =
  | NavigationBindingMock
  | GatekeeperBindingMock
  | CollectorBindingMock
  | AppsBindingMock
  | LogBindingMock

type BindingByName<TName extends AnyBindingMock['bridge']['name']> = Extract<
  AnyBindingMock,
  { readonly bridge: { readonly name: TName } }
>

type AppShellBindings = ReadonlyArray<AnyBindingMock>

let mockLastBridgedWebViewProps: {
  readonly loadFrom: { readonly _tag: 'html'; readonly html: string; readonly baseUrl: string }
  readonly bindings: AppShellBindings
} | null = null

// `BridgedWebView` is exercised in its own package's tests; here we
// capture the props it receives so we can assert on the aggregated
// binding tuple and pull each binding's lifecycle callbacks for direct
// invocation.
jest.mock('effect-messaging-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  const mocks = jest.requireActual<typeof BindingMocks>(
    './__test-support__/app-shell-binding-mocks.ts'
  )
  return {
    BridgedWebView: function MockBridgedWebView(
      props: NonNullable<typeof mockLastBridgedWebViewProps>
    ): ReactElement {
      mockLastBridgedWebViewProps = props
      return ReactInner.createElement('BridgedWebView', null, null)
    },
    useLogHostBinding: (): object => mocks.makeLogMock(),
  }
})

jest.mock('gatekeeper-expo', () => {
  const mocks = jest.requireActual<typeof BindingMocks>(
    './__test-support__/app-shell-binding-mocks.ts'
  )
  return {
    GatekeeperBridgeExpo: {
      useHostBinding: (options: { token?: string } = {}): object =>
        mocks.makeGatekeeperMock(options),
    },
  }
})

jest.mock('collector-expo', () => {
  const mocks = jest.requireActual<typeof BindingMocks>(
    './__test-support__/app-shell-binding-mocks.ts'
  )
  return {
    useCollectorHostBinding: (): object => mocks.makeCollectorMock(),
  }
})

let mockAppsOptions: { store?: unknown } | null = null
jest.mock('apps-expo', () => {
  const mocks = jest.requireActual<typeof BindingMocks>(
    './__test-support__/app-shell-binding-mocks.ts'
  )
  return {
    AppsBridgeExpo: {
      useHostBinding: (options: { store?: unknown }): object => {
        mockAppsOptions = options
        return mocks.makeAppsMock()
      },
    },
  }
})

// `Symbol.for(...)` (not `Symbol(...)`) so the mock factory — hoisted
// above the `const mockLocalOriginQueryId = ...` initializer — and the
// per-test useQuery handler resolve to the same symbol via the global
// registry.
const mockLocalOriginQueryId = Symbol.for('mock-wildflower-localOrigin$')
const mockLocalClientTokenQueryId = Symbol.for('mock-wildflower-LocalClientToken.current$')

jest.mock('local-http-server-core/livestore', () => ({
  localOrigin$: Symbol.for('mock-wildflower-localOrigin$'),
}))

jest.mock('gatekeeper-core/livestore', () => ({
  LocalClientToken: {
    queries: {
      current$: Symbol.for('mock-wildflower-LocalClientToken.current$'),
    },
  },
}))

const defaultStoreMock = (): { useQuery: (q: unknown) => unknown } => ({
  useQuery: (q: unknown): unknown => {
    if (q === mockLocalOriginQueryId) return 'https://example.test'
    if (q === mockLocalClientTokenQueryId) return { value: null }
    throw new Error('unexpected query')
  },
})

let mockWildflowerStoreImpl: () => { useQuery: (q: unknown) => unknown } = defaultStoreMock
jest.mock('../livestore/livestore-store.ts', () => ({
  useWildflowerStore: (): unknown => mockWildflowerStoreImpl(),
}))

jest.mock('wildflower-react/embeddable-html', () => ({ html: '<!doctype html><html></html>' }))

jest.mock('expo-tundraish', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return { Loader: (): ReactElement => ReactInner.createElement('Loader', null, null) }
})

import { AppShellWebView } from './app-shell-webview.tsx'
import { NavigationPipeProvider, useNavigationSender } from './navigation-pipe.ts'

const storeMockWithToken =
  (token: string): (() => { useQuery: (q: unknown) => unknown }) =>
  () => ({
    useQuery: (q: unknown): unknown => {
      if (q === mockLocalOriginQueryId) return 'https://example.test'
      if (q === mockLocalClientTokenQueryId) return { value: token }
      throw new Error('unexpected query')
    },
  })

beforeEach(() => {
  mockLastBridgedWebViewProps = null
  mockAppsOptions = null
  mockWildflowerStoreImpl = defaultStoreMock
})

const noopRouteChanged = (): void => {}

const mountInPipe = (children: ReactNode): ReturnType<typeof render> =>
  render(<NavigationPipeProvider>{children}</NavigationPipeProvider>)

const expectBindings = (): AppShellBindings => {
  expect(mockLastBridgedWebViewProps).not.toBeNull()
  if (mockLastBridgedWebViewProps === null) throw new Error('BridgedWebView never mounted')
  return mockLastBridgedWebViewProps.bindings
}

const findBindingByName = <TName extends AnyBindingMock['bridge']['name']>(
  bindings: AppShellBindings,
  name: TName
): BindingByName<TName> | undefined =>
  bindings.find((b): b is BindingByName<TName> => b.bridge.name === name)

describe('AppShellWebView', () => {
  it('mounts BridgedWebView with all five slice bindings in declaration order', () => {
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const bindings = expectBindings()
    expect(bindings.map((b) => b.bridge.name)).toEqual([
      'Navigation',
      'Gatekeeper',
      'Collector',
      'Apps',
      'Log',
    ])
  })

  it('forwards the loopback origin from the store into BridgedWebView via loadFrom', () => {
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    expect(mockLastBridgedWebViewProps?.loadFrom.baseUrl).toBe('https://example.test')
  })

  it('seeds HostRequestedWebNavigation via the navigation binding initialMessages', () => {
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const nav = findBindingByName(expectBindings(), 'Navigation')
    expect(nav?.initialMessages).toEqual([{ _tag: 'HostRequestedWebNavigation', path: '/apps' }])
  })

  it('exposes an onTransportReady on the navigation binding so the shell can capture the sender', () => {
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const nav = findBindingByName(expectBindings(), 'Navigation')
    expect(nav?.onTransportReady).toBeDefined()
  })

  it('threads the wildflower store into the apps host binding', () => {
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    // `apps-expo`'s host binding takes the store directly (and
    // builds the TunnelStore layer internally).
    expect(mockAppsOptions?.store).toBeDefined()
  })

  describe('token issuance via gatekeeper', () => {
    it('omits the gatekeeper onTransportReady when no token is in the store', () => {
      mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
      const gk = findBindingByName(expectBindings(), 'Gatekeeper')
      expect(gk?.onTransportReady).toBeUndefined()
    })

    it('issues AuthTokenIssued through the gatekeeper binding when the store has a token', async () => {
      mockWildflowerStoreImpl = storeMockWithToken('bearer-xyz')
      mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
      const gk = findBindingByName(expectBindings(), 'Gatekeeper')
      if (gk?.onTransportReady === undefined) throw new Error('gatekeeper onTransportReady missing')

      const sent: Array<{ readonly _tag: 'AuthTokenIssued'; readonly token: string }> = []
      await EffectType.runPromise(
        gk.onTransportReady((msg) =>
          EffectType.sync((): void => {
            sent.push(msg)
          })
        )
      )
      expect(sent).toContainEqual({ _tag: 'AuthTokenIssued', token: 'bearer-xyz' })
    })

    it('keeps the bearer token out of every binding initialMessages', () => {
      // Token round-trips through gatekeeper's `onTransportReady`;
      // leaking it into `initialMessages` would serialize it into the
      // WebView URL.
      mockWildflowerStoreImpl = storeMockWithToken('bearer-xyz')
      mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
      const bindings = expectBindings()
      const allInitial = bindings.flatMap((b) => b.initialMessages ?? [])
      expect(JSON.stringify(allInitial)).not.toContain('bearer-xyz')
    })
  })

  it('routes a tab-bar-side dispatch through the captured transport sender', async () => {
    type NavSender = ReturnType<typeof useNavigationSender>
    const senderBox: { current: NavSender | null } = { current: null }
    function SenderProbe(): null {
      senderBox.current = useNavigationSender()
      return null
    }

    mountInPipe(
      <>
        <AppShellWebView onRouteChanged={noopRouteChanged} />
        <SenderProbe />
      </>
    )

    const nav = findBindingByName(expectBindings(), 'Navigation')
    const navOnTransportReady = nav?.onTransportReady
    if (navOnTransportReady === undefined) throw new Error('navigation onTransportReady missing')

    const dispatched: Array<{ readonly _tag: string }> = []
    const fakeTransportSender: NavSender = (msg) =>
      EffectType.sync((): void => {
        dispatched.push(msg)
      })

    await act(async () => {
      await EffectType.runPromise(navOnTransportReady(fakeTransportSender))
    })

    await waitFor(() => {
      expect(senderBox.current).not.toBeNull()
    })
    const sender = senderBox.current
    if (sender === null) throw new Error('SenderProbe never resolved')
    await EffectType.runPromise(sender({ _tag: 'HostRequestedWebNavigation', path: '/test' }))
    expect(dispatched).toContainEqual({ _tag: 'HostRequestedWebNavigation', path: '/test' })
  })
})

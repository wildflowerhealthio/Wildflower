import { act, render, waitFor } from '@testing-library/react-native'
import { Effect as EffectType, type Layer as LayerType } from 'effect'
import { Bridge, HostBindings } from 'effect-messaging-core'
import { expectTypeOf } from 'expect-type'
import * as React from 'react'
import type { ReactElement, ReactNode } from 'react'

let mockLastBridgedWebViewProps: {
  readonly loadFrom: { readonly _tag: 'html'; readonly html: string; readonly baseUrl: string }
  readonly bindings: {
    readonly bridges: ReadonlyArray<{ readonly name?: string }>
    readonly handlers: ReadonlyArray<unknown>
    readonly initialMessages: ReadonlyArray<ReadonlyArray<unknown>>
    readonly onTransportReady: ReadonlyArray<
      | ((
          send: (msg: { readonly _tag: string }) => EffectType.Effect<void>
        ) => EffectType.Effect<void>)
      | undefined
    >
  }
} | null = null

// `BridgedWebView` is exercised in its own package's tests; here we
// capture the props it receives so we can assert on the merged
// binding value and pull each binding's lifecycle callback for
// direct invocation. `useLogHostBinding` is stubbed as a 1-tuple
// log binding so the shell's tuple-combine matches the production
// shape at runtime.
jest.mock('effect-messaging-expo', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return {
    BridgedWebView: function MockBridgedWebView(
      props: NonNullable<typeof mockLastBridgedWebViewProps>
    ): ReactElement {
      mockLastBridgedWebViewProps = props
      return ReactInner.createElement('BridgedWebView', null, null)
    },
    useLogHostBinding: (): {
      readonly bridges: ReadonlyArray<{ readonly name: string }>
      readonly handlers: ReadonlyArray<unknown>
      readonly initialMessages: ReadonlyArray<ReadonlyArray<unknown>>
      readonly onTransportReady: ReadonlyArray<undefined>
    } => ({
      bridges: [{ name: 'Log' }],
      handlers: [{}],
      initialMessages: [[]],
      onTransportReady: [undefined],
    }),
  }
})

/**
 * Build a 1-tuple `HostBindings` stand-in shaped like the real
 * `HostBindings.single({...})` output so the shell's
 * `HostBindings.combine(...)` accepts it at runtime.
 */
type MockBindings = {
  readonly bridges: ReadonlyArray<{ readonly name: string }>
  readonly handlers: ReadonlyArray<unknown>
  readonly initialMessages: ReadonlyArray<ReadonlyArray<unknown>>
  readonly onTransportReady: ReadonlyArray<
    | ((
        send: (msg: { readonly _tag: string }) => EffectType.Effect<void>
      ) => EffectType.Effect<void>)
    | undefined
  >
}

// Anchor `MockBindings` against the production `HostBindings` shape so
// any parallel-array drift — a fifth field, a renamed field — fails
// this file at compile time. Uses a minimal `Bridge.make`-built stub as
// the bridge witness because `HostBindings.HostBindings<Bridges>`
// requires `Bridges extends ReadonlyArray<Bridge.AnyBridge>`; a bare
// `{ name: string }` doesn't satisfy that bound. Keys-level comparison
// sidesteps the per-bridge variance the slice mocks intentionally relax
// (their stub bridges aren't real `Bridge.AnyBridge`s).
const stubBridgeForTypeCheck = Bridge.make({
  name: 'TypeCheckStub',
  hostToWeb: [] as const,
  webToHost: [] as const,
})
expectTypeOf<keyof MockBindings>().toEqualTypeOf<
  keyof HostBindings.HostBindings<readonly [typeof stubBridgeForTypeCheck]>
>()

// Delegate to the production `HostBindings.single` so a future change
// to its body (e.g. populating a fifth array) surfaces in every mock
// factory below at runtime. The input cast widens the lightweight stub
// to `Bridge.AnyBridge`; the output cast narrows the rich result to
// `MockBindings`. Both are sound because `single` reads only the four
// input fields and returns the same four arrays it received.
const singleMock = (binding: {
  readonly bridge: { readonly name: string }
  readonly handlers: unknown
  readonly initialMessages?: ReadonlyArray<unknown>
  readonly onTransportReady?: (
    send: (msg: { readonly _tag: string }) => EffectType.Effect<void>
  ) => EffectType.Effect<void>
}): MockBindings => {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const widenedBinding = binding as unknown as Parameters<
    typeof HostBindings.single<typeof stubBridgeForTypeCheck>
  >[0]
  const result = HostBindings.single(widenedBinding)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  return result as unknown as MockBindings
}

// Slice host-binding hooks: each returns a 1-tuple `HostBindings`
// stand-in. Identity-equality on `bridge.name` is enough for the
// assertions below.
let mockNavigationOptions: {
  initialRoute?: string
  onRouteChanged?: unknown
  onUiReady?: () => void
  onTransportReady?: (
    send: (msg: { readonly _tag: string }) => EffectType.Effect<void>
  ) => EffectType.Effect<void>
} | null = null
jest.mock('navigation-expo', () => {
  return {
    NavigationBridgeExpo: {
      useHostBinding: (options: {
        initialRoute?: string
        onRouteChanged?: unknown
        onUiReady?: () => void
        onTransportReady?: (
          send: (msg: { readonly _tag: string }) => EffectType.Effect<void>
        ) => EffectType.Effect<void>
      }): MockBindings => {
        mockNavigationOptions = options
        return singleMock({
          bridge: { name: 'Navigation' },
          handlers: {},
          initialMessages:
            options.initialRoute === undefined
              ? undefined
              : [{ _tag: 'HostRequestedWebNavigation' as const, path: options.initialRoute }],
          onTransportReady: options.onTransportReady,
        })
      },
    },
  }
})

// Capture the splash-screen mock's `hideAsync` so the test below can
// assert the navigation binding's `onUiReady` calls it. Returning a
// resolved promise mirrors expo-splash-screen's real API, which the
// shell calls inside a `void` to discard the promise.
const mockSplashHideAsync = jest.fn<Promise<void>, []>(() => Promise.resolve())
jest.mock('expo-splash-screen', () => ({
  hideAsync: (): Promise<void> => mockSplashHideAsync(),
}))

// Capture the options gatekeeper-expo's hook receives so the wiring
// assertions below can read what the shell passed in. The mock's
// `onTransportReady` is a no-op: the shell only owes gatekeeper the
// token value, and no test in this file exercises the captured
// sender. The real token-delivery contract (capture sender →
// post-mount send) is pinned by `gatekeeper-expo`'s own tests
// (`use-host-binding.test.ts`).
let mockGatekeeperOptions: { token?: string } | null = null
jest.mock('gatekeeper-expo', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    GatekeeperBridgeExpo: {
      useHostBinding: (options: { token?: string } = {}): MockBindings => {
        mockGatekeeperOptions = options
        return singleMock({
          bridge: { name: 'Gatekeeper' },
          handlers: {},
          initialMessages: [],
          onTransportReady: (): EffectType.Effect<void> => effect.Effect.void,
        })
      },
    },
  }
})

jest.mock('collector-expo', () => {
  return {
    useCollectorHostBinding: (): MockBindings =>
      singleMock({
        bridge: { name: 'Collector' },
        handlers: {},
      }),
  }
})

let mockAppsOptions: { store?: unknown } | null = null
jest.mock('apps-expo', () => {
  return {
    AppsBridgeExpo: {
      useHostBinding: (options: { store?: unknown }): MockBindings => {
        mockAppsOptions = options
        return singleMock({
          bridge: { name: 'Apps' },
          handlers: {},
        })
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

// Sentinel keys are inlined into the factories below. babel-jest hoists
// these `jest.mock` calls (and the `import` for `AppShellWebView`) above
// the file body, so any `const` declared up here would still be
// `undefined` when the factory runs during the require chain. The
// `useQuery` mock discriminates by reading `kind` at call time —
// which is safely after the body has executed.
jest.mock('local-http-server-core/livestore', () => ({
  localOrigin$: { kind: 'localOrigin$' },
}))

jest.mock('gatekeeper-core/livestore', () => ({
  LocalClientToken: {
    queries: { current$: { kind: 'localClientToken' } },
  },
}))

// Per-test override slot for the local client token row. Defaults to a
// bearer so the gatekeeper `onTransportReady` path is exercised; tests
// that need the absent-token branch reassign this before mounting. The
// `mock` prefix lets the `jest.mock` factory below close over it.
let mockLocalClientTokenRow: { readonly value: string | null } = { value: 'bearer-xyz' }

jest.mock('../livestore/livestore-store.ts', () => ({
  useWildflowerStore: (): { useQuery: (q: unknown) => unknown } => ({
    useQuery: (q: unknown): unknown => {
      if (typeof q === 'object' && q !== null && 'kind' in q) {
        if (q.kind === 'localOrigin$') return 'https://example.test'
        if (q.kind === 'localClientToken') return mockLocalClientTokenRow
      }
      throw new Error(`Unexpected useQuery key: ${JSON.stringify(q)}`)
    },
  }),
}))

jest.mock('wildflower-react/embeddable-html', () => ({ html: '<!doctype html><html></html>' }))

jest.mock('expo-tundraish', () => {
  const ReactInner = jest.requireActual<typeof React>('react')
  return { Loader: (): ReactElement => ReactInner.createElement('Loader', null, null) }
})

import { AppShellWebView } from './app-shell-webview.tsx'
import { NavigationPipeProvider, useNavigationSender } from './navigation-pipe.tsx'

beforeEach(() => {
  mockLastBridgedWebViewProps = null
  mockNavigationOptions = null
  mockGatekeeperOptions = null
  mockAppsOptions = null
  mockLocalClientTokenRow = { value: 'bearer-xyz' }
  mockSplashHideAsync.mockClear()
})

const noopRouteChanged = (): void => {}

const mountInPipe = (children: ReactNode): ReturnType<typeof render> =>
  render(<NavigationPipeProvider>{children}</NavigationPipeProvider>)

const expectBindings = (): NonNullable<typeof mockLastBridgedWebViewProps>['bindings'] => {
  expect(mockLastBridgedWebViewProps).not.toBeNull()
  if (mockLastBridgedWebViewProps === null) throw new Error('BridgedWebView never mounted')
  return mockLastBridgedWebViewProps.bindings
}

const indexOf = (
  bindings: NonNullable<typeof mockLastBridgedWebViewProps>['bindings'],
  name: string
): number => bindings.bridges.findIndex((b): boolean => b.name === name)

describe('AppShellWebView', () => {
  it('mounts BridgedWebView with all five bindings in declaration order', () => {
    // Order matches `HostBindings.combine([...])` in `use-host-bindings.ts`:
    // four slice bindings followed by the cross-cutting `Logging` binding
    // supplied by `useLogHostBinding`.
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const bindings = expectBindings()
    expect(bindings.bridges.map((b) => b.name)).toEqual([
      'Navigation',
      'Gatekeeper',
      'Collector',
      'Apps',
      'Log',
    ])
  })

  it('forwards baseUrl into BridgedWebView via loadFrom', () => {
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    expect(mockLastBridgedWebViewProps?.loadFrom.baseUrl).toBe('https://example.test')
  })

  it('passes initialRoute + onRouteChanged into the navigation host-binding hook', () => {
    const onRouteChanged = jest.fn()
    mountInPipe(<AppShellWebView onRouteChanged={onRouteChanged} />)
    expect(mockNavigationOptions?.initialRoute).toBe('/apps')
    expect(mockNavigationOptions?.onRouteChanged).toBe(onRouteChanged)
  })

  it('threads an onUiReady into the navigation binding that hides the native splash', () => {
    // Shell-level wiring contract: the navigation binding's `UIReady`
    // receiver runs the supplied `onUiReady` callback, which the shell
    // wires to `SplashScreen.hideAsync()`. Without this, the embedded
    // SPA's `UIReady` arrives but the host's splash never lifts.
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const onUiReady = mockNavigationOptions?.onUiReady
    expect(typeof onUiReady).toBe('function')
    expect(mockSplashHideAsync).not.toHaveBeenCalled()

    if (onUiReady === undefined) throw new Error('onUiReady not threaded into navigation binding')
    onUiReady()

    expect(mockSplashHideAsync).toHaveBeenCalledTimes(1)
  })

  it('swallows a SplashScreen.hideAsync rejection inside onUiReady so it does not escape as an unhandled promise rejection', async () => {
    // Pins the `.catch(...)` on `SplashScreen.hideAsync()` in the
    // shell's `handleUiReady` as load-bearing. The 10s fallback in
    // `prevent-splash-hide.ts` can race and hide the splash first;
    // when that happens, `hideAsync` here rejects with "already
    // hidden" and the catch is what keeps it from surfacing.
    mockSplashHideAsync.mockImplementationOnce(() =>
      Promise.reject(new Error('already hidden'))
    )

    const unhandled: Array<unknown> = []
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason)
    }
    // Jest runs Expo packages under Node — `unhandledRejection` on
    // `process` is the channel a `.catch`-less rejection would surface
    // on. If the shell's `.catch(...)` is ever removed, this listener
    // collects the rejection and the assertion below fails.
    process.on('unhandledRejection', onUnhandled)
    try {
      mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
      const onUiReady = mockNavigationOptions?.onUiReady
      if (onUiReady === undefined) throw new Error('onUiReady not threaded into navigation binding')

      await act(async () => {
        onUiReady()
        // Yield twice so the rejected promise's reaction runs and any
        // unhandledRejection event would have fired.
        await Promise.resolve()
        await Promise.resolve()
      })

      expect(mockSplashHideAsync).toHaveBeenCalledTimes(1)
      expect(unhandled).toEqual([])
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })

  it('seeds HostRequestedWebNavigation via the navigation binding initialMessages', () => {
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const bindings = expectBindings()
    const navIdx = indexOf(bindings, 'Navigation')
    expect(bindings.initialMessages[navIdx]).toEqual([
      { _tag: 'HostRequestedWebNavigation', path: '/apps' },
    ])
  })

  it('attaches an onTransportReady wrapper to the navigation binding', () => {
    // The base `useNavigationHostBinding` doesn't ship one — the shell
    // adds it so the captured transport sender can be plugged into
    // the navigation pipe.
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const bindings = expectBindings()
    const navIdx = indexOf(bindings, 'Navigation')
    expect(bindings.onTransportReady[navIdx]).toBeDefined()
  })

  it('registers the captured navigation sender into the pipe so descendants resolve it', async () => {
    // Wrap in a single-slot tuple so the closure assignment survives
    // TS's `let` widening across async boundaries — `senderBox.current`
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
        <AppShellWebView onRouteChanged={noopRouteChanged} />
        <SenderProbe />
      </>
    )

    const bindings = expectBindings()
    const navIdx = indexOf(bindings, 'Navigation')
    const navOnTransportReady = bindings.onTransportReady[navIdx]
    if (navOnTransportReady === undefined) throw new Error('navigation onTransportReady missing')

    const dispatched: Array<{ readonly _tag: string }> = []
    const fakeTransportSender = (msg: {
      readonly _tag: string
      readonly [k: string]: unknown
    }): EffectType.Effect<void> => EffectType.sync(() => dispatched.push(msg))

    // Fire the binding's `onTransportReady` — the navigation binding
    // writes the transport sender into the pipe's sender ref.
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
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const bindings = expectBindings()
    const allInitial = bindings.initialMessages.flat()
    expect(JSON.stringify(allInitial)).not.toContain('bearer-xyz')
  })

  it('threads the bearer token from the local-client-token row into the gatekeeper binding hook', () => {
    // Shell-level wiring contract: the shell reads `LocalClientToken`
    // and hands the bearer to `GatekeeperBridgeExpo.useHostBinding`.
    // What the binding *does* with the token (capture sender + send
    // via post-mount effect) is covered by `gatekeeper-expo`'s own
    // tests — the shell only owes it the value.
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    expect(mockGatekeeperOptions?.token).toBe('bearer-xyz')
  })

  it('passes undefined to the gatekeeper binding hook when no token is present in the store', () => {
    mockLocalClientTokenRow = { value: null }
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    expect(mockGatekeeperOptions?.token).toBeUndefined()
  })

  it('always wires an onTransportReady on the gatekeeper binding (the slice captures the sender regardless of token state)', () => {
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const bindings = expectBindings()
    const gkIdx = indexOf(bindings, 'Gatekeeper')
    expect(bindings.onTransportReady[gkIdx]).toBeDefined()
  })

  it('threads the wildflower store into the apps host binding', () => {
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    // `apps-expo`'s host binding receives the wildflower store directly
    // and internally constructs `TunnelStore.layerFrom(store)`; the shell
    // only owes it a stable store reference.
    expect(mockAppsOptions?.store).toBeDefined()
  })
})

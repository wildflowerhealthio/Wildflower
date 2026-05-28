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
    readonly receiverLayers: ReadonlyArray<unknown>
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
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    BridgedWebView: function MockBridgedWebView(
      props: NonNullable<typeof mockLastBridgedWebViewProps>
    ): ReactElement {
      mockLastBridgedWebViewProps = props
      return ReactInner.createElement('BridgedWebView', null, null)
    },
    useLogHostBinding: (): {
      readonly bridges: ReadonlyArray<{ readonly name: string }>
      readonly receiverLayers: ReadonlyArray<unknown>
      readonly initialMessages: ReadonlyArray<ReadonlyArray<unknown>>
      readonly onTransportReady: ReadonlyArray<undefined>
    } => ({
      bridges: [{ name: 'Log' }],
      receiverLayers: [effect.Layer.effectDiscard(effect.Effect.void)],
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
  readonly receiverLayers: ReadonlyArray<unknown>
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
  readonly receiverLayer: unknown
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
  onTransportReady?: (
    send: (msg: { readonly _tag: string }) => EffectType.Effect<void>
  ) => EffectType.Effect<void>
} | null = null
jest.mock('navigation-expo', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    NavigationBridgeExpo: {
      useHostBinding: (options: {
        initialRoute?: string
        onRouteChanged?: unknown
        onTransportReady?: (
          send: (msg: { readonly _tag: string }) => EffectType.Effect<void>
        ) => EffectType.Effect<void>
      }): MockBindings => {
        mockNavigationOptions = options
        return singleMock({
          bridge: { name: 'Navigation' },
          receiverLayer: effect.Layer.effectDiscard(effect.Effect.void),
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

jest.mock('gatekeeper-expo', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    GatekeeperBridgeExpo: {
      useHostBinding: (options: { token?: string } = {}): MockBindings =>
        singleMock({
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
    useCollectorHostBinding: (): MockBindings =>
      singleMock({
        bridge: { name: 'Collector' },
        receiverLayer: effect.Layer.effectDiscard(effect.Effect.void),
      }),
  }
})

let mockAppsOptions: { store?: unknown } | null = null
jest.mock('apps-expo', () => {
  const effect = jest.requireActual<{ Effect: typeof EffectType; Layer: typeof LayerType }>(
    'effect'
  )
  return {
    AppsBridgeExpo: {
      useHostBinding: (options: { store?: unknown }): MockBindings => {
        mockAppsOptions = options
        return singleMock({
          bridge: { name: 'Apps' },
          receiverLayer: effect.Layer.effectDiscard(effect.Effect.void),
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
import { NavigationPipeProvider, useNavigationSender } from './navigation-pipe.ts'

beforeEach(() => {
  mockLastBridgedWebViewProps = null
  mockNavigationOptions = null
  mockAppsOptions = null
  mockLocalClientTokenRow = { value: 'bearer-xyz' }
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
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const bindings = expectBindings()
    const allInitial = bindings.initialMessages.flat()
    expect(JSON.stringify(allInitial)).not.toContain('bearer-xyz')
  })

  it("issues AuthTokenIssued through the gatekeeper binding's onTransportReady when a token is provided", async () => {
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const bindings = expectBindings()
    const gkIdx = indexOf(bindings, 'Gatekeeper')
    const gkOnTransportReady = bindings.onTransportReady[gkIdx]
    if (gkOnTransportReady === undefined) throw new Error('gatekeeper onTransportReady missing')

    const sent: Array<{ readonly _tag: string }> = []
    await EffectType.runPromise(gkOnTransportReady((msg) => EffectType.sync(() => sent.push(msg))))
    expect(sent).toContainEqual({ _tag: 'AuthTokenIssued', token: 'bearer-xyz' })
  })

  it('omits the gatekeeper onTransportReady when no token is provided', () => {
    mockLocalClientTokenRow = { value: null }
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    const bindings = expectBindings()
    const gkIdx = indexOf(bindings, 'Gatekeeper')
    expect(bindings.onTransportReady[gkIdx]).toBeUndefined()
  })

  it('threads the wildflower store into the apps host binding', () => {
    mountInPipe(<AppShellWebView onRouteChanged={noopRouteChanged} />)
    // `apps-expo`'s host binding receives the wildflower store directly
    // and internally constructs `TunnelStore.layerFrom(store)`; the shell
    // only owes it a stable store reference.
    expect(mockAppsOptions?.store).toBeDefined()
  })
})

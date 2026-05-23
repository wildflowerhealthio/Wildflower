/**
 * Sniffer-control + no-op-pin tests for
 * {@link CollectorBridgeExpo.HostProvider} +
 * {@link CollectorBridgeExpo.useReceiverLayer}. Every test here either
 * drives the `snifferControlRef` registered by the live modal (`Click`,
 * `CancelSnifferRequest`) or pins the no-op contract for handlers that
 * exist only to keep the tag↔handler mapping honest (`Open`,
 * `SniffingComplete`).
 *
 * Sister file: `host-provider.test.tsx` covers the routing-side
 * handler (`RequestSniffableWebView`). Shared mocks +
 * handler-capture harness live in
 * `__test-support__/host-provider-test-mocks.ts`.
 */
import { act, render } from '@testing-library/react-native'
import { Effect } from 'effect'
import type { ReactElement } from 'react'

import {
  harness,
  mockBuildBrowserSnifferExpoFactory,
  mockBuildCollectorBridgeFactory,
  mockBuildCollectorReactFactory,
  mockBuildExpoRouterFactory,
  mockBuildExpoTundraishFactory,
  requireLastHandlers,
  resetHarness,
} from './__test-support__/host-provider-test-mocks.ts'

// babel-plugin-jest-hoist requires the factory to be an inline
// function literal; the imported `mockBuild*Factory` helpers are
// invoked from inside that literal so the shared harness module
// (see `__test-support__/host-provider-test-mocks.ts`) still owns
// the actual mock-construction logic.
jest.mock('browser-sniffer-expo', () => mockBuildBrowserSnifferExpoFactory())
jest.mock('expo-tundraish', () => mockBuildExpoTundraishFactory())
jest.mock('collector-react', () => mockBuildCollectorReactFactory())
jest.mock('expo-router', () => mockBuildExpoRouterFactory())
jest.mock('collector-fundamentals/bridge', () => mockBuildCollectorBridgeFactory())

import { CollectorBridgeExpo } from './index.ts'

const TestProbe = ({
  onReady,
}: {
  readonly onReady: (host: ReturnType<typeof CollectorBridgeExpo.useHost>) => void
}): ReactElement | null => {
  CollectorBridgeExpo.useReceiverLayer()
  const host = CollectorBridgeExpo.useHost()
  onReady(host)
  return null
}

beforeEach(() => {
  resetHarness()
})

describe('CollectorBridgeExpo handlers (sniffer-control forwarding)', () => {
  it('Click forwards to the registered snifferControlRef when a modal is mounted', () => {
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    const clicks: string[] = []
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()

    // Modal registers a sniffer-control surface on mount.
    act(() => {
      seenHosts[0].snifferControlRef.current = {
        click: (qs) => clicks.push(qs),
        cancelRequest: () => undefined,
      }
    })

    act(() => {
      Effect.runSync(handlers.Click({ querySelector: '#submit' }))
    })

    expect(clicks).toEqual(['#submit'])
  })

  it('Click drops silently when no modal is mounted (null ref)', () => {
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={() => undefined} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()

    // No registration — snifferControlRef.current stays null.
    expect(() => Effect.runSync(handlers.Click({ querySelector: '#submit' }))).not.toThrow()
  })

  it('CancelSnifferRequest forwards to the registered snifferControlRef', () => {
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    const cancels: string[] = []
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()

    act(() => {
      seenHosts[0].snifferControlRef.current = {
        click: () => undefined,
        cancelRequest: (id) => cancels.push(id),
      }
    })

    act(() => {
      Effect.runSync(handlers.CancelSnifferRequest({ id: 'req-1' }))
    })

    expect(cancels).toEqual(['req-1'])
  })
})

describe('CollectorBridgeExpo handlers (no-op pins)', () => {
  it('Open invokes the host context open() callback (currently a no-op) without pushing the router', () => {
    // The production `open` callback is a no-op
    // (`useCallback((_source) => undefined, [])`), so this test pins
    // the handler-to-tag mapping and the isolation contract: invoking
    // `Open` runs `open()` (currently a no-op, so no observable side
    // effect) and crucially does *not* push the modal route or update
    // `pendingSource` — those belong to `RequestSniffableWebView`.
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()
    expect(handlers.Open).toBeDefined()

    act(() => {
      Effect.runSync(handlers.Open({ source: { _tag: 'Uri', uri: 'https://example.com' } }))
    })
    // The router must NOT have been pushed — that's
    // `RequestSniffableWebView`'s job, not `Open`'s.
    expect(harness.routerPush).not.toHaveBeenCalled()
    // `pendingSource` must NOT have been advanced.
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toBeNull()
  })

  it('SniffingComplete invokes the host context sniffingComplete() callback without touching the router', () => {
    // Same shape as the `Open` test: pins the mapping + isolates
    // SniffingComplete from the router-pushing tag.
    const seenHosts: Array<ReturnType<typeof CollectorBridgeExpo.useHost>> = []
    render(
      <CollectorBridgeExpo.HostProvider>
        <TestProbe onReady={(h) => seenHosts.push(h)} />
      </CollectorBridgeExpo.HostProvider>
    )
    const handlers = requireLastHandlers()
    expect(handlers.SniffingComplete).toBeDefined()

    act(() => {
      Effect.runSync(handlers.SniffingComplete())
    })
    expect(harness.routerPush).not.toHaveBeenCalled()
    expect(harness.routerBack).not.toHaveBeenCalled()
    expect(seenHosts[seenHosts.length - 1]?.pendingSource).toBeNull()
  })
})

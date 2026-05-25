import { act, render } from '@testing-library/react'
import { Effect } from 'effect'
import type { NavigationBridge } from 'navigation-core'
import { type JSX, useEffect } from 'react'
import { MemoryRouter, type NavigateFunction, useNavigate } from 'react-router'
import { describe, expect, test } from 'vite-plus/test'
import { NavigationBridgeHandler, type RouteChangeSender } from './navigation-bridge-handler'

type RouteChanged = NavigationBridge['MessageSchemas']['RouteChanged']['Type']

const setupCalls = (): {
  readonly calls: RouteChanged[]
  readonly send: RouteChangeSender
} => {
  const calls: RouteChanged[] = []
  // Record on Effect *run*, not on construction. A push-on-call mock
  // would pass even when production code discards the returned Effect —
  // exactly the regression `NavigationBridgeHandler` had until Fix C.
  const send: RouteChangeSender = (message) =>
    Effect.sync(() => {
      calls.push(message)
    })
  return { calls, send }
}

describe('NavigationBridgeHandler', () => {
  test('fires the callback once per navigation, with canGoBack tracking history depth', () => {
    const { calls, send } = setupCalls()

    function PushOnMount({ to }: { readonly to: string }): JSX.Element | null {
      const navigate = useNavigate()
      useEffect(() => {
        void navigate(to)
      }, [navigate, to])
      return null
    }

    render(
      <MemoryRouter initialEntries={['/start']}>
        <NavigationBridgeHandler sender={send} />
        <PushOnMount to="/next" />
      </MemoryRouter>
    )

    // Initial Pop → canGoBack false; Push → canGoBack true.
    expect(calls[0]).toEqual({ _tag: 'RouteChanged', pathname: '/start', canGoBack: false })
    expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/next', canGoBack: true })
  })

  // Push/Pop sequences should land canGoBack at false on the initial route and
  // never permit a negative depth — the `Math.max(0, ...)` guard in
  // `useRouteChangeWatcher` is what holds the floor.
  test('repeated push-then-pop cycles return to canGoBack=false without going negative', () => {
    const { calls, send } = setupCalls()
    let captured: NavigateFunction | undefined

    function CaptureNavigate(): JSX.Element | null {
      captured = useNavigate()
      return null
    }

    render(
      <MemoryRouter initialEntries={['/']}>
        <NavigationBridgeHandler sender={send} />
        <CaptureNavigate />
      </MemoryRouter>
    )

    if (captured === undefined) throw new Error('useNavigate handle not captured')
    const navigate = captured

    // Initial mount: Pop on '/'.
    expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/', canGoBack: false })

    act(() => void navigate('/foo'))
    expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/foo', canGoBack: true })

    act(() => void navigate(-1))
    expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/', canGoBack: false })

    act(() => void navigate('/foo'))
    expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/foo', canGoBack: true })

    act(() => void navigate(-1))
    expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/', canGoBack: false })

    // Extra Pop past the initial entry: depth must clamp at 0, not go negative.
    act(() => void navigate(-1))
    const lastCall = calls.at(-1)
    expect(lastCall).toEqual({ _tag: 'RouteChanged', pathname: '/', canGoBack: false })
  })
})

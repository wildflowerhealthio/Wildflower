import { render } from '@testing-library/react'
import { Schema } from 'effect'
import { InteropNativeToWeb, InteropWebToNative, RouteChanged } from 'interop-core'
import { type JSX, useEffect } from 'react'
import { MemoryRouter, useNavigate } from 'react-router'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test'
import { makeWebMessageHandler } from '../src/message-handler.ts'
import { useRouteChangedSender } from '../src/use-route-changed-sender.ts'

type RouteChangedPayload = Schema.Schema.Type<typeof RouteChanged>
type WindowWithBridge = Window & { ReactNativeWebView?: { postMessage(data: string): void } }

describe('useRouteChangedSender', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let posts: string[]

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    posts = []
    ;(window as WindowWithBridge).ReactNativeWebView = {
      postMessage: (data) => {
        posts.push(data)
      },
    }
  })
  afterEach(() => {
    warnSpy.mockRestore()
    delete (window as WindowWithBridge).ReactNativeWebView
  })

  function RouteSender({
    handler,
  }: {
    readonly handler: ReturnType<
      typeof makeWebMessageHandler<typeof InteropNativeToWeb, typeof InteropWebToNative>
    >
  }): JSX.Element | null {
    useRouteChangedSender(handler)
    return null
  }

  test('sends one RouteChanged per navigation, with canGoBack tracking history depth', () => {
    const handler = makeWebMessageHandler({
      receive: InteropNativeToWeb,
      send: InteropWebToNative,
    })

    function PushOnMount({ to }: { readonly to: string }): JSX.Element | null {
      const navigate = useNavigate()
      useEffect(() => {
        void navigate(to)
      }, [navigate, to])
      return null
    }

    render(
      <MemoryRouter initialEntries={['/start']}>
        <RouteSender handler={handler} />
        <PushOnMount to="/next" />
      </MemoryRouter>
    )

    const decoded: ReadonlyArray<RouteChangedPayload> = posts.map((raw) =>
      Schema.decodeSync(RouteChanged)(raw)
    )
    // First Pop on mount (initialEntries) → canGoBack false; Push to /next → canGoBack true.
    expect(decoded[0]).toEqual({ _tag: 'RouteChanged', pathname: '/start', canGoBack: false })
    expect(decoded.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/next', canGoBack: true })

    handler.dispose()
  })
})

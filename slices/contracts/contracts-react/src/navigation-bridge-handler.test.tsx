import { render } from '@testing-library/react'
import { NavigationBridge } from 'contracts-core'
import { Effect } from 'effect'
import { type JSX, useEffect } from 'react'
import { MemoryRouter, useNavigate } from 'react-router'
import { describe, expect, test } from 'vite-plus/test'
import { NavigationBridgeHandler } from './navigation-bridge-handler'

describe('NavigationBridgeHandler', () => {
  test('fires the callback once per navigation, with canGoBack tracking history depth', () => {
    const calls: NavigationBridge['MessageSchemas']['RouteChanged']['Type'][] = []
    const send: typeof NavigationBridge.Web.send = (message) => {
      calls.push(message)
      return Effect.void
    }

    function RouteSender(): JSX.Element | null {
      return <NavigationBridgeHandler sender={send} />
    }

    function PushOnMount({ to }: { readonly to: string }): JSX.Element | null {
      const navigate = useNavigate()
      useEffect(() => {
        void navigate(to)
      }, [navigate, to])
      return null
    }

    render(
      <MemoryRouter initialEntries={['/start']}>
        <RouteSender />
        <PushOnMount to="/next" />
      </MemoryRouter>
    )

    // Initial Pop → canGoBack false; Push → canGoBack true.
    expect(calls[0]).toEqual({ _tag: 'RouteChanged', pathname: '/start', canGoBack: false })
    expect(calls.at(-1)).toEqual({ _tag: 'RouteChanged', pathname: '/next', canGoBack: true })
  })
})

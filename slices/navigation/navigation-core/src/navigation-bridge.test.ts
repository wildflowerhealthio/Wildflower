import { Schema } from 'effect'
import { Message } from 'effect-messaging-core'
import { describe, expect, test } from 'vite-plus/test'
import { NavigationBridge } from './navigation-bridge.ts'

describe('NavigationBridge', () => {
  test('Host→Web encodes a HostRequestedWebNavigation the Web side decodes', () => {
    const encoded = Message.stringifyMessage(NavigationBridge.HostToWeb, {
      _tag: 'HostRequestedWebNavigation',
      path: '/foo',
    })
    const decoded = Schema.decodeSync(NavigationBridge.HostToWeb.HostRequestedWebNavigation)(
      encoded
    )
    expect(decoded).toEqual({ _tag: 'HostRequestedWebNavigation', path: '/foo' })
  })

  test('Host→Web encodes a SafeAreaInsetsChanged the Web side decodes', () => {
    const encoded = Message.stringifyMessage(NavigationBridge.HostToWeb, {
      _tag: 'SafeAreaInsetsChanged',
      top: 47,
      bottom: 0,
      left: 0,
      right: 12,
    })
    const decoded = Schema.decodeSync(NavigationBridge.HostToWeb.SafeAreaInsetsChanged)(encoded)
    expect(decoded).toEqual({
      _tag: 'SafeAreaInsetsChanged',
      top: 47,
      bottom: 0,
      left: 0,
      right: 12,
    })
  })

  test('Web→Host encodes a RouteChanged the Host side decodes', () => {
    const encoded = Message.stringifyMessage(NavigationBridge.WebToHost, {
      _tag: 'RouteChanged',
      pathname: '/x',
      canGoBack: true,
    })
    const decoded = Schema.decodeSync(NavigationBridge.WebToHost.RouteChanged)(encoded)
    expect(decoded).toEqual({ _tag: 'RouteChanged', pathname: '/x', canGoBack: true })
  })
})

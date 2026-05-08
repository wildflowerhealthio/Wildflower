import { Either, Schema } from 'effect'
import { describe, expect, test } from 'vite-plus/test'
import {
  AppNavigationRequested,
  InteropNativeToWeb,
  InteropWebToNative,
  NativeBackRequested,
  RouteChanged,
} from '../src/message-schemas.ts'

describe('NativeBackRequested', () => {
  test('round-trips through encode/decode', () => {
    const encoded = Schema.encodeSync(NativeBackRequested)({ _tag: 'NativeBackRequested' })
    expect(typeof encoded).toBe('string')
    const decoded = Schema.decodeSync(NativeBackRequested)(encoded)
    expect(decoded).toEqual({ _tag: 'NativeBackRequested' })
  })

  test('rejects malformed JSON', () => {
    expect(Either.isLeft(Schema.decodeUnknownEither(NativeBackRequested)('not-json'))).toBe(true)
  })

  test('rejects a different _tag', () => {
    const wrong = JSON.stringify({ _tag: 'SomethingElse' })
    expect(Either.isLeft(Schema.decodeUnknownEither(NativeBackRequested)(wrong))).toBe(true)
  })
})

describe('AppNavigationRequested', () => {
  test('round-trips with a path', () => {
    const encoded = Schema.encodeSync(AppNavigationRequested)({
      _tag: 'AppNavigationRequested',
      path: '/gatekeeper/oauth-consent/abc',
    })
    const decoded = Schema.decodeSync(AppNavigationRequested)(encoded)
    expect(decoded.path).toBe('/gatekeeper/oauth-consent/abc')
  })

  test('rejects when path is missing', () => {
    const wrong = JSON.stringify({ _tag: 'AppNavigationRequested' })
    expect(Either.isLeft(Schema.decodeUnknownEither(AppNavigationRequested)(wrong))).toBe(true)
  })
})

describe('RouteChanged', () => {
  test('round-trips with pathname + canGoBack', () => {
    const encoded = Schema.encodeSync(RouteChanged)({
      _tag: 'RouteChanged',
      pathname: '/x',
      canGoBack: true,
    })
    const decoded = Schema.decodeSync(RouteChanged)(encoded)
    expect(decoded).toEqual({ _tag: 'RouteChanged', pathname: '/x', canGoBack: true })
  })

  test('rejects when canGoBack is the wrong type', () => {
    const wrong = JSON.stringify({ _tag: 'RouteChanged', pathname: '/x', canGoBack: 'yes' })
    expect(Either.isLeft(Schema.decodeUnknownEither(RouteChanged)(wrong))).toBe(true)
  })
})

describe('Interop direction records', () => {
  test('InteropNativeToWeb has the host-driven tags', () => {
    expect(Object.keys(InteropNativeToWeb).toSorted()).toEqual([
      'AppNavigationRequested',
      'NativeBackRequested',
    ])
  })

  test('InteropWebToNative has the page-driven tags', () => {
    expect(Object.keys(InteropWebToNative).toSorted()).toEqual(['RouteChanged'])
  })

  test('records and standalone schema exports reference the same instances', () => {
    expect(InteropNativeToWeb.NativeBackRequested).toBe(NativeBackRequested)
    expect(InteropNativeToWeb.AppNavigationRequested).toBe(AppNavigationRequested)
    expect(InteropWebToNative.RouteChanged).toBe(RouteChanged)
  })
})

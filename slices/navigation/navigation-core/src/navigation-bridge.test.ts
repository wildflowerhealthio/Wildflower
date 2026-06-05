import { Effect, Exit, Schema } from 'effect'
import { Message } from 'effect-messaging-core'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, test } from 'vite-plus/test'
import { NavigationBridge } from './navigation-bridge.ts'

describe('NavigationBridge', () => {
  test('Host→Web encodes a HostRequestedWebNavigation the Web side decodes', () => {
    const encoded = Effect.runSync(
      Message.stringifyMessage(NavigationBridge.HostToWeb, {
        _tag: 'HostRequestedWebNavigation',
        path: '/foo',
      })
    )
    const decoded = Schema.decodeSync(NavigationBridge.HostToWeb.HostRequestedWebNavigation)(
      encoded
    )
    expect(decoded).toEqual({ _tag: 'HostRequestedWebNavigation', path: '/foo' })
  })

  test('Host→Web encodes a SafeAreaInsetsChanged the Web side decodes', () => {
    const encoded = Effect.runSync(
      Message.stringifyMessage(NavigationBridge.HostToWeb, {
        _tag: 'SafeAreaInsetsChanged',
        top: 47,
        bottom: 0,
        left: 0,
        right: 12,
      })
    )
    const decoded = Schema.decodeSync(NavigationBridge.HostToWeb.SafeAreaInsetsChanged)(encoded)
    expect(decoded).toEqual({
      _tag: 'SafeAreaInsetsChanged',
      top: 47,
      bottom: 0,
      left: 0,
      right: 12,
    })
  })

  test('Host→Web decode rejects a negative inset', () => {
    // `nonNegative` is the physical "insets are never negative" invariant;
    // a crafted wire string carrying a negative must fail at the boundary.
    const wire = JSON.stringify({
      _tag: 'SafeAreaInsetsChanged',
      top: -1,
      bottom: 0,
      left: 0,
      right: 0,
    })
    expect(() =>
      Schema.decodeSync(NavigationBridge.HostToWeb.SafeAreaInsetsChanged)(wire)
    ).toThrow()
  })

  test('Host→Web encode rejects NaN and Infinity insets', () => {
    // `JsonNumber` refuses the values `JSON.stringify` can't round-trip, so
    // encoding fails (a recoverable `ParseError`) rather than putting `null`
    // on the wire. The outbound pump turns this failure into a drop-and-log.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      const exit = Effect.runSyncExit(
        Message.stringifyMessage(NavigationBridge.HostToWeb, {
          _tag: 'SafeAreaInsetsChanged',
          top: bad,
          bottom: 0,
          left: 0,
          right: 0,
        })
      )
      expect(Exit.isFailure(exit)).toBe(true)
    }
  })

  test('property: any non-negative finite insets round-trip Host→Web', () => {
    // `-0` is excluded: `JSON.stringify(-0)` is `"0"`, so it decodes back to
    // `0` and breaks the identity round-trip (it is otherwise schema-valid).
    const nonNegFinite = fc
      .double({ min: 0, max: 100_000, noNaN: true, noDefaultInfinity: true })
      .filter((n) => !Object.is(n, -0))
    fc.assert(
      fc.property(
        nonNegFinite,
        nonNegFinite,
        nonNegFinite,
        nonNegFinite,
        (top, bottom, left, right) => {
          const message = { _tag: 'SafeAreaInsetsChanged' as const, top, bottom, left, right }
          const wire = Effect.runSync(Message.stringifyMessage(NavigationBridge.HostToWeb, message))
          const decoded = Schema.decodeSync(NavigationBridge.HostToWeb.SafeAreaInsetsChanged)(wire)
          expect(decoded).toEqual(message)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test.each(['light', 'dark'] as const)('colour scheme %s round-trips Host→Web', (scheme) => {
    const message = { _tag: 'HostColorSchemeChanged' as const, scheme }
    const wire = Effect.runSync(Message.stringifyMessage(NavigationBridge.HostToWeb, message))
    const decoded = Schema.decodeSync(NavigationBridge.HostToWeb.HostColorSchemeChanged)(wire)
    expect(decoded).toEqual(message)
  })

  test('Host→Web decode rejects an unknown colour scheme', () => {
    // The literal union is the contract; an out-of-band string (e.g. the
    // platform's `unspecified`) must fail at the boundary, never silently
    // pass through to the DOM writer.
    const wire = JSON.stringify({ _tag: 'HostColorSchemeChanged', scheme: 'unspecified' })
    expect(() =>
      Schema.decodeSync(NavigationBridge.HostToWeb.HostColorSchemeChanged)(wire)
    ).toThrow()
  })

  test('Web→Host encodes a RouteChanged the Host side decodes', () => {
    const encoded = Effect.runSync(
      Message.stringifyMessage(NavigationBridge.WebToHost, {
        _tag: 'RouteChanged',
        pathname: '/x',
        canGoBack: true,
      })
    )
    const decoded = Schema.decodeSync(NavigationBridge.WebToHost.RouteChanged)(encoded)
    expect(decoded).toEqual({ _tag: 'RouteChanged', pathname: '/x', canGoBack: true })
  })
})

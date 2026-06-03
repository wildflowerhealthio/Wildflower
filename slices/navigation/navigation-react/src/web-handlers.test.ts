import { Effect } from 'effect'
import * as TestPlatformAdapterLayer from 'effect-messaging-core/test'
import { describe, expect, test } from 'vite-plus/test'
import { makeNavigationWebHandlers, type SafeAreaInsets } from './web-handlers.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

const noopApplyInsets = (_insets: SafeAreaInsets): void => {}

describe('makeNavigationWebHandlers', () => {
  test('HostBackRequested handler calls navigate(-1)', () => {
    const calls: Array<-1 | string> = []
    const handlers = makeNavigationWebHandlers((to) => calls.push(to), noopApplyInsets)
    Effect.runSync(
      handlers.HostBackRequested({ _tag: 'HostBackRequested' }).pipe(Effect.provide(adapterLayer))
    )
    expect(calls).toEqual([-1])
  })

  test('HostRequestedWebNavigation handler calls navigate(path)', () => {
    const calls: Array<-1 | string> = []
    const handlers = makeNavigationWebHandlers((to) => calls.push(to), noopApplyInsets)
    Effect.runSync(
      handlers
        .HostRequestedWebNavigation({ _tag: 'HostRequestedWebNavigation', path: '/visits/123' })
        .pipe(Effect.provide(adapterLayer))
    )
    expect(calls).toEqual(['/visits/123'])
  })

  test('handlers route to the navigate function captured at build time', () => {
    const callsA: Array<-1 | string> = []
    const callsB: Array<-1 | string> = []
    const handlersA = makeNavigationWebHandlers((to) => callsA.push(to), noopApplyInsets)
    const handlersB = makeNavigationWebHandlers((to) => callsB.push(to), noopApplyInsets)
    Effect.runSync(
      handlersA.HostBackRequested({ _tag: 'HostBackRequested' }).pipe(Effect.provide(adapterLayer))
    )
    Effect.runSync(
      handlersB
        .HostRequestedWebNavigation({ _tag: 'HostRequestedWebNavigation', path: '/x' })
        .pipe(Effect.provide(adapterLayer))
    )
    expect(callsA).toEqual([-1])
    expect(callsB).toEqual(['/x'])
  })

  test('SafeAreaInsetsChanged handler forwards the insets to applyInsets', () => {
    const applied: Array<SafeAreaInsets> = []
    const handlers = makeNavigationWebHandlers(
      () => undefined,
      (insets) => applied.push(insets)
    )
    Effect.runSync(
      handlers
        .SafeAreaInsetsChanged({ _tag: 'SafeAreaInsetsChanged', top: 47, bottom: 0, left: 0, right: 12 })
        .pipe(Effect.provide(adapterLayer))
    )
    expect(applied).toEqual([{ top: 47, bottom: 0, left: 0, right: 12 }])
  })
})

import { Effect } from 'effect'
import { TestPlatformAdapterLayer } from 'effect-messaging-core'
import { describe, expect, test } from 'vite-plus/test'
import { makeNavigationWebHandlers } from './web-handlers.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

describe('makeNavigationWebHandlers', () => {
  test('HostBackRequested handler calls navigate(-1)', () => {
    const calls: Array<-1 | string> = []
    const handlers = makeNavigationWebHandlers((to) => calls.push(to))
    Effect.runSync(
      handlers.HostBackRequested({ _tag: 'HostBackRequested' }).pipe(Effect.provide(adapterLayer))
    )
    expect(calls).toEqual([-1])
  })

  test('HostRequestedWebNavigation handler calls navigate(path)', () => {
    const calls: Array<-1 | string> = []
    const handlers = makeNavigationWebHandlers((to) => calls.push(to))
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
    const handlersA = makeNavigationWebHandlers((to) => callsA.push(to))
    const handlersB = makeNavigationWebHandlers((to) => callsB.push(to))
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
})

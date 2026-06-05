import { Effect } from 'effect'
import * as TestPlatformAdapterLayer from 'effect-messaging-core/test'
import { describe, expect, test } from 'vite-plus/test'
import { makeNavigationWebHandlers, type ColorScheme, type SafeAreaInsets } from './web-handlers.ts'

const { layer: adapterLayer } = TestPlatformAdapterLayer.make()

const noopApplyInsets = (_insets: SafeAreaInsets): void => {}
const noopApplyColorScheme = (_scheme: ColorScheme): void => {}
const noopApplyApiOrigin = (_apiOrigin: string): void => {}

describe('makeNavigationWebHandlers', () => {
  test('HostBackRequested handler calls navigate(-1)', () => {
    const calls: Array<-1 | string> = []
    const handlers = makeNavigationWebHandlers({
      navigate: (to) => calls.push(to),
      applyInsets: noopApplyInsets,
      applyColorScheme: noopApplyColorScheme,
      applyApiOrigin: noopApplyApiOrigin,
    })
    Effect.runSync(
      handlers.HostBackRequested({ _tag: 'HostBackRequested' }).pipe(Effect.provide(adapterLayer))
    )
    expect(calls).toEqual([-1])
  })

  test('HostRequestedWebNavigation handler calls navigate(path)', () => {
    const calls: Array<-1 | string> = []
    const handlers = makeNavigationWebHandlers({
      navigate: (to) => calls.push(to),
      applyInsets: noopApplyInsets,
      applyColorScheme: noopApplyColorScheme,
      applyApiOrigin: noopApplyApiOrigin,
    })
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
    const handlersA = makeNavigationWebHandlers({
      navigate: (to) => callsA.push(to),
      applyInsets: noopApplyInsets,
      applyColorScheme: noopApplyColorScheme,
      applyApiOrigin: noopApplyApiOrigin,
    })
    const handlersB = makeNavigationWebHandlers({
      navigate: (to) => callsB.push(to),
      applyInsets: noopApplyInsets,
      applyColorScheme: noopApplyColorScheme,
      applyApiOrigin: noopApplyApiOrigin,
    })
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
    const handlers = makeNavigationWebHandlers({
      navigate: () => undefined,
      applyInsets: (insets) => applied.push(insets),
      applyColorScheme: noopApplyColorScheme,
      applyApiOrigin: noopApplyApiOrigin,
    })
    Effect.runSync(
      handlers
        .SafeAreaInsetsChanged({
          _tag: 'SafeAreaInsetsChanged',
          top: 47,
          bottom: 0,
          left: 0,
          right: 12,
        })
        .pipe(Effect.provide(adapterLayer))
    )
    expect(applied).toEqual([{ top: 47, bottom: 0, left: 0, right: 12 }])
  })

  test('HostColorSchemeChanged handler forwards the scheme to applyColorScheme', () => {
    const applied: Array<ColorScheme> = []
    const handlers = makeNavigationWebHandlers({
      navigate: () => undefined,
      applyInsets: noopApplyInsets,
      applyColorScheme: (scheme) => applied.push(scheme),
      applyApiOrigin: noopApplyApiOrigin,
    })
    Effect.runSync(
      handlers
        .HostColorSchemeChanged({ _tag: 'HostColorSchemeChanged', scheme: 'dark' })
        .pipe(Effect.provide(adapterLayer))
    )
    expect(applied).toEqual(['dark'])
  })

  test('HostApiOriginChanged handler forwards the origin to applyApiOrigin', () => {
    const applied: Array<string> = []
    const handlers = makeNavigationWebHandlers({
      navigate: () => undefined,
      applyInsets: noopApplyInsets,
      applyColorScheme: noopApplyColorScheme,
      applyApiOrigin: (apiOrigin) => applied.push(apiOrigin),
    })
    Effect.runSync(
      handlers
        .HostApiOriginChanged({ _tag: 'HostApiOriginChanged', apiOrigin: 'http://127.0.0.1:8080' })
        .pipe(Effect.provide(adapterLayer))
    )
    expect(applied).toEqual(['http://127.0.0.1:8080'])
  })
})

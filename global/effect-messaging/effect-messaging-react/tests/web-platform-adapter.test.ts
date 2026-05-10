import { Effect, Exit, Scope } from 'effect'
import { UrlCodec } from 'effect-messaging-core'
import { LoggingLayerTest } from 'kitchen-sink/test'
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test'
import * as WebPlatformAdapter from '../src/web-platform-adapter.ts'

type WindowWithBridge = Window & {
  ReactNativeWebView?: { postMessage(data: string): void }
}

const requireAttachLive = (
  adapter: ReturnType<typeof WebPlatformAdapter.make>
): NonNullable<typeof adapter.attachLive> => {
  if (adapter.attachLive === undefined) throw new Error('attachLive missing')
  return adapter.attachLive
}

const setMsgParams = (entries: ReadonlyArray<readonly [tag: string, raw: string]>): void => {
  const url = new URL(window.location.href)
  for (const [, raw] of entries) {
    for (const [k, v] of UrlCodec.encodeMessagesAsParams([raw])) {
      url.searchParams.append(k, v)
    }
  }
  window.history.replaceState({}, '', url.toString())
}

const clearUrlSearch = (): void => {
  const url = new URL(window.location.href)
  url.search = ''
  window.history.replaceState({}, '', url.toString())
}

beforeEach(() => {
  clearUrlSearch()
  delete (window as WindowWithBridge).ReactNativeWebView
})

afterEach(() => {
  clearUrlSearch()
  delete (window as WindowWithBridge).ReactNativeWebView
})

describe('WebPlatformAdapter.make — drainInitial', () => {
  test('decodes msg.* params and strips them from the URL', () => {
    const a = JSON.stringify({ _tag: 'A' })
    const b = JSON.stringify({ _tag: 'B', x: 1 })
    setMsgParams([
      ['A', a],
      ['B', b],
    ])
    expect(window.location.search).toContain('msg.A')

    const adapter = WebPlatformAdapter.make()
    const drained = Effect.runSync(adapter.drainInitial)
    expect(drained).toEqual([a, b])
    expect(window.location.search).not.toContain('msg.')
  })

  test('returns [] and leaves the URL untouched when no msg.* params are present', () => {
    const url = new URL(window.location.href)
    url.search = '?keep=me'
    window.history.replaceState({}, '', url.toString())

    const adapter = WebPlatformAdapter.make()
    expect(Effect.runSync(adapter.drainInitial)).toEqual([])
    expect(window.location.search).toBe('?keep=me')
  })

  test('preserves non-msg params when stripping', () => {
    const url = new URL(window.location.href)
    url.search = ''
    url.searchParams.append('keep', 'me')
    window.history.replaceState({}, '', url.toString())
    setMsgParams([['Hello', JSON.stringify({ _tag: 'Hello' })]])
    const adapter = WebPlatformAdapter.make()
    Effect.runSync(adapter.drainInitial)
    expect(new URL(window.location.href).searchParams.get('keep')).toBe('me')
    expect(window.location.search).not.toContain('msg.')
  })
})

describe('WebPlatformAdapter.make — bareSender', () => {
  test('warns and drops when ReactNativeWebView is absent', async () => {
    const adapter = WebPlatformAdapter.make()
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* adapter.bareSender('payload')
      }).pipe(
        LoggingLayerTest.expectToLog((logs) => {
          expect(logs).toEqual([
            {
              level: 'WARN',
              message:
                '[effect-messaging] sendMessage: no ReactNativeWebView in window; running standalone? message dropped.',
            },
          ])
        }),
        Effect.scoped
      )
    )
  })

  test('forwards to ReactNativeWebView.postMessage when present', () => {
    const sent: string[] = []
    ;(window as WindowWithBridge).ReactNativeWebView = {
      postMessage: (data) => sent.push(data),
    }
    const adapter = WebPlatformAdapter.make()
    Effect.runSync(adapter.bareSender('payload-1'))
    Effect.runSync(adapter.bareSender('payload-2'))
    expect(sent).toEqual(['payload-1', 'payload-2'])
  })
})

describe('WebPlatformAdapter.make — attachLive', () => {
  test('detaches the window listener on scope close', async () => {
    const adapter = WebPlatformAdapter.make()
    const attachLive = requireAttachLive(adapter)
    const seen: string[] = []
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.extend(
        attachLive((raw) => seen.push(raw)),
        scope
      )
    )

    window.dispatchEvent(
      new MessageEvent('message', { data: 'live', origin: window.location.origin, source: window })
    )
    expect(seen).toEqual(['live'])

    await Effect.runPromise(Scope.close(scope, Exit.void))
    window.dispatchEvent(
      new MessageEvent('message', { data: 'after', origin: window.location.origin, source: window })
    )
    expect(seen).toEqual(['live'])
  })

  test('ignores non-string event data', async () => {
    const adapter = WebPlatformAdapter.make()
    const attachLive = requireAttachLive(adapter)
    const seen: string[] = []
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.extend(
        attachLive((raw) => seen.push(raw)),
        scope
      )
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        data: { not: 'a string' },
        origin: window.location.origin,
        source: window,
      })
    )
    expect(seen).toEqual([])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })

  test('ignores foreign-origin events', async () => {
    const adapter = WebPlatformAdapter.make()
    const attachLive = requireAttachLive(adapter)
    const seen: string[] = []
    const scope = Effect.runSync(Scope.make())
    await Effect.runPromise(
      Scope.extend(
        attachLive((raw) => seen.push(raw)),
        scope
      )
    )
    window.dispatchEvent(
      new MessageEvent('message', {
        data: 'foreign',
        origin: 'https://attacker.example',
        source: window,
      })
    )
    expect(seen).toEqual([])
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

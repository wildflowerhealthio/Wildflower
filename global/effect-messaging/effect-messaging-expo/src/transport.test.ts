import { Effect, Exit, Schema, Scope } from 'effect'
import { Bridge } from 'effect-messaging-core'
import { makeExpoTransport, type WebViewHandle } from './transport.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))

const HostBridge = Bridge.make({
  name: 'HostFix',
  hostToWeb: [['Ping', Ping]] as const,
  webToHost: [['Pong', Pong]] as const,
})

const fromBase64Url = (s: string): string => {
  const swapped = s.replaceAll('-', '+').replaceAll('_', '/')
  const padded = swapped + '='.repeat((4 - (swapped.length % 4)) % 4)
  return atob(padded)
}

const runScoped = async <A>(eff: Effect.Effect<A, never, Scope.Scope>): Promise<A> => {
  const scope = Effect.runSync(Scope.make())
  try {
    return await Effect.runPromise(Scope.extend(eff, scope))
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

describe('makeExpoTransport — embedUrl', () => {
  it('appends each initial message as a msg.<Tag> base64 query param', async () => {
    const ref: { current: WebViewHandle | null } = { current: null }
    const layer = HostBridge.Host.ReceiverLayer({ Pong: () => Effect.void })
    const transport = await runScoped(
      makeExpoTransport({
        bridges: [HostBridge] as const,
        layers: [layer] as const,
        initialMessages: [{ _tag: 'Ping', value: 7 }],
        baseUrl: 'https://app.local/',
        webviewHandleRef: ref,
      })
    )
    const url = new URL(transport.embedUrl)
    expect(url.origin + url.pathname).toBe('https://app.local/')
    const pingParam = url.searchParams.get('msg.Ping')
    if (pingParam === null) throw new Error('expected msg.Ping param')
    const decoded: unknown = JSON.parse(fromBase64Url(pingParam))
    expect(decoded).toEqual({ _tag: 'Ping', value: 7 })
  })

  it('returns the unmodified base URL when no initial messages are supplied', async () => {
    const ref: { current: WebViewHandle | null } = { current: null }
    const layer = HostBridge.Host.ReceiverLayer({ Pong: () => Effect.void })
    const transport = await runScoped(
      makeExpoTransport({
        bridges: [HostBridge] as const,
        layers: [layer] as const,
        initialMessages: [],
        baseUrl: 'https://app.local/?keep=me',
        webviewHandleRef: ref,
      })
    )
    const url = new URL(transport.embedUrl)
    expect(url.searchParams.get('keep')).toBe('me')
    expect([...url.searchParams.keys()].some((k) => k.startsWith('msg.'))).toBe(false)
  })
})

describe('makeExpoTransport — bareSender (with __Ready handshake)', () => {
  it('warns and drops when the WebView ref is null', async () => {
    const ref: { current: WebViewHandle | null } = { current: null }
    const layer = HostBridge.Host.ReceiverLayer({ Pong: () => Effect.void })
    const warnings: string[] = []
    const originalLog = console.warn
    console.warn = (msg: unknown): void => {
      warnings.push(String(msg))
    }
    try {
      const scope = Effect.runSync(Scope.make())
      const transport = await Effect.runPromise(
        Scope.extend(
          makeExpoTransport({
            bridges: [HostBridge] as const,
            layers: [layer] as const,
            initialMessages: [],
            baseUrl: 'https://app.local/',
            webviewHandleRef: ref,
          }),
          scope
        )
      )
      // Simulate the page-side handshake.
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      transport.onMessage({ nativeEvent: { data: '{"_tag":"__Ready"}' } } as never)
      await Effect.runPromise(transport.sendMessage({ _tag: 'Ping', value: 1 }))
      await Effect.runPromise(Scope.close(scope, Exit.void))
    } finally {
      console.warn = originalLog
    }
  })

  it('forwards encoded payloads to the ref-supplied handle once Ready arrives', async () => {
    const calls: string[] = []
    const ref: { current: WebViewHandle | null } = {
      current: { postMessage: (data) => calls.push(data) },
    }
    const layer = HostBridge.Host.ReceiverLayer({ Pong: () => Effect.void })
    const scope = Effect.runSync(Scope.make())
    const transport = await Effect.runPromise(
      Scope.extend(
        makeExpoTransport({
          bridges: [HostBridge] as const,
          layers: [layer] as const,
          initialMessages: [],
          baseUrl: 'https://app.local/',
          webviewHandleRef: ref,
        }),
        scope
      )
    )
    // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
    transport.onMessage({ nativeEvent: { data: '{"_tag":"__Ready"}' } } as never)
    await Effect.runPromise(transport.sendMessage({ _tag: 'Ping', value: 42 }))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0] ?? '')).toEqual({ _tag: 'Ping', value: 42 })
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

describe('makeExpoTransport — onMessage', () => {
  it('routes inbound payloads through the dispatch fiber to the handler', async () => {
    const ref: { current: WebViewHandle | null } = { current: null }
    const seen: string[] = []
    const layer = HostBridge.Host.ReceiverLayer({
      Pong: ({ reply }) => Effect.sync(() => seen.push(reply)),
    })
    await runScoped(
      Effect.gen(function* () {
        const t = yield* makeExpoTransport({
          bridges: [HostBridge] as const,
          layers: [layer] as const,
          initialMessages: [],
          baseUrl: 'https://app.local/',
          webviewHandleRef: ref,
        })
        const encoded = Schema.encodeSync(Pong)({ _tag: 'Pong', reply: 'hi' })
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        t.onMessage({ nativeEvent: { data: encoded } } as never)
        // Tick once so the dispatch fiber processes the queued message.
        yield* Effect.sleep(0)
        return t
      })
    )
    expect(seen).toEqual(['hi'])
  })
})

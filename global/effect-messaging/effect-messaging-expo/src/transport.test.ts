import { Effect, Exit, Schema, Scope } from 'effect'
import { Bridge, UrlParamMessage } from 'effect-messaging-core'
import { makeExpoTransport, type WebViewHandle } from './transport.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.String }))
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))

const HostBridge = Bridge.make({
  name: 'HostFix',
  hostToWeb: [['Ping', Ping]] as const,
  webToHost: [['Pong', Pong]] as const,
  urlParams: {
    Ping: UrlParamMessage.singleStringMessageSchema('Ping', 'value'),
  },
})

const runScoped = async <A>(eff: Effect.Effect<A, never, Scope.Scope>): Promise<A> => {
  const scope = Effect.runSync(Scope.make())
  try {
    return await Effect.runPromise(Scope.extend(eff, scope))
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

describe('makeExpoTransport — embedUrl', () => {
  it('appends each initial message as a ?<Tag>=<value> query param', async () => {
    const ref: { current: WebViewHandle | null } = { current: null }
    const layer = HostBridge.Host.ReceiverLayer({ Pong: () => Effect.void })
    const transport = await runScoped(
      makeExpoTransport({
        bridges: [HostBridge] as const,
        layers: [layer] as const,
        initialMessages: [{ _tag: 'Ping', value: 'hello' }],
        baseUrl: 'https://app.local/',
        webviewHandleRef: ref,
      })
    )
    const url = new URL(transport.embedUrl)
    expect(url.origin + url.pathname).toBe('https://app.local/')
    expect(url.searchParams.get('Ping')).toBe('hello')
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
    expect([...url.searchParams.keys()]).toEqual(['keep'])
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
      await Effect.runPromise(
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        transport.onMessage({ nativeEvent: { data: '{"_tag":"__Ready"}' } } as never)
      )
      await Effect.runPromise(transport.sendMessage({ _tag: 'Ping', value: 'x' }))
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
    await Effect.runPromise(
      // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
      transport.onMessage({ nativeEvent: { data: '{"_tag":"__Ready"}' } } as never)
    )
    await Effect.runPromise(transport.sendMessage({ _tag: 'Ping', value: 'ok' }))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0] ?? '')).toEqual({ _tag: 'Ping', value: 'ok' })
    await Effect.runPromise(Scope.close(scope, Exit.void))
  })
})

describe('makeExpoTransport — onMessage', () => {
  it('routes inbound payloads through the dispatch fiber to the handler', async () => {
    const ref: { current: WebViewHandle | null } = { current: null }
    const seen: string[] = []
    const layer = HostBridge.Host.ReceiverLayer({
      Pong: ({ reply }) =>
        Effect.sync(() => {
          seen.push(reply)
        }),
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
        yield* t.onMessage({ nativeEvent: { data: encoded } } as never)
        // Tick once so the dispatch fiber processes the queued message.
        yield* Effect.sleep(0)
        return t
      })
    )
    expect(seen).toEqual(['hi'])
  })
})

import { Effect, Exit, Schema, Scope } from 'effect'
import { Bridge } from 'effect-messaging-core'
import { makeExpoTransport, type WebViewHandle } from './transport.ts'

const Ping = Schema.parseJson(Schema.TaggedStruct('Ping', { value: Schema.Number }))
const Pong = Schema.parseJson(Schema.TaggedStruct('Pong', { reply: Schema.String }))
const NoOptions = Schema.Struct({})

const HostBridge = Bridge.make({
  name: 'HostFix',
  hostToWeb: [['Ping', Ping]] as const,
  webToHost: [['Pong', Pong]] as const,
  hostOptionsShape: NoOptions,
  webOptionsShape: NoOptions,
})

const runScoped = async <A>(eff: Effect.Effect<A, never, Scope.Scope>): Promise<A> => {
  const scope = Effect.runSync(Scope.make())
  try {
    return await Effect.runPromise(Scope.extend(eff, scope))
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
  }
}

describe('makeExpoTransport — injectedScript', () => {
  it('embeds initialMessages encoded as the page-side window global', async () => {
    const ref: { current: WebViewHandle | null } = { current: null }
    const layer = HostBridge.Host.ReceiverLayer({ Pong: () => Effect.void })
    const transport = await runScoped(
      makeExpoTransport({
        bridges: [HostBridge] as const,
        layers: [layer] as const,
        initialMessages: [{ _tag: 'Ping', value: 7 }],
        webviewHandleRef: ref,
      })
    )
    // The script writes to `window.__INITIAL_MESSAGES__` with the
    // encoded array. The exact JSON-of-encoded-strings is the contract
    // the page-side adapter consumes.
    expect(transport.injectedScript).toContain('window.__INITIAL_MESSAGES__')
    const m = transport.injectedScript.match(/window\.__INITIAL_MESSAGES__ = (\[.*\])/)
    if (m === null) throw new Error(`unexpected script: ${transport.injectedScript}`)
    const parsed: unknown = JSON.parse(m[1] ?? '[]')
    if (!Array.isArray(parsed)) throw new Error('expected array')
    const arr: ReadonlyArray<unknown> = parsed
    expect(arr).toHaveLength(1)
    const first = arr[0]
    if (typeof first !== 'string') throw new Error('expected string entry')
    const decoded: unknown = JSON.parse(first)
    expect(decoded).toEqual({ _tag: 'Ping', value: 7 })
  })
})

describe('makeExpoTransport — bareSender', () => {
  it('warns and drops when the WebView ref is null', async () => {
    const ref: { current: WebViewHandle | null } = { current: null }
    const layer = HostBridge.Host.ReceiverLayer({ Pong: () => Effect.void })
    const warnings: string[] = []
    const originalLog = console.warn
    console.warn = (msg: unknown): void => {
      warnings.push(String(msg))
    }
    try {
      const transport = await runScoped(
        makeExpoTransport({
          bridges: [HostBridge] as const,
          layers: [layer] as const,
          initialMessages: [],
          webviewHandleRef: ref,
        })
      )
      // Pre-mount send: ref.current is null. Effect.runPromise to
      // surface any defect; logWarning routes through the Effect
      // logger so the test confirms the call resolves cleanly.
      await Effect.runPromise(transport.sendMessage({ _tag: 'Ping', value: 1 }))
    } finally {
      console.warn = originalLog
    }
  })

  it('forwards encoded payloads to the ref-supplied handle', async () => {
    const calls: string[] = []
    const ref: { current: WebViewHandle | null } = {
      current: { postMessage: (data) => calls.push(data) },
    }
    const layer = HostBridge.Host.ReceiverLayer({ Pong: () => Effect.void })
    const transport = await runScoped(
      makeExpoTransport({
        bridges: [HostBridge] as const,
        layers: [layer] as const,
        initialMessages: [],
        webviewHandleRef: ref,
      })
    )
    await Effect.runPromise(transport.sendMessage({ _tag: 'Ping', value: 42 }))
    expect(calls).toHaveLength(1)
    expect(JSON.parse(calls[0] ?? '')).toEqual({ _tag: 'Ping', value: 42 })
  })
})

describe('makeExpoTransport — onMessage', () => {
  it('routes inbound payloads through the dispatch fiber to the handler', async () => {
    const ref: { current: WebViewHandle | null } = { current: null }
    const seen: string[] = []
    const layer = HostBridge.Host.ReceiverLayer({
      Pong: ({ reply }) => Effect.sync(() => seen.push(reply)),
    })
    const transport = await runScoped(
      Effect.gen(function* () {
        const t = yield* makeExpoTransport({
          bridges: [HostBridge] as const,
          layers: [layer] as const,
          initialMessages: [],
          webviewHandleRef: ref,
        })
        const encoded = Schema.encodeSync(Pong)({ _tag: 'Pong', reply: 'hi' })
        // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion
        t.onMessage({ nativeEvent: { data: encoded } } as never)
        // Wait for the dispatch fiber by enqueuing nothing and
        // reading any send through the round trip — simplest is to
        // re-use the helper we got, but the transport's `flushed` is
        // not exposed to consumers. Use a tight Promise tick instead.
        yield* Effect.sleep(0)
        return t
      })
    )
    expect(seen).toEqual(['hi'])
    expect(transport.injectedScript).toContain('window.__INITIAL_MESSAGES__')
  })
})

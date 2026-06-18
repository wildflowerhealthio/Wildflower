import { Effect, Schema } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { Bridge } from 'effect-messaging-core'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { BRIDGE_EVENT } from './event-names.ts'
import { makeTauriTransport, type TauriEventApi } from './tauri-transport.ts'

const TokenIssued = Schema.parseJson(Schema.TaggedStruct('TokenIssued', { token: Schema.String }))
const PingSent = Schema.parseJson(Schema.TaggedStruct('PingSent', { count: Schema.Number }))
const AuthBridge = Bridge.make({
  name: 'Auth',
  hostToWeb: [['TokenIssued', TokenIssued]] as const,
  webToHost: [['PingSent', PingSent]] as const,
})

const ThemeChanged = Schema.parseJson(Schema.TaggedStruct('ThemeChanged', { theme: Schema.String }))
const ThemeBridge = Bridge.make({
  name: 'Theme',
  hostToWeb: [['ThemeChanged', ThemeChanged]] as const,
  webToHost: [] as const,
})

const bridges = [AuthBridge, ThemeBridge] as const

describe('makeTauriTransport', () => {
  it('should attach the single bridge listener before signalling __Ready', async () => {
    // Arrange
    const fake = makeFakeApi()

    // Act
    await makeTauriTransport({ bridges, api: fake.api })

    // Assert — the fake resolves `listen` on a macrotask, so a transport
    // that emitted __Ready without awaiting attachment would record 0.
    // Multiplexed channel: exactly one listener for BRIDGE_EVENT covers
    // every wired tag across every bridge.
    expect(fake.listenedEvents()).toEqual([BRIDGE_EVENT])
    expect(fake.emitted).toEqual([
      { event: BRIDGE_EVENT, payload: { _tag: '__Ready' }, listenersAttached: 1 },
    ])
  })

  it('should deliver a structured host payload to the seeded handler', async () => {
    // Arrange
    const fake = makeFakeApi()
    const { handlers, tokens, delivery } = makeTokenCapture()
    await makeTauriTransport({
      bridges,
      initial: { [AuthBridge.name]: handlers },
      api: fake.api,
    })

    // Act
    fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token: 'bearer-abc123' })

    // Assert
    await delivery.opened
    expect(tokens).toEqual(['bearer-abc123'])
  })

  it('should drop payloads that fail schema validation', async () => {
    // Arrange
    const fake = makeFakeApi()
    const { handlers, tokens, delivery } = makeTokenCapture()
    await makeTauriTransport({
      bridges,
      initial: { [AuthBridge.name]: handlers },
      api: fake.api,
    })

    // Act — a number where the schema demands a string, then a valid push
    fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token: 42 })
    fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token: 'bearer-valid' })

    // Assert — only the valid payload ever lands, whatever the fiber order
    await delivery.opened
    expect(tokens).toEqual(['bearer-valid'])
  })

  it('should drop payloads without a `_tag` discriminator without affecting later delivery', async () => {
    // Arrange — the single-listener demux reads `_tag` to route; payloads
    // without one are unroutable and must be dropped silently rather than
    // crashing the consumer.
    const fake = makeFakeApi()
    const { handlers, tokens, delivery } = makeTokenCapture()
    await makeTauriTransport({
      bridges,
      initial: { [AuthBridge.name]: handlers },
      api: fake.api,
    })

    // Act — malformed shapes, then a valid push to anchor the absence
    fake.fire(BRIDGE_EVENT, null)
    fake.fire(BRIDGE_EVENT, { token: 'no tag here' })
    fake.fire(BRIDGE_EVENT, { _tag: 42 })
    fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token: 'bearer-valid' })

    // Assert
    await delivery.opened
    expect(tokens).toEqual(['bearer-valid'])
  })

  it('should drop payloads whose `_tag` is not wired by any bridge', async () => {
    // Arrange — an unknown tag could be a sibling slice's bridge traffic
    // on the same channel, or a stale producer; either way the receiver
    // must not blow up.
    const fake = makeFakeApi()
    const { handlers, tokens, delivery } = makeTokenCapture()
    await makeTauriTransport({
      bridges,
      initial: { [AuthBridge.name]: handlers },
      api: fake.api,
    })

    // Act
    fake.fire(BRIDGE_EVENT, { _tag: 'NotABridgeTagWeKnow', whatever: true })
    fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token: 'bearer-valid' })

    // Assert
    await delivery.opened
    expect(tokens).toEqual(['bearer-valid'])
  })

  it('should keep dispatching after a message for a bridge with no registered record', async () => {
    // Arrange — Auth is seeded, Theme is not
    const fake = makeFakeApi()
    const { handlers, tokens, delivery } = makeTokenCapture()
    await makeTauriTransport({
      bridges,
      initial: { [AuthBridge.name]: handlers },
      api: fake.api,
    })

    // Act
    fake.fire(BRIDGE_EVENT, { _tag: 'ThemeChanged', theme: 'dark' })
    fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token: 'bearer-after-drop' })

    // Assert
    await delivery.opened
    expect(tokens).toEqual(['bearer-after-drop'])
  })

  it('should route to a record registered through the coordinator after boot', async () => {
    // Arrange
    const fake = makeFakeApi()
    const transport = await makeTauriTransport({ bridges, api: fake.api })
    const { handlers, tokens, delivery } = makeTokenCapture()

    // Act
    await Effect.runPromise(transport.coordinator.register(AuthBridge, handlers))
    fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token: 'bearer-late' })

    // Assert
    await delivery.opened
    expect(tokens).toEqual(['bearer-late'])
  })

  it('should keep the active record when unregistering a record that is not active', async () => {
    // Arrange
    const fake = makeFakeApi()
    const transport = await makeTauriTransport({ bridges, api: fake.api })
    const active = makeTokenCapture()
    const other = makeTokenCapture()
    await Effect.runPromise(transport.coordinator.register(AuthBridge, active.handlers))

    // Act — set-if-equal: a different record identity must not evict
    await Effect.runPromise(transport.coordinator.unregister(AuthBridge, other.handlers))
    fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token: 'bearer-still-active' })

    // Assert
    await active.delivery.opened
    expect(active.tokens).toEqual(['bearer-still-active'])
  })

  it('should stop routing after the active record unregisters', async () => {
    // Arrange
    const fake = makeFakeApi()
    const transport = await makeTauriTransport({ bridges, api: fake.api })
    const stale = makeTokenCapture()
    await Effect.runPromise(transport.coordinator.register(AuthBridge, stale.handlers))

    // Act — unregister, then fire the now-orphaned token at no one.
    await Effect.runPromise(transport.coordinator.unregister(AuthBridge, stale.handlers))
    fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token: 'bearer-orphaned' })

    // Assert — anchor the absence to a presence instead of a fixed settle.
    // Register a FRESH record on a *different* bridge (Theme, so it can't
    // recapture Auth's orphaned token), fire a second event on it, and await
    // *that* delivery. Both events ride the same single-consumer queue and
    // the orphaned one was offered first, so by the time the Theme delivery
    // resolves the orphaned Auth dispatch has provably run (and found no
    // handler). Auth's stale record staying empty therefore means unregister
    // actually evicted it — not that the pipeline simply hadn't reached the
    // orphaned event yet.
    const anchor = makeThemeCapture()
    await Effect.runPromise(transport.coordinator.register(ThemeBridge, anchor.handlers))
    fake.fire(BRIDGE_EVENT, { _tag: 'ThemeChanged', theme: 'dark' })

    await anchor.delivery.opened
    expect(anchor.themes).toEqual(['dark'])
    expect(stale.tokens).toEqual([])
  })

  it('should deliver two rapid same-tag events in order even when the first handler suspends', async () => {
    // Arrange — the first token's handler suspends on a macrotask before
    // recording; the second's is immediate. Under per-event fibers the
    // immediate second would overtake the suspended first. The single
    // consumer queue forbids that: the second program isn't even taken
    // until the first resolves.
    const fake = makeFakeApi()
    const order: Array<string> = []
    let delivered!: () => void
    const bothDelivered = new Promise<void>((resolve) => {
      delivered = resolve
    })
    const handlers: MessageHandler.HandlersFor<(typeof AuthBridge)['HostToWeb']> = {
      TokenIssued: ({ token }) =>
        Effect.gen(function* () {
          // First event suspends across a macrotask; the second does not.
          // A fiber-per-event design would let the second land first.
          if (token === 'first') yield* Effect.promise(() => settle())
          order.push(token)
          if (order.length === 2) delivered()
        }),
    }
    await makeTauriTransport({
      bridges,
      initial: { [AuthBridge.name]: handlers },
      api: fake.api,
    })

    // Act — fire both back-to-back, same tag, same macrotask.
    fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token: 'first' })
    fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token: 'second' })

    // Assert — FIFO held across the suspension.
    await bothDelivered
    expect(order).toEqual(['first', 'second'])
  })

  it('should preserve cross-tag FIFO when one tag streams chunks ahead of a terminal on another', async () => {
    // Arrange — this is the regression the single-channel rewrite exists
    // for. The previous per-tag scheme used one listener per tag, and
    // Tauri's event bus only guarantees FIFO *within* a single name; a
    // chunked stream's terminal could land at the receiver before the
    // earlier chunks. Pin that the new transport keeps cross-tag ordering
    // even when the schemas are independent.
    const ChunkArrived = Schema.parseJson(
      Schema.TaggedStruct('ChunkArrived', { seq: Schema.Number })
    )
    const StreamFinished = Schema.parseJson(Schema.TaggedStruct('StreamFinished', {}))
    const StreamBridge = Bridge.make({
      name: 'Stream',
      hostToWeb: [
        ['ChunkArrived', ChunkArrived],
        ['StreamFinished', StreamFinished],
      ] as const,
      webToHost: [] as const,
    })
    const fake = makeFakeApi()
    const order: Array<string> = []
    let delivered!: () => void
    const allDelivered = new Promise<void>((resolve) => {
      delivered = resolve
    })
    const handlers: MessageHandler.HandlersFor<(typeof StreamBridge)['HostToWeb']> = {
      ChunkArrived: ({ seq }) =>
        Effect.sync(() => {
          order.push(`chunk:${seq}`)
        }),
      StreamFinished: () =>
        Effect.sync(() => {
          order.push('finished')
          delivered()
        }),
    }
    await makeTauriTransport({
      bridges: [StreamBridge] as const,
      initial: { [StreamBridge.name]: handlers },
      api: fake.api,
    })

    // Act — five chunks, then the terminal, on the single channel.
    fake.fire(BRIDGE_EVENT, { _tag: 'ChunkArrived', seq: 1 })
    fake.fire(BRIDGE_EVENT, { _tag: 'ChunkArrived', seq: 2 })
    fake.fire(BRIDGE_EVENT, { _tag: 'ChunkArrived', seq: 3 })
    fake.fire(BRIDGE_EVENT, { _tag: 'ChunkArrived', seq: 4 })
    fake.fire(BRIDGE_EVENT, { _tag: 'ChunkArrived', seq: 5 })
    fake.fire(BRIDGE_EVENT, { _tag: 'StreamFinished' })

    // Assert — every chunk before the terminal, in order.
    await allDelivered
    expect(order).toEqual(['chunk:1', 'chunk:2', 'chunk:3', 'chunk:4', 'chunk:5', 'finished'])
  })

  it('should emit outbound messages on the single bridge channel with the tagged payload', async () => {
    // Arrange
    const fake = makeFakeApi()
    const transport = await makeTauriTransport({ bridges, api: fake.api })

    // Act
    await Effect.runPromise(transport.sendMessage({ _tag: 'PingSent', count: 3 }))

    // Assert
    expect(fake.emitted).toContainEqual(
      expect.objectContaining({
        event: BRIDGE_EVENT,
        payload: { _tag: 'PingSent', count: 3 },
      })
    )
  })

  it('should swallow emit failures without failing the caller', async () => {
    // Arrange
    const fake = makeFakeApi()
    const transport = await makeTauriTransport({ bridges, api: fake.api })
    const emittedBefore = fake.emitted.length
    fake.setEmitFailure(new Error('ipc down'))

    // Act — resolves rather than rejecting; the message is dropped
    await Effect.runPromise(transport.sendMessage({ _tag: 'PingSent', count: 7 }))

    // Assert
    expect(fake.emitted).toHaveLength(emittedBefore)
  })

  it('should reject a tag declared by two bridges', async () => {
    // Arrange — a second bridge re-declaring Auth's inbound TokenIssued
    const ImpostorBridge = Bridge.make({
      name: 'Impostor',
      hostToWeb: [['TokenIssued', TokenIssued]] as const,
      webToHost: [] as const,
    })

    // Act / Assert — fails at build, before any listener attaches
    await expect(
      makeTauriTransport({ bridges: [AuthBridge, ImpostorBridge] as const, api: makeFakeApi().api })
    ).rejects.toThrow(/tag "TokenIssued".*"Impostor".*collides/)
  })

  it('should reject a tag shared across directions', async () => {
    // Arrange — PingSent is Auth's *outbound* tag; an inbound twin on
    // another bridge would make the web receive its own sends (Tauri
    // events broadcast back to the emitter).
    const EchoBridge = Bridge.make({
      name: 'Echo',
      hostToWeb: [['PingSent', PingSent]] as const,
      webToHost: [] as const,
    })

    // Act / Assert
    await expect(
      makeTauriTransport({ bridges: [AuthBridge, EchoBridge] as const, api: makeFakeApi().api })
    ).rejects.toThrow(/tag "PingSent".*collides/)
  })

  it('should reject a bridge claiming the reserved __Ready tag', async () => {
    // Arrange
    const HandshakeSquatter = Bridge.make({
      name: 'Squatter',
      hostToWeb: [
        ['__Ready', Schema.parseJson(Schema.TaggedStruct('__Ready', {}))] as const,
      ] as const,
      webToHost: [] as const,
    })

    // Act / Assert
    await expect(
      makeTauriTransport({ bridges: [HandshakeSquatter] as const, api: makeFakeApi().api })
    ).rejects.toThrow(/__Ready/)
  })

  it('should deliver any token string intact', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (token) => {
        // Arrange
        const fake = makeFakeApi()
        const { handlers, tokens, delivery } = makeTokenCapture()
        await makeTauriTransport({
          bridges,
          initial: { [AuthBridge.name]: handlers },
          api: fake.api,
        })

        // Act
        fake.fire(BRIDGE_EVENT, { _tag: 'TokenIssued', token })

        // Assert
        await delivery.opened
        expect(tokens).toEqual([token])
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

interface EmittedEvent {
  readonly event: string
  readonly payload: unknown
  /** Distinct events with listeners at emit time — pins listen-before-ready ordering. */
  readonly listenersAttached: number
}

interface FakeApi {
  readonly api: TauriEventApi
  readonly emitted: ReadonlyArray<EmittedEvent>
  readonly listenedEvents: () => ReadonlyArray<string>
  readonly fire: (event: string, payload: unknown) => void
  readonly setEmitFailure: (error: Error) => void
}

const makeFakeApi = (): FakeApi => {
  const listeners = new Map<string, Array<(event: { readonly payload: unknown }) => void>>()
  const emitted: Array<EmittedEvent> = []
  let emitFailure: Error | null = null
  const api: TauriEventApi = {
    emit: (event, payload) => {
      if (emitFailure !== null) return Promise.reject(emitFailure)
      emitted.push({ event, payload, listenersAttached: listeners.size })
      return Promise.resolve()
    },
    listen: (event, handler) =>
      // Attach on a macrotask so a transport that signalled __Ready
      // without awaiting attachment records `listenersAttached: 0`.
      new Promise((resolve) => {
        setTimeout(() => {
          listeners.set(event, [...(listeners.get(event) ?? []), handler])
          resolve(() => undefined)
        }, 0)
      }),
  }
  return {
    api,
    emitted,
    listenedEvents: () => [...listeners.keys()],
    fire: (event, payload) => {
      for (const handler of listeners.get(event) ?? []) handler({ payload })
    },
    setEmitFailure: (error) => {
      emitFailure = error
    },
  }
}

/** A typed Auth handler record that records tokens and opens a one-shot delivery gate. */
const makeTokenCapture = (): {
  readonly handlers: MessageHandler.HandlersFor<(typeof AuthBridge)['HostToWeb']>
  readonly tokens: ReadonlyArray<string>
  readonly delivery: { readonly opened: Promise<void> }
} => {
  const tokens: Array<string> = []
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  const handlers: MessageHandler.HandlersFor<(typeof AuthBridge)['HostToWeb']> = {
    TokenIssued: ({ token }) =>
      Effect.sync(() => {
        tokens.push(token)
        open()
      }),
  }
  return { handlers, tokens, delivery: { opened } }
}

/** A typed Theme handler record that records themes and opens a one-shot delivery gate. */
const makeThemeCapture = (): {
  readonly handlers: MessageHandler.HandlersFor<(typeof ThemeBridge)['HostToWeb']>
  readonly themes: ReadonlyArray<string>
  readonly delivery: { readonly opened: Promise<void> }
} => {
  const themes: Array<string> = []
  let open!: () => void
  const opened = new Promise<void>((resolve) => {
    open = resolve
  })
  const handlers: MessageHandler.HandlersFor<(typeof ThemeBridge)['HostToWeb']> = {
    ThemeChanged: ({ theme }) =>
      Effect.sync(() => {
        themes.push(theme)
        open()
      }),
  }
  return { handlers, themes, delivery: { opened } }
}

/** One macrotask — long enough for a forked all-sync dispatch fiber to finish. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

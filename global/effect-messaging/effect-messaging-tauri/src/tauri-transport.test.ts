import { Effect, Schema } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { Bridge } from 'effect-messaging-core'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import { READY_EVENT } from './event-names.ts'
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
  it('should attach a listener for every host→web tag before signalling __Ready', async () => {
    // Arrange
    const fake = makeFakeApi()

    // Act
    await makeTauriTransport({ bridges, api: fake.api })

    // Assert — the fake resolves `listen` on a macrotask, so a transport
    // that emitted __Ready without awaiting attachment would record 0.
    expect(fake.listenedEvents()).toEqual(
      expect.arrayContaining(['bridge:TokenIssued', 'bridge:ThemeChanged'])
    )
    expect(fake.emitted).toEqual([
      { event: READY_EVENT, payload: { _tag: '__Ready' }, listenersAttached: 2 },
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
    fake.fire('bridge:TokenIssued', { _tag: 'TokenIssued', token: 'bearer-abc123' })

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
    fake.fire('bridge:TokenIssued', { _tag: 'TokenIssued', token: 42 })
    fake.fire('bridge:TokenIssued', { _tag: 'TokenIssued', token: 'bearer-valid' })

    // Assert — only the valid payload ever lands, whatever the fiber order
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
    fake.fire('bridge:ThemeChanged', { _tag: 'ThemeChanged', theme: 'dark' })
    fake.fire('bridge:TokenIssued', { _tag: 'TokenIssued', token: 'bearer-after-drop' })

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
    fake.fire('bridge:TokenIssued', { _tag: 'TokenIssued', token: 'bearer-late' })

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
    fake.fire('bridge:TokenIssued', { _tag: 'TokenIssued', token: 'bearer-still-active' })

    // Assert
    await active.delivery.opened
    expect(active.tokens).toEqual(['bearer-still-active'])
  })

  it('should stop routing after the active record unregisters', async () => {
    // Arrange
    const fake = makeFakeApi()
    const transport = await makeTauriTransport({ bridges, api: fake.api })
    const { handlers, tokens } = makeTokenCapture()
    await Effect.runPromise(transport.coordinator.register(AuthBridge, handlers))

    // Act
    await Effect.runPromise(transport.coordinator.unregister(AuthBridge, handlers))
    fake.fire('bridge:TokenIssued', { _tag: 'TokenIssued', token: 'bearer-orphaned' })

    // Assert
    await settle()
    expect(tokens).toEqual([])
  })

  it('should emit outbound messages on their per-tag event', async () => {
    // Arrange
    const fake = makeFakeApi()
    const transport = await makeTauriTransport({ bridges, api: fake.api })

    // Act
    await Effect.runPromise(transport.sendMessage({ _tag: 'PingSent', count: 3 }))

    // Assert
    expect(fake.emitted).toContainEqual(
      expect.objectContaining({
        event: 'bridge:PingSent',
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
        fake.fire('bridge:TokenIssued', { _tag: 'TokenIssued', token })

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

/** One macrotask — long enough for a forked all-sync dispatch fiber to finish. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

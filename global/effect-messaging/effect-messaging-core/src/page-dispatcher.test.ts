import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Schema } from 'effect'
import * as fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import * as Bridge from './bridge.ts'
import type * as MessageHandler from './message-handler.ts'
import * as PageDispatcher from './page-dispatcher.ts'

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

describe('PageDispatcher.make', () => {
  // The dispatch fiber runs on the default runtime, whose logger writes
  // every level through `console.log`; the spy both captures warnings and
  // keeps them out of the test output.
  let consoleLog: ReturnType<typeof vi.spyOn>
  beforeEach(() => {
    consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })
  afterEach(() => {
    consoleLog.mockRestore()
  })
  const loggedLines = (): ReadonlyArray<string> =>
    consoleLog.mock.calls.map((args: ReadonlyArray<unknown>) => args.map(String).join(' '))

  it('should dispatch an offered payload to the seeded handler', async () => {
    // Arrange
    const { handlers, tokens, delivery } = makeTokenCapture()
    const dispatcher = PageDispatcher.make({ bridges, initial: { [AuthBridge.name]: handlers } })

    // Act
    dispatcher.offer({ _tag: 'TokenIssued', token: 'bearer-abc123' })

    // Assert
    await delivery.opened
    expect(tokens).toEqual(['bearer-abc123'])
  })

  it('should dispatch to a handler registered through the coordinator after make', async () => {
    // Arrange
    const dispatcher = PageDispatcher.make({ bridges })
    const { handlers, tokens, delivery } = makeTokenCapture()

    // Act
    await Effect.runPromise(dispatcher.coordinator.register(AuthBridge, handlers))
    dispatcher.offer({ _tag: 'TokenIssued', token: 'bearer-late' })

    // Assert
    await delivery.opened
    expect(tokens).toEqual(['bearer-late'])
  })

  it('should dispatch in offer order across tags while handlers suspend', async () => {
    // Arrange — two tags on one bridge, each message carrying whether its
    // handler suspends across a macrotask before recording. A
    // fiber-per-payload dispatcher would let an immediate later message
    // overtake a suspended earlier one, whichever tag either carries.
    const ChunkArrived = Schema.parseJson(
      Schema.TaggedStruct('ChunkArrived', { seq: Schema.Number, suspends: Schema.Boolean })
    )
    const NoteAdded = Schema.parseJson(
      Schema.TaggedStruct('NoteAdded', { seq: Schema.Number, suspends: Schema.Boolean })
    )
    const StreamBridge = Bridge.make({
      name: 'Stream',
      hostToWeb: [
        ['ChunkArrived', ChunkArrived],
        ['NoteAdded', NoteAdded],
      ] as const,
      webToHost: [] as const,
    })
    const messageArb = fc.array(
      fc.record({
        _tag: fc.constantFrom('ChunkArrived' as const, 'NoteAdded' as const),
        suspends: fc.boolean(),
      }),
      { minLength: 1, maxLength: 20 }
    )

    await fc.assert(
      fc.asyncProperty(messageArb, async (messages) => {
        const order: Array<string> = []
        let delivered!: () => void
        const allDelivered = new Promise<void>((resolve) => {
          delivered = resolve
        })
        const record =
          (tag: string) =>
          ({ seq, suspends }: { readonly seq: number; readonly suspends: boolean }) =>
            Effect.gen(function* () {
              if (suspends) yield* Effect.promise(() => settle())
              order.push(`${tag}:${seq}`)
              if (order.length === messages.length) delivered()
            })
        const handlers: MessageHandler.HandlersFor<(typeof StreamBridge)['HostToWeb']> = {
          ChunkArrived: record('ChunkArrived'),
          NoteAdded: record('NoteAdded'),
        }
        const dispatcher = PageDispatcher.make({
          bridges: [StreamBridge] as const,
          initial: { [StreamBridge.name]: handlers },
        })

        // Act — every offer in one synchronous run, before any dispatch.
        messages.forEach(({ _tag, suspends }, seq) => {
          dispatcher.offer({ _tag, seq, suspends })
        })

        // Assert
        await allDelivered
        expect(order).toEqual(messages.map(({ _tag }, seq) => `${_tag}:${seq}`))
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it('should drop an undecodable payload with a warning and keep dispatching', async () => {
    // Arrange
    const { handlers, tokens, delivery } = makeTokenCapture()
    const dispatcher = PageDispatcher.make({ bridges, initial: { [AuthBridge.name]: handlers } })

    // Act — a number where the schema demands a string, then a valid push
    dispatcher.offer({ _tag: 'TokenIssued', token: 42 })
    dispatcher.offer({ _tag: 'TokenIssued', token: 'bearer-valid' })

    // Assert — the valid payload's delivery proves the bad one was
    // already processed (one FIFO consumer).
    await delivery.opened
    expect(tokens).toEqual(['bearer-valid'])
    expect(loggedLines()).toContainEqual(
      expect.stringMatching(/level=WARN.*undecodable inbound TokenIssued payload dropped/)
    )
  })

  it('should warn and drop a payload for a bridge with no registered record', async () => {
    // Arrange — Auth is seeded, Theme is not
    const { handlers, tokens, delivery } = makeTokenCapture()
    const dispatcher = PageDispatcher.make({ bridges, initial: { [AuthBridge.name]: handlers } })

    // Act
    dispatcher.offer({ _tag: 'ThemeChanged', theme: 'dark' })
    dispatcher.offer({ _tag: 'TokenIssued', token: 'bearer-after-drop' })

    // Assert
    await delivery.opened
    expect(tokens).toEqual(['bearer-after-drop'])
    expect(loggedLines()).toContainEqual(
      expect.stringMatching(/level=WARN.*Theme: dropping ThemeChanged/)
    )
  })

  it('should silently drop payloads that carry no wired inbound tag', async () => {
    // Arrange
    const { handlers, tokens, delivery } = makeTokenCapture()
    const dispatcher = PageDispatcher.make({ bridges, initial: { [AuthBridge.name]: handlers } })

    // Act — unroutable shapes, an outbound echo, then a valid push
    dispatcher.offer(null)
    dispatcher.offer('TokenIssued')
    dispatcher.offer({ token: 'no tag here' })
    dispatcher.offer({ _tag: 42 })
    dispatcher.offer({ _tag: 'NotABridgeTagWeKnow' })
    dispatcher.offer({ _tag: 'PingSent', count: 1 })
    dispatcher.offer({ _tag: 'TokenIssued', token: 'bearer-valid' })

    // Assert
    await delivery.opened
    expect(tokens).toEqual(['bearer-valid'])
    expect(loggedLines()).toEqual([])
  })

  it('should reject a tag declared by two bridges', () => {
    // Arrange — a second bridge re-declaring Auth's inbound TokenIssued
    const ImpostorBridge = Bridge.make({
      name: 'Impostor',
      hostToWeb: [['TokenIssued', TokenIssued]] as const,
      webToHost: [] as const,
    })

    // Act / Assert
    expect(() => PageDispatcher.make({ bridges: [AuthBridge, ImpostorBridge] as const })).toThrow(
      /tag "TokenIssued" on bridge "Impostor" \(HostToWeb\) collides with bridge "Auth" \(HostToWeb\)/
    )
  })

  it('should reject a tag shared across directions', () => {
    // Arrange — PingSent is Auth's outbound tag
    const EchoBridge = Bridge.make({
      name: 'Echo',
      hostToWeb: [['PingSent', PingSent]] as const,
      webToHost: [] as const,
    })

    // Act / Assert
    expect(() => PageDispatcher.make({ bridges: [AuthBridge, EchoBridge] as const })).toThrow(
      /tag "PingSent" on bridge "Echo" \(HostToWeb\) collides with bridge "Auth" \(WebToHost\)/
    )
  })

  it('should reject a bridge claiming the reserved __Ready tag', () => {
    // Arrange
    const HandshakeSquatter = Bridge.make({
      name: 'Squatter',
      hostToWeb: [] as const,
      webToHost: [['__Ready', Schema.parseJson(Schema.TaggedStruct('__Ready', {}))]] as const,
    })

    // Act / Assert
    expect(() => PageDispatcher.make({ bridges: [HandshakeSquatter] as const })).toThrow(
      /tag "__Ready" .*collides with the reserved __Ready handshake tag/
    )
  })
})

// Helpers

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

/** One macrotask. */
const settle = (): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, 0)
  })

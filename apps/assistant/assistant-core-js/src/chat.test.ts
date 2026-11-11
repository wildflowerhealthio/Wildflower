import type {
  BetaAssistantMessageParam,
  BetaContentBlock,
  BetaToolResultBlockParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Layer, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import type * as BrowserStorage from './browser-storage.ts'
import * as Chat from './chat.ts'
import {
  memoryStorage,
  refusingStorage,
  onePatientChat,
  textBlock,
  thinkingBlock,
  toolUseBlock,
} from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

/** A reply's content as the API returns it: text, summarized or redacted thinking, tool calls and fallback switch points. */
const contentBlockArb: fc.Arbitrary<BetaContentBlock> = fc.oneof(
  fc.string().map(textBlock),
  fc.tuple(fc.string({ minLength: 1 }), fc.string()).map(([id, code]) =>
    toolUseBlock(id, 'search_records', {
      resourceType: 'Observation',
      params: [{ name: 'code', value: code }],
    })
  ),
  fc
    .tuple(fc.string(), fc.string({ minLength: 1 }))
    .map(([thinking, signature]) => thinkingBlock(thinking, signature)),
  fc
    .string({ minLength: 1 })
    .map((data): BetaContentBlock => ({ type: 'redacted_thinking', data })),
  fc.constant<BetaContentBlock>({
    type: 'fallback',
    from: { model: 'claude-opus-5' },
    to: { model: 'claude-opus-4-8' },
    trigger: { type: 'refusal', category: 'cyber' },
  })
)

const modelIdArb = fc.constantFrom('claude-sonnet-5', 'claude-opus-5')

const assistantMessageArb = fc
  .array(contentBlockArb, { maxLength: 5 })
  .map((content) => ({ role: 'assistant' as const, content }))

const toolResultArb = fc.record({
  type: fc.constant('tool_result' as const),
  tool_use_id: fc.string({ minLength: 1 }),
  content: fc.string(),
  is_error: fc.boolean(),
})

const entryArb: fc.Arbitrary<Chat.Entry> = fc.oneof(
  fc.string().map(Chat.userEntryOf),
  fc.record({
    _tag: fc.constant('agent' as const),
    modelId: modelIdArb,
    stopReason: fc.constantFrom('end_turn' as const, 'max_tokens' as const),
    message: assistantMessageArb,
  }),
  fc.record({
    _tag: fc.constant('tool-round' as const),
    modelId: modelIdArb,
    message: assistantMessageArb,
    results: fc
      .tuple(toolResultArb, fc.array(toolResultArb, { maxLength: 2 }))
      .map(([first, rest]): Chat.ToolRound['results'] => [first, ...rest]),
  }),
  fc.record({ _tag: fc.constant('refusal' as const), modelId: modelIdArb })
)

const chatArb: fc.Arbitrary<Chat.Type> = fc.record({
  style: fc.constantFrom('telehealth' as const, 'academic' as const),
  entries: fc.array(entryArb, { maxLength: 8 }),
})

const patient = onePatientChat({ id: 'p1', given: 'Ada', family: 'Lovelace' })
const place: Chat.Place = { fhirBaseUrl: 'https://fhir.example/r4', patient }

describe('Chat codec', () => {
  it('should round-trip every chat through its JSON exactly, thinking blocks and signatures included', () => {
    const StoredChat = Schema.parseJson(Chat.Schema)
    fc.assert(
      fc.property(chatArb, (chat) => {
        expect(Schema.decodeSync(StoredChat)(Schema.encodeSync(StoredChat)(chat))).toEqual(chat)
      }),
      { numRuns: RUNS }
    )
  })

  it('should refuse a stored message whose role does not match its entry', () => {
    const decoded = Schema.decodeUnknownEither(Chat.Schema)({
      style: 'telehealth',
      entries: [{ _tag: 'user', message: { role: 'assistant', content: 'hi' } }],
    })

    expect(decoded._tag).toBe('Left')
  })
})

describe('Chat.append', () => {
  it('should add the entry after the last and leave every earlier one as it was', () => {
    fc.assert(
      fc.property(chatArb, entryArb, (chat, entry) => {
        const appended = Chat.append(chat, entry)

        expect(appended).toEqual({ style: chat.style, entries: [...chat.entries, entry] })
      }),
      { numRuns: RUNS }
    )
  })
})

describe('Chat.requestMessagesOf', () => {
  it('should send user and agent entries in order, leaving out a declined user entry with its refusal', () => {
    const answer = { role: 'assistant' as const, content: [textBlock('Hello')] }
    const chat: Chat.Type = {
      style: 'telehealth',
      entries: [
        Chat.userEntryOf('hi'),
        { _tag: 'agent', modelId: 'claude-sonnet-5', stopReason: 'end_turn', message: answer },
        Chat.userEntryOf('declined question'),
        { _tag: 'refusal', modelId: 'claude-sonnet-5' },
        Chat.userEntryOf('stopped question'),
        Chat.userEntryOf('next question'),
      ],
    }

    expect(Chat.requestMessagesOf(chat)).toEqual([
      { role: 'user', content: 'hi' },
      answer,
      { role: 'user', content: 'stopped question' },
      { role: 'user', content: 'next question' },
    ])
  })

  it('should send a fallen-back reply without the thinking before its last switch point, keeping its text', () => {
    const fallback: BetaContentBlock = {
      type: 'fallback',
      from: { model: 'claude-opus-5' },
      to: { model: 'claude-opus-4-8' },
      trigger: { type: 'refusal', category: 'cyber' },
    }
    const reply: Chat.Entry = {
      _tag: 'agent',
      modelId: 'claude-opus-5',
      stopReason: 'end_turn',
      message: {
        role: 'assistant',
        content: [
          thinkingBlock('declined thoughts'),
          textBlock('partial'),
          fallback,
          thinkingBlock('fallback thoughts'),
          textBlock('answer'),
        ],
      },
    }

    expect(
      Chat.requestMessagesOf({ style: 'telehealth', entries: [Chat.userEntryOf('q'), reply] })
    ).toEqual([
      { role: 'user', content: 'q' },
      {
        role: 'assistant',
        content: [
          textBlock('partial'),
          fallback,
          thinkingBlock('fallback thoughts'),
          textBlock('answer'),
        ],
      },
    ])
  })

  it('should send a reply with no fallback exactly as it was returned', () => {
    fc.assert(
      fc.property(
        fc.array(contentBlockArb.filter((block) => block.type !== 'fallback')),
        (content) => {
          const message = { role: 'assistant' as const, content }
          const chat: Chat.Type = {
            style: 'academic',
            entries: [
              Chat.userEntryOf('q'),
              { _tag: 'agent', modelId: 'claude-opus-5', stopReason: 'end_turn', message },
            ],
          }

          expect(Chat.requestMessagesOf(chat)[1]).toEqual(message)
        }
      ),
      { numRuns: RUNS }
    )
  })
})

describe('Chat tool rounds', () => {
  const call = toolUseBlock('call-1', 'search_records', { resourceType: 'Observation', params: [] })
  const callingMessage: BetaAssistantMessageParam = {
    role: 'assistant',
    content: [textBlock('Looking'), call],
  }
  const result: BetaToolResultBlockParam = {
    type: 'tool_result',
    tool_use_id: 'call-1',
    content: '{"resources":[]}',
  }
  const toolRound: Chat.ToolRound = {
    _tag: 'tool-round',
    modelId: 'claude-sonnet-5',
    message: callingMessage,
    results: [result],
  }

  it('should send a tool round as its reply then its results, in order', () => {
    const answer: Chat.Entry = {
      _tag: 'agent',
      modelId: 'claude-sonnet-5',
      stopReason: 'end_turn',
      message: { role: 'assistant', content: [textBlock('Nothing found.')] },
    }
    const chat: Chat.Type = {
      style: 'telehealth',
      entries: [Chat.userEntryOf('labs?'), toolRound, answer],
    }

    expect(Chat.requestMessagesOf(chat)).toEqual([
      { role: 'user', content: 'labs?' },
      callingMessage,
      { role: 'user', content: [result] },
      answer.message,
    ])
  })

  it('should leave out a declined user entry with its tool rounds, keeping what came before', () => {
    const chat: Chat.Type = {
      style: 'telehealth',
      entries: [
        Chat.userEntryOf('first'),
        Chat.userEntryOf('declined'),
        toolRound,
        { _tag: 'refusal', modelId: 'claude-sonnet-5' },
        Chat.userEntryOf('next'),
      ],
    }

    expect(Chat.requestMessagesOf(chat)).toEqual([
      { role: 'user', content: 'first' },
      { role: 'user', content: 'next' },
    ])
  })

  it('should run the tool calls after the last fallback switch point only', () => {
    const declinedCall = toolUseBlock('call-0', 'read_record', {
      resourceType: 'Patient',
      id: 'p1',
    })
    const fallback: BetaContentBlock = {
      type: 'fallback',
      from: { model: 'claude-opus-5' },
      to: { model: 'claude-opus-4-8' },
      trigger: { type: 'refusal', category: 'cyber' },
    }

    expect(
      Chat.toolCallsOf({
        role: 'assistant',
        content: [declinedCall, fallback, textBlock('ok'), call],
      })
    ).toEqual([call])
    expect(Chat.toolCallsOf({ role: 'assistant', content: 'no calls' })).toEqual([])
  })

  it('should find each tool result by the id of the call it answers', () => {
    const results = Chat.toolResultsByCallIdOf(toolRound)

    expect([...results.entries()]).toEqual([['call-1', result]])
  })

  it('should refuse a stored tool round with no results', () => {
    const decoded = Schema.decodeUnknownEither(Chat.Schema)({
      style: 'telehealth',
      entries: [{ ...toolRound, results: [] }],
    })

    expect(decoded._tag).toBe('Left')
  })
})

/** `effect` against the chats kept in `storage`. */
const keptIn = <A, E>(
  storage: Layer.Layer<BrowserStorage.Local | BrowserStorage.Session>,
  effect: Effect.Effect<A, E, Chat.Store>
): Effect.Effect<A, E> => effect.pipe(Effect.provide(Layer.provide(Chat.layer, storage)))

describe('Chat storage', () => {
  it('should key a chat by the FHIR base and the patient, * for every patient', () => {
    expect(Chat.storageKeyOf(place)).toBe('wildflower.assistant-chat:https://fhir.example/r4:p1')
    expect(Chat.storageKeyOf({ ...place, patient: { kind: 'all-patients' } })).toBe(
      'wildflower.assistant-chat:https://fhir.example/r4:*'
    )
  })

  it('should read back the chat it wrote, in sessionStorage', () => {
    fc.assert(
      fc.property(chatArb, (chat) => {
        const storage = memoryStorage()

        Effect.runSync(keptIn(storage.layer, Chat.write(place, chat)))

        expect(Effect.runSync(keptIn(storage.layer, Chat.read(place)))).toEqual(Option.some(chat))
        expect(Effect.runSync(storage.session.has(Chat.storageKeyOf(place)))).toBe(true)
        expect(Effect.runSync(storage.local.size)).toBe(0)
      }),
      { numRuns: RUNS }
    )
  })

  it('should read no chat where none is kept, or once it is forgotten', () => {
    const { layer } = memoryStorage()
    expect(Effect.runSync(keptIn(layer, Chat.read(place)))).toEqual(Option.none())

    Effect.runSync(keptIn(layer, Chat.write(place, Chat.start('telehealth'))))
    Effect.runSync(keptIn(layer, Chat.forget(place)))

    expect(Effect.runSync(keptIn(layer, Chat.read(place)))).toEqual(Option.none())
  })

  it('should fail when the browser refuses the read, or what is kept is not a chat', () => {
    const notAChat = memoryStorage()
    Effect.runSync(notAChat.session.set(Chat.storageKeyOf(place), '{"style":"loud"}'))

    expect(Effect.runSync(Effect.flip(keptIn(refusingStorage, Chat.read(place))))).toMatchObject({
      _tag: 'SystemError',
      method: 'get',
    })
    const unreadable = Effect.runSync(Effect.flip(keptIn(notAChat.layer, Chat.read(place))))
    expect(unreadable).toEqual(new Chat.StoredChatUnreadable())
    expect(JSON.stringify(unreadable)).not.toContain('loud')
  })
})

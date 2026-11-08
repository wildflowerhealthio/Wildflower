import type { BetaContentBlock } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Effect, Option, Schema } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import type * as ChatPatient from './chat-patient.ts'
import * as Chat from './chat.ts'
import { blockedStoragePage, memoryStoragePage, textBlock, thinkingBlock } from './test-helpers.ts'

const RUNS = numRunsFor({ base: 100 })

/** A reply's content as the API returns it: text, summarized or redacted thinking, and fallback switch points. */
const contentBlockArb: fc.Arbitrary<BetaContentBlock> = fc.oneof(
  fc.string().map(textBlock),
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

const entryArb: fc.Arbitrary<Chat.Entry> = fc.oneof(
  fc.string().map(Chat.questionOf),
  fc.record({
    _tag: fc.constant('reply' as const),
    model: modelIdArb,
    stopReason: fc.constantFrom('end_turn' as const, 'max_tokens' as const),
    message: fc
      .array(contentBlockArb, { maxLength: 5 })
      .map((content) => ({ role: 'assistant' as const, content })),
  }),
  fc.record({ _tag: fc.constant('refusal' as const), model: modelIdArb })
)

const chatArb: fc.Arbitrary<Chat.Type> = fc.record({
  style: fc.constantFrom('telehealth' as const, 'academic' as const),
  entries: fc.array(entryArb, { maxLength: 8 }),
})

const patient: ChatPatient.Type = {
  kind: 'patient',
  patientId: 'p1',
  name: 'Ada Lovelace',
  birthDate: Option.none(),
}
const place: Chat.ChatPlace = { fhirBase: 'https://fhir.example/r4', patient }

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
      entries: [{ _tag: 'question', message: { role: 'assistant', content: 'hi' } }],
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
  it('should send questions and replies in order, leaving out a declined question with its refusal', () => {
    const answer = { role: 'assistant' as const, content: [textBlock('Hello')] }
    const chat: Chat.Type = {
      style: 'telehealth',
      entries: [
        Chat.questionOf('hi'),
        { _tag: 'reply', model: 'claude-sonnet-5', stopReason: 'end_turn', message: answer },
        Chat.questionOf('declined question'),
        { _tag: 'refusal', model: 'claude-sonnet-5' },
        Chat.questionOf('stopped question'),
        Chat.questionOf('next question'),
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
      _tag: 'reply',
      model: 'claude-opus-5',
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
      Chat.requestMessagesOf({ style: 'telehealth', entries: [Chat.questionOf('q'), reply] })
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
              Chat.questionOf('q'),
              { _tag: 'reply', model: 'claude-opus-5', stopReason: 'end_turn', message },
            ],
          }

          expect(Chat.requestMessagesOf(chat)[1]).toEqual(message)
        }
      ),
      { numRuns: RUNS }
    )
  })
})

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
        const page = memoryStoragePage()

        Effect.runSync(Chat.write(page, place, chat))

        expect(Effect.runSync(Chat.read(page, place))).toEqual(Option.some(chat))
        expect(page.sessionStorage.items.has(Chat.storageKeyOf(place))).toBe(true)
        expect(page.localStorage.items.size).toBe(0)
      }),
      { numRuns: RUNS }
    )
  })

  it('should read no chat where none is kept, or once it is forgotten', () => {
    const page = memoryStoragePage()
    expect(Effect.runSync(Chat.read(page, place))).toEqual(Option.none())

    Effect.runSync(Chat.write(page, place, Chat.start('telehealth')))
    Effect.runSync(Chat.forget(page, place))

    expect(Effect.runSync(Chat.read(page, place))).toEqual(Option.none())
  })

  it('should fail when the browser refuses the read, or what is kept is not a chat', () => {
    const notAChat = memoryStoragePage()
    notAChat.sessionStorage.items.set(Chat.storageKeyOf(place), '{"style":"loud"}')

    expect(Effect.runSync(Effect.flip(Chat.read(blockedStoragePage(), place)))).toMatchObject({
      _tag: 'StorageBlocked',
      operation: 'read',
    })
    const unreadable = Effect.runSync(Effect.flip(Chat.read(notAChat, place)))
    expect(unreadable).toEqual(new Chat.StoredChatUnreadable())
    expect(JSON.stringify(unreadable)).not.toContain('loud')
  })
})

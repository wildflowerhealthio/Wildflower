import {
  APIConnectionError,
  AuthenticationError,
  BadRequestError,
  OverloadedError,
  RateLimitError,
} from '@anthropic-ai/sdk'
import type { BetaStopReason } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { DateTime, Effect, Exit, Fiber, Layer } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import type * as ChatPatient from './chat-patient.ts'
import * as Chat from './chat.ts'
import type * as ClaudeModel from './claude-model.ts'
import { ClaudeRequestFailed } from './claude.ts'
import * as Style from './style.ts'
import {
  failingReply,
  heldReply,
  messageOf,
  scriptedReply,
  type StubClaude,
  stubClaude,
  textBlock,
  textDelta,
  thinkingBlock,
  thinkingDelta,
} from './test-helpers.ts'
import * as Turn from './turn.ts'

const sonnet: ClaudeModel.Type = {
  id: 'claude-sonnet-5',
  displayName: 'Claude Sonnet 5',
  createdAt: DateTime.unsafeMake('2026-05-01T00:00:00Z'),
  adaptiveThinking: true,
}
const patient: ChatPatient.Type = { kind: 'all-patients' }
const asked = Chat.append(Chat.start('telehealth'), Chat.questionOf('How are my labs?'))
const utc = DateTime.layerCurrentZone(DateTime.zoneUnsafeMakeNamed('UTC'))

/** Run a turn of `asked` against `stub`, collecting the pieces it reports. */
const runTurn = (
  stub: StubClaude,
  request: Turn.TurnRequest = { chat: asked, model: sonnet, patient }
): {
  readonly deltas: Turn.Delta[]
  readonly outcome: Promise<Exit.Exit<Chat.Entry, ClaudeRequestFailed | Turn.UnexpectedStop>>
} => {
  const deltas: Turn.Delta[] = []
  const outcome = Effect.runPromiseExit(
    Turn.run(request, (delta) => deltas.push(delta)).pipe(
      Effect.provide(Layer.merge(stub.layer, utc))
    )
  )
  return { deltas, outcome }
}

describe('Turn.paramsOf', () => {
  const today = DateTime.unsafeMakeZoned('2026-11-08T12:00:00Z', { timeZone: 'UTC' })

  it('should ask for summarized adaptive thinking, no tools, caching and default fallbacks', () => {
    expect(Turn.paramsOf({ chat: asked, model: sonnet, patient }, today)).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 64000,
      system: Style.systemPromptOf({ style: 'telehealth', patient, today }),
      messages: [{ role: 'user', content: 'How are my labs?' }],
      tools: [],
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive', display: 'summarized' },
    })
  })

  it('should leave thinking out for a model without adaptive thinking', () => {
    const params = Turn.paramsOf(
      { chat: asked, model: { ...sonnet, adaptiveThinking: false }, patient },
      today
    )

    expect(params).not.toHaveProperty('thinking')
    expect(params.fallbacks).toBe('default')
  })
})

describe('Turn.run', () => {
  it('should report thinking and text as they stream, then keep the whole reply as returned', async () => {
    const content = [thinkingBlock('Looking'), textBlock('Your labs are fine.')]
    const stub = stubClaude({
      replies: [
        scriptedReply(
          [thinkingDelta('Looking'), textDelta('Your labs '), textDelta('are fine.')],
          messageOf({ content, stopReason: 'end_turn' })
        ),
      ],
    })

    const { deltas, outcome } = runTurn(stub)

    expect(await outcome).toEqual(
      Exit.succeed({
        _tag: 'reply',
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        message: { role: 'assistant', content },
      })
    )
    expect(deltas).toEqual([
      { kind: 'thinking', text: 'Looking' },
      { kind: 'text', text: 'Your labs ' },
      { kind: 'text', text: 'are fine.' },
    ])
    expect(stub.requests).toHaveLength(1)
  })

  it('should keep a reply cut off at max_tokens, marked so', async () => {
    const stub = stubClaude({
      replies: [
        scriptedReply([], messageOf({ content: [textBlock('Partial')], stopReason: 'max_tokens' })),
      ],
    })

    expect(await runTurn(stub).outcome).toMatchObject(
      Exit.succeed({ _tag: 'reply', stopReason: 'max_tokens' })
    )
  })

  it('should keep a refusal as a refusal, without what was written before it', async () => {
    const stub = stubClaude({
      replies: [
        scriptedReply(
          [textDelta('Partial')],
          messageOf({ content: [textBlock('Partial')], stopReason: 'refusal' })
        ),
      ],
    })

    expect(await runTurn(stub).outcome).toEqual(
      Exit.succeed({ _tag: 'refusal', model: 'claude-sonnet-5' })
    )
  })

  it.each([
    'tool_use',
    'pause_turn',
    'stop_sequence',
    'model_context_window_exceeded',
    null,
  ] as const)(
    'should fail naming the stop reason %s, which a chat without tools does not expect',
    async (stopReason: BetaStopReason | null) => {
      const stub = stubClaude({
        replies: [scriptedReply([], messageOf({ content: [textBlock('secret')], stopReason }))],
      })

      const outcome = await runTurn(stub).outcome

      expect(outcome).toEqual(Exit.fail(Turn.UnexpectedStop.make({ stopReason })))
      expect(JSON.stringify(outcome)).not.toContain('secret')
    }
  )

  it.each([
    [new AuthenticationError(401, undefined, 'bad key', new Headers()), 'KeyRejected', 401],
    [new RateLimitError(429, undefined, 'slow down', new Headers()), 'RateLimited', 429],
    [new OverloadedError(529, undefined, 'overloaded', new Headers()), 'Overloaded', 529],
    [new APIConnectionError({ message: 'offline' }), 'Unreachable', null],
    [new BadRequestError(400, undefined, 'bad', new Headers()), 'Failed', 400],
  ] as const)('should fail a turn the SDK threw %s at as %s', async (thrown, kind, status) => {
    const stub = stubClaude({ replies: [failingReply(thrown)] })

    expect(await runTurn(stub).outcome).toEqual(
      Exit.fail(ClaudeRequestFailed.make({ kind, status }))
    )
  })

  it('should abort the stream when the turn is interrupted', async () => {
    const reply = heldReply()
    const stub = stubClaude({ replies: [reply] })
    const deltas: Turn.Delta[] = []

    const fiber = Effect.runFork(
      Turn.run({ chat: asked, model: sonnet, patient }, (delta) => deltas.push(delta)).pipe(
        Effect.provide(Layer.merge(stub.layer, utc))
      )
    )
    reply.send(textDelta('Half'))
    await vi.waitFor(() => {
      expect(deltas).toHaveLength(1)
    })
    const exit = await Effect.runPromise(Fiber.interrupt(fiber))

    expect(reply.aborted()).toBe(true)
    expect(Exit.isInterrupted(exit)).toBe(true)
    expect(deltas).toEqual([{ kind: 'text', text: 'Half' }])
  })

  it("should send the chat's request messages under its style's system prompt", async () => {
    const academic = Chat.append(Chat.start('academic'), Chat.questionOf('Case?'))
    const stub = stubClaude({
      replies: [
        scriptedReply([], messageOf({ content: [textBlock('Case.')], stopReason: 'end_turn' })),
      ],
    })

    await runTurn(stub, { chat: academic, model: sonnet, patient }).outcome

    expect(stub.requests[0]?.messages).toEqual(Chat.requestMessagesOf(academic))
    expect(stub.requests[0]?.system).toContain(Style.voiceOf('academic'))
    expect(stub.requests[0]?.system).toContain("Today's date is")
  })
})

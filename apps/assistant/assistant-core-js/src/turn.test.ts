import {
  APIConnectionError,
  AuthenticationError,
  BadRequestError,
  OverloadedError,
  RateLimitError,
} from '@anthropic-ai/sdk'
import type { BetaStopReason } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Scope } from '@wildflowerhealthio/scopes-core'
import { DateTime, Deferred, Effect, Exit, Fiber, Layer, Option } from 'effect'
import { describe, expect, it, vi } from 'vite-plus/test'

import type * as ChatPatient from './chat-patient.ts'
import * as Chat from './chat.ts'
import type * as ClaudeModel from './claude-model.ts'
import { ClaudeRequestFailed } from './claude.ts'
import * as RecordAccess from './record-access.ts'
import * as Style from './style.ts'
import {
  failingReply,
  heldReply,
  messageOf,
  scriptedReply,
  searchBundleOf,
  type StubClaude,
  stubClaude,
  type StubFhirRecords,
  stubFhirRecords,
  textBlock,
  textDelta,
  thinkingBlock,
  thinkingDelta,
  toolUseBlock,
} from './test-helpers.ts'
import * as Tools from './tools.ts'
import * as Turn from './turn.ts'

const sonnet: ClaudeModel.Type = {
  id: 'claude-sonnet-5',
  displayName: 'Claude Sonnet 5',
  createdAt: DateTime.unsafeMake('2026-05-01T00:00:00Z'),
  adaptiveThinking: true,
}
const patient: ChatPatient.Type = { kind: 'all-patients' }
const recordAccess = RecordAccess.fromGrantedScopes([Scope.parse('system/*.cruds')])
const asked = Chat.append(Chat.start('telehealth'), Chat.questionOf('How are my labs?'))
const utc = DateTime.layerCurrentZone(DateTime.zoneUnsafeMakeNamed('UTC'))
const askedRequest: Turn.TurnRequest = { chat: asked, model: sonnet, patient, recordAccess }

/** A turn's run, and what it reported. */
interface TurnRun {
  readonly deltas: Turn.Delta[]
  readonly toolRounds: (readonly [Chat.Entry, Chat.Entry])[]
  readonly outcome: Promise<Exit.Exit<Chat.Entry, ClaudeRequestFailed | Turn.UnexpectedStop>>
}

/** Run a turn of `request` against `stub` and `fhir`, collecting what it reports. */
const runTurn = (
  stub: StubClaude,
  request: Turn.TurnRequest = askedRequest,
  fhir: StubFhirRecords = stubFhirRecords({})
): TurnRun => {
  const deltas: Turn.Delta[] = []
  const toolRounds: (readonly [Chat.Entry, Chat.Entry])[] = []
  const outcome = Effect.runPromiseExit(
    Turn.run(request, {
      delta: (delta) => deltas.push(delta),
      toolRound: (round) => toolRounds.push(round),
    }).pipe(Effect.provide(Layer.mergeAll(stub.layer, fhir.layer, utc)))
  )
  return { deltas, toolRounds, outcome }
}

describe('Turn.paramsOf', () => {
  const today = DateTime.unsafeMakeZoned('2026-11-08T12:00:00Z', { timeZone: 'UTC' })

  it("should ask for summarized adaptive thinking, the chat's tools, caching and default fallbacks", () => {
    expect(Turn.paramsOf(askedRequest, today)).toEqual({
      model: 'claude-sonnet-5',
      max_tokens: 64000,
      system: Style.systemPromptOf({ style: 'telehealth', patient, today, recordAccess }),
      messages: [{ role: 'user', content: 'How are my labs?' }],
      tools: Tools.make({ access: recordAccess, patient }).definitions,
      cache_control: { type: 'ephemeral' },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive', display: 'summarized' },
    })
  })

  it('should leave thinking out for a model without adaptive thinking', () => {
    const params = Turn.paramsOf(
      { ...askedRequest, model: { ...sonnet, adaptiveThinking: false } },
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
    'should fail naming the stop reason %s, with no tool call to run',
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
      Turn.run(askedRequest, {
        delta: (delta) => deltas.push(delta),
        toolRound: () => undefined,
      }).pipe(Effect.provide(Layer.mergeAll(stub.layer, stubFhirRecords({}).layer, utc)))
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

    await runTurn(stub, { ...askedRequest, chat: academic }).outcome

    expect(stub.requests[0]?.messages).toEqual(Chat.requestMessagesOf(academic))
    expect(stub.requests[0]?.system).toContain(Style.voiceOf('academic'))
    expect(stub.requests[0]?.system).toContain("Today's date is")
  })
})

describe('Turn.run with tools', () => {
  const ada: ChatPatient.Type = {
    kind: 'patient',
    patientId: 'p1',
    name: 'Ada Lovelace',
    birthDate: Option.none(),
  }
  const adaRequest: Turn.TurnRequest = { ...askedRequest, patient: ada }
  const searchCall = toolUseBlock('call-1', 'search_records', {
    resourceType: 'Observation',
    params: [{ name: 'code', value: '4548-4' }],
  })
  const readCall = toolUseBlock('call-2', 'read_record', {
    resourceType: 'Practitioner',
    id: 'dr1',
  })
  const a1c = { resourceType: 'Observation', id: 'o1', subject: { reference: 'Patient/p1' } }
  const doctor = { resourceType: 'Practitioner', id: 'dr1' }

  it('should run parallel calls side by side, send their results in one message, and stream on to the answer', async () => {
    // The search answers only once the read has started: run one after the
    // other, the search would wait for ever.
    const readStarted = Effect.runSync(Deferred.make<void>())
    const fhir = stubFhirRecords({
      'Observation?': Deferred.await(readStarted).pipe(
        Effect.as(searchBundleOf([a1c])),
        Effect.timeout('1 second'),
        Effect.orDie
      ),
      'Practitioner/dr1': Deferred.succeed(readStarted, undefined).pipe(Effect.as(doctor)),
    })
    const callingContent = [textBlock('Let me look.'), searchCall, readCall]
    const answerContent = [textBlock('Your A1c was read by Dr Who.')]
    const stub = stubClaude({
      replies: [
        scriptedReply(
          [textDelta('Let me look.')],
          messageOf({ content: callingContent, stopReason: 'tool_use' })
        ),
        scriptedReply(
          [textDelta('Your A1c was read by Dr Who.')],
          messageOf({ content: answerContent, stopReason: 'end_turn' })
        ),
      ],
    })

    const { toolRounds, deltas, outcome } = runTurn(stub, adaRequest, fhir)

    const callingReply: Chat.Entry = {
      _tag: 'reply',
      model: 'claude-sonnet-5',
      stopReason: 'tool_use',
      message: { role: 'assistant', content: callingContent },
    }
    const results: Chat.Entry = {
      _tag: 'tool-results',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            content: JSON.stringify({ resources: [a1c], more: false }),
          },
          { type: 'tool_result', tool_use_id: 'call-2', content: JSON.stringify(doctor) },
        ],
      },
    }
    expect(await outcome).toEqual(
      Exit.succeed({
        _tag: 'reply',
        model: 'claude-sonnet-5',
        stopReason: 'end_turn',
        message: { role: 'assistant', content: answerContent },
      })
    )
    expect(toolRounds).toEqual([[callingReply, results]])
    expect(fhir.readPaths.toSorted()).toEqual([
      'Observation?code=4548-4&patient=p1&_count=20',
      'Practitioner/dr1',
    ])
    expect(deltas.map(({ text }) => text)).toEqual(['Let me look.', 'Your A1c was read by Dr Who.'])
    expect(stub.requests[1]?.messages).toEqual(
      Chat.requestMessagesOf(Chat.append(Chat.append(asked, callingReply), results))
    )
    expect(stub.requests[1]?.tools).toEqual(stub.requests[0]?.tools)
    expect(stub.requests[1]?.system).toEqual(stub.requests[0]?.system)
  })

  it('should send a failed call back as an error result and carry on', async () => {
    const stub = stubClaude({
      replies: [
        scriptedReply([], messageOf({ content: [searchCall], stopReason: 'tool_use' })),
        scriptedReply([], messageOf({ content: [textBlock('Sorry.')], stopReason: 'end_turn' })),
      ],
    })

    const { toolRounds, outcome } = runTurn(stub, adaRequest)

    expect(Exit.isSuccess(await outcome)).toBe(true)
    expect(toolRounds[0]?.[1]).toEqual({
      _tag: 'tool-results',
      message: {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'call-1',
            is_error: true,
            content: 'The FHIR server answered 404.',
          },
        ],
      },
    })
  })

  it('should not run a tool call cut off at max_tokens, failing instead', async () => {
    const fhir = stubFhirRecords({})
    const stub = stubClaude({
      replies: [scriptedReply([], messageOf({ content: [searchCall], stopReason: 'max_tokens' }))],
    })

    const { toolRounds, outcome } = runTurn(stub, adaRequest, fhir)

    expect(await outcome).toEqual(Exit.fail(Turn.UnexpectedStop.make({ stopReason: 'max_tokens' })))
    expect(fhir.readPaths).toEqual([])
    expect(toolRounds).toEqual([])
  })
})

import {
  APIConnectionError,
  AuthenticationError,
  BadRequestError,
  OverloadedError,
  RateLimitError,
} from '@anthropic-ai/sdk'
import type { BetaStopReason } from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Scope } from '@wildflowerhealthio/scopes-core'
import type { Array } from 'effect'
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
  type HeldReply,
  heldReply,
  messageOf,
  onePatientChat,
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
import type * as WriteProposal from './write-proposal.ts'

const sonnet: ClaudeModel.Type = {
  id: 'claude-sonnet-5',
  displayName: 'Claude Sonnet 5',
  createdAt: DateTime.unsafeMake('2026-05-01T00:00:00Z'),
  supportsAdaptiveThinking: true,
}
const patient: ChatPatient.Type = { kind: 'all-patients' }
const recordAccess = RecordAccess.fromGrantedScopes([Scope.parse('system/*.cruds')])
const asked = Chat.append(Chat.start('telehealth'), Chat.questionOf('How are my labs?'))
const utc = DateTime.layerCurrentZone(DateTime.zoneUnsafeMakeNamed('UTC'))
const askedRequest: Turn.Request = { chat: asked, model: sonnet, patient, recordAccess }

/** A turn's run, and what it reported. */
interface TurnRun {
  readonly deltas: Turn.Delta[]
  readonly toolRounds: Chat.ToolRound[]
  /** Each round's writes, as the turn asked for decisions on them. */
  readonly proposedWrites: Turn.ProposedWrites[]
  readonly outcome: Promise<Exit.Exit<Chat.Entry, Turn.Failure>>
}

/** A `confirmWrites` for a turn that should propose none. */
const proposesNoWrites: Turn.Report['confirmWrites'] = () =>
  Effect.dieMessage('This turn proposes no writes')

/**
 * Run a turn of `request` against `stub` and `fhir`, collecting what it
 * reports, deciding on proposed writes with `decide`.
 */
const runTurn = (
  stub: StubClaude,
  request: Turn.Request = askedRequest,
  fhir: StubFhirRecords = stubFhirRecords({}),
  decide: Turn.Report['confirmWrites'] = proposesNoWrites
): TurnRun => {
  const deltas: Turn.Delta[] = []
  const toolRounds: Chat.ToolRound[] = []
  const proposedWrites: Turn.ProposedWrites[] = []
  const outcome = Effect.runPromiseExit(
    Turn.run(request, {
      delta: (delta) => deltas.push(delta),
      toolRound: (round) => toolRounds.push(round),
      confirmWrites: (proposed) => {
        proposedWrites.push(proposed)
        return decide(proposed)
      },
    }).pipe(Effect.provide(Layer.mergeAll(stub.layer, fhir.layer, utc)))
  )
  return { deltas, toolRounds, proposedWrites, outcome }
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
      { ...askedRequest, model: { ...sonnet, supportsAdaptiveThinking: false } },
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
        modelId: 'claude-sonnet-5',
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
      Exit.succeed({ _tag: 'refusal', modelId: 'claude-sonnet-5' })
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
    [new AuthenticationError(401, undefined, 'bad key', new Headers()), 'key-rejected', 401],
    [new RateLimitError(429, undefined, 'slow down', new Headers()), 'rate-limited', 429],
    [new OverloadedError(529, undefined, 'overloaded', new Headers()), 'overloaded', 529],
    [new APIConnectionError({ message: 'offline' }), 'unreachable', null],
    [new BadRequestError(400, undefined, 'bad', new Headers()), 'api-error', 400],
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
        confirmWrites: proposesNoWrites,
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
  const ada = onePatientChat({ id: 'p1', given: 'Ada', family: 'Lovelace' })
  const adaRequest: Turn.Request = { ...askedRequest, patient: ada }
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

    const round: Chat.ToolRound = {
      _tag: 'tool-round',
      modelId: 'claude-sonnet-5',
      message: { role: 'assistant', content: callingContent },
      results: [
        {
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: JSON.stringify({ resources: [a1c], more: false }),
        },
        { type: 'tool_result', tool_use_id: 'call-2', content: JSON.stringify(doctor) },
      ],
    }
    expect(await outcome).toEqual(
      Exit.succeed({
        _tag: 'reply',
        modelId: 'claude-sonnet-5',
        stopReason: 'end_turn',
        message: { role: 'assistant', content: answerContent },
      })
    )
    expect(toolRounds).toEqual([round])
    expect(fhir.readPaths.toSorted()).toEqual([
      'Observation?code=4548-4&patient=p1&_count=20',
      'Practitioner/dr1',
    ])
    expect(deltas.map(({ text }) => text)).toEqual(['Let me look.', 'Your A1c was read by Dr Who.'])
    expect(stub.requests[1]?.messages).toEqual(Chat.requestMessagesOf(Chat.append(asked, round)))
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
    expect(toolRounds[0]?.results).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 'call-1',
        is_error: true,
        content: 'The FHIR server answered 404.',
      },
    ])
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

describe('Turn.run with writes', () => {
  const ada = onePatientChat({ id: 'p1', given: 'Ada', family: 'Lovelace' })
  const adaRequest: Turn.Request = { ...askedRequest, patient: ada }
  const weight = {
    resourceType: 'Observation',
    status: 'final',
    code: { text: 'Weight' },
    subject: { reference: 'Patient/p1' },
  }
  const createCall = (id: string): ReturnType<typeof toolUseBlock> =>
    toolUseBlock(id, 'create_record', { resource: weight })
  const readCall = toolUseBlock('read', 'read_record', { resourceType: 'Practitioner', id: 'dr1' })
  const doctor = { resourceType: 'Practitioner', id: 'dr1' }
  /** The reply that ends the turn once the round's results are in. */
  const answered = (): HeldReply =>
    scriptedReply([], messageOf({ content: [textBlock('Saved.')], stopReason: 'end_turn' }))

  it('should pause on two writes and a read until both are decided, then send every result in one message, once', async () => {
    const decided = Effect.runSync(
      Deferred.make<Array.NonEmptyReadonlyArray<WriteProposal.Decision>>()
    )
    const fhir = stubFhirRecords({ 'Practitioner/dr1': Effect.succeed(doctor) })
    const content = [createCall('first'), readCall, createCall('second')]
    const stub = stubClaude({
      replies: [scriptedReply([], messageOf({ content, stopReason: 'tool_use' })), answered()],
    })

    const { proposedWrites, toolRounds, outcome } = runTurn(stub, adaRequest, fhir, () =>
      Deferred.await(decided)
    )

    await vi.waitFor(() => {
      expect(proposedWrites).toHaveLength(1)
    })
    expect(proposedWrites[0]).toEqual({
      message: { role: 'assistant', content },
      results: new Map([
        ['read', { type: 'tool_result', tool_use_id: 'read', content: JSON.stringify(doctor) }],
      ]),
      proposals: [
        { kind: 'create', callId: 'first', resource: weight },
        { kind: 'create', callId: 'second', resource: weight },
      ],
    })
    expect(stub.requests).toHaveLength(1)
    expect(fhir.writes).toEqual([])

    Effect.runSync(
      Deferred.succeed(decided, [
        { kind: 'approved' },
        { kind: 'declined', reason: Option.some('Already weighed today') },
      ])
    )

    expect(Exit.isSuccess(await outcome)).toBe(true)
    expect(fhir.writes).toEqual([{ kind: 'create', resource: weight }])
    expect(toolRounds).toHaveLength(1)
    expect(toolRounds[0]?.results.map(({ tool_use_id }) => tool_use_id)).toEqual([
      'first',
      'read',
      'second',
    ])
    expect(toolRounds[0]?.results[2]).toEqual({
      type: 'tool_result',
      tool_use_id: 'second',
      is_error: true,
      content: 'The user declined this change. Reason: Already weighed today',
    })
    expect(stub.requests).toHaveLength(2)
    expect(stub.requests[1]?.messages.at(-1)).toEqual({
      role: 'user',
      content: toolRounds[0]?.results,
    })
  })

  it('should send a write refused before it was proposed straight back, asking nothing', async () => {
    const stub = stubClaude({
      replies: [
        scriptedReply(
          [],
          messageOf({
            content: [
              toolUseBlock('update', 'update_record', {
                resource: { ...weight, id: 'o1' },
              }),
            ],
            stopReason: 'tool_use',
          })
        ),
        answered(),
      ],
    })

    const { proposedWrites, toolRounds, outcome } = runTurn(stub, adaRequest)

    expect(Exit.isSuccess(await outcome)).toBe(true)
    expect(proposedWrites).toEqual([])
    expect(toolRounds[0]?.results[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 'update',
      is_error: true,
      content:
        "Observation/o1 hasn't been read in this chat, so the version to change isn't known. Read it with read_record first.",
    })
  })

  it('should keep nothing and write nothing when the turn is stopped while a write waits', async () => {
    const fhir = stubFhirRecords({})
    const stub = stubClaude({
      replies: [
        scriptedReply([], messageOf({ content: [createCall('first')], stopReason: 'tool_use' })),
      ],
    })
    const toolRounds: Chat.ToolRound[] = []
    const asking = Effect.runSync(Deferred.make<void>())

    const fiber = Effect.runFork(
      Turn.run(adaRequest, {
        delta: () => undefined,
        toolRound: (round) => toolRounds.push(round),
        confirmWrites: () =>
          Deferred.succeed(asking, undefined).pipe(Effect.zipRight(Effect.never)),
      }).pipe(Effect.provide(Layer.mergeAll(stub.layer, fhir.layer, utc)))
    )
    await Effect.runPromise(Deferred.await(asking))
    const exit = await Effect.runPromise(Fiber.interrupt(fiber))

    expect(Exit.isInterrupted(exit)).toBe(true)
    expect(toolRounds).toEqual([])
    expect(fhir.writes).toEqual([])
    expect(stub.requests).toHaveLength(1)
  })
})

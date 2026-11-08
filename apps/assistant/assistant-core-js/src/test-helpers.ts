/**
 * Stand-ins for this package's tests and, through the
 * `assistant-core-js/test-helpers` subpath, its consumers': a page whose
 * storage is in memory, a Claude client that answers without the network,
 * a FHIR server that answers from a table, and the SDK shapes a reply
 * streams.
 *
 * @packageDocumentation
 */
import { APIUserAbortError } from '@anthropic-ai/sdk'
import type {
  BetaContentBlock,
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
  BetaStopReason,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { hasId, Patient } from '@wildflowerhealthio/fhir-r4/resources'
import { Effect, Layer, Option, Schema } from 'effect'

import type * as ChatPatient from './chat-patient.ts'
import { Claude, type ClaudeClient, type ClaudeMessageStream } from './claude.ts'
import { FhirReadFailed, FhirRecords } from './fhir-records.ts'
import type { KeptStorage, StoragePage } from './internal/page-storage.ts'

/** A storage call a blocked browser refuses. */
type StorageCall = 'getItem' | 'setItem' | 'removeItem'

/** A `Map`-backed storage whose calls named in `refusing` throw as a blocked browser's do. */
const memoryStorage = (
  refusing: readonly StorageCall[] = []
): KeptStorage & {
  readonly items: Map<string, string>
} => {
  const items = new Map<string, string>()
  const refuseIf = (call: StorageCall): void => {
    if (refusing.includes(call)) {
      throw new DOMException('The operation is insecure.', 'SecurityError')
    }
  }
  return {
    items,
    getItem: (key) => {
      refuseIf('getItem')
      return items.get(key) ?? null
    },
    setItem: (key, value) => {
      refuseIf('setItem')
      items.set(key, value)
    },
    removeItem: (key) => {
      refuseIf('removeItem')
      items.delete(key)
    },
  }
}

/** A page with in-memory `localStorage` and `sessionStorage`, both refusing `refusing`. */
const memoryStoragePage = (
  refusing: readonly StorageCall[] = []
): StoragePage & {
  readonly localStorage: ReturnType<typeof memoryStorage>
  readonly sessionStorage: ReturnType<typeof memoryStorage>
} => ({ localStorage: memoryStorage(refusing), sessionStorage: memoryStorage(refusing) })

/** A page whose storage throws on the property read itself, as some blocked browsers do. */
const blockedStoragePage = (): StoragePage => ({
  get localStorage(): KeptStorage {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  },
  get sessionStorage(): KeptStorage {
    throw new DOMException('The operation is insecure.', 'SecurityError')
  },
})

/**
 * A chat about the one patient `id`, whose `Patient` record carries the
 * name `given family` and `birthDate` when given.
 */
const onePatientChat = ({
  id,
  given,
  family,
  birthDate,
}: {
  readonly id: string
  readonly given?: string
  readonly family?: string
  readonly birthDate?: string
}): ChatPatient.Type => {
  const patient = Schema.decodeUnknownSync(Patient.Schema)({
    resourceType: 'Patient',
    id,
    ...(given === undefined && family === undefined
      ? {}
      : {
          name: [
            {
              ...(given === undefined ? {} : { given: [given] }),
              ...(family === undefined ? {} : { family }),
            },
          ],
        }),
    ...(birthDate === undefined ? {} : { birthDate }),
  })
  if (!hasId(patient)) throw new Error('A decoded Patient with an id has one')
  return { kind: 'patient', patient }
}

/** A listed model as `GET /v1/models` gives it, with the fields Assistant reads. */
const modelInfoOf = ({
  id,
  displayName = id,
  createdAt,
  adaptiveThinking = true,
}: {
  readonly id: string
  readonly displayName?: string
  readonly createdAt: string
  /** Whether the capabilities say adaptive thinking is supported; `null` for no capabilities. */
  readonly adaptiveThinking?: boolean | null
}): unknown => ({
  type: 'model',
  id,
  display_name: displayName,
  created_at: createdAt,
  capabilities:
    adaptiveThinking === null
      ? null
      : { thinking: { supported: true, types: { adaptive: { supported: adaptiveThinking } } } },
})

/**
 * A reply the test hands the client piece by piece: each event when it
 * calls `send`, then the final message at `finish`, or a throw at `fail`.
 * Aborting the request's signal ends the stream as the SDK's does.
 */
interface HeldReply {
  readonly send: (event: BetaRawMessageStreamEvent) => void
  readonly finish: (message: BetaMessage) => void
  readonly fail: (thrown: unknown) => void
  /** Whether the request's signal was aborted. */
  readonly aborted: () => boolean
  /** The stream the stub client returns for this reply. */
  readonly streamFor: (signal: AbortSignal | null | undefined) => ClaudeMessageStream
}

/** A {@link HeldReply} that nothing has been sent on yet. */
const heldReply = (): HeldReply => {
  const queued: Array<{ kind: 'event'; event: BetaRawMessageStreamEvent } | { kind: 'end' }> = []
  let wake: (() => void) | null = null
  let failure: { readonly thrown: unknown } | null = null
  let aborted = false
  const finalMessage = Promise.withResolvers<BetaMessage>()
  // Read only through `finalMessage()`; a rejection nobody awaited is not a test failure.
  finalMessage.promise.catch(() => undefined)
  const notify = (): void => {
    wake?.()
    wake = null
  }
  const fail = (thrown: unknown): void => {
    failure = { thrown }
    finalMessage.reject(thrown)
    notify()
  }
  return {
    send: (event) => {
      queued.push({ kind: 'event', event })
      notify()
    },
    finish: (message) => {
      queued.push({ kind: 'end' })
      finalMessage.resolve(message)
      notify()
    },
    fail,
    aborted: () => aborted,
    streamFor: (signal) => {
      signal?.addEventListener('abort', () => {
        aborted = true
        fail(new APIUserAbortError())
      })
      const next = async (): Promise<IteratorResult<BetaRawMessageStreamEvent>> => {
        if (failure !== null) throw failure.thrown
        const queuedNext = queued.shift()
        if (queuedNext === undefined) {
          await new Promise<void>((resolve) => {
            wake = resolve
          })
          return next()
        }
        return queuedNext.kind === 'end'
          ? { done: true, value: undefined }
          : { done: false, value: queuedNext.event }
      }
      return {
        finalMessage: () => finalMessage.promise,
        [Symbol.asyncIterator]: () => ({ next }),
      }
    },
  }
}

/** A {@link HeldReply} with `events` and then `message` already sent. */
const scriptedReply = (
  events: readonly BetaRawMessageStreamEvent[],
  message: BetaMessage
): HeldReply => {
  const reply = heldReply()
  for (const event of events) reply.send(event)
  reply.finish(message)
  return reply
}

/** A {@link HeldReply} that fails with `thrown` before any event. */
const failingReply = (thrown: unknown): HeldReply => {
  const reply = heldReply()
  reply.fail(thrown)
  return reply
}

/** A stub client, and every request it was asked to stream. */
interface StubClaude {
  readonly client: ClaudeClient
  /** The {@link Claude} layer providing `client`. */
  readonly layer: Layer.Layer<Claude>
  readonly requests: BetaMessageStreamParams[]
}

/**
 * A client that lists `models` (or throws `modelsThrow` when listing) and
 * answers each streamed request with the next of `replies`, in order.
 */
const stubClaude = ({
  models = [],
  modelsThrow,
  replies = [],
}: {
  readonly models?: readonly unknown[]
  readonly modelsThrow?: unknown
  readonly replies?: readonly HeldReply[]
}): StubClaude => {
  const requests: BetaMessageStreamParams[] = []
  const pending = [...replies]
  const client: ClaudeClient = {
    models: {
      list: () => ({
        async *[Symbol.asyncIterator]() {
          if (modelsThrow !== undefined) throw modelsThrow
          yield* models
        },
      }),
    },
    beta: {
      messages: {
        stream: (params, options) => {
          requests.push(params)
          const reply = pending.shift()
          if (reply === undefined) throw new Error('The stub client has no reply left to stream')
          return reply.streamFor(options?.signal)
        },
      },
    },
  }
  return { client, layer: Layer.succeed(Claude, client), requests }
}

/** The event carrying `text` as answer text. */
const textDelta = (text: string): BetaRawMessageStreamEvent => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'text_delta', text },
})

/** The event carrying `thinking` as summarized thinking. */
const thinkingDelta = (thinking: string): BetaRawMessageStreamEvent => ({
  type: 'content_block_delta',
  index: 0,
  delta: { type: 'thinking_delta', thinking, estimated_tokens: null },
})

/** A text block. */
const textBlock = (text: string): BetaContentBlock => ({ type: 'text', text, citations: null })

/** A summarized thinking block. */
const thinkingBlock = (thinking: string, signature = 'sig'): BetaContentBlock => ({
  type: 'thinking',
  thinking,
  signature,
})

/** A tool call block: `name` called with `input`, as call `id`. */
const toolUseBlock = (id: string, name: string, input: unknown): BetaContentBlock => ({
  type: 'tool_use',
  id,
  name,
  input,
})

/** The FHIR base a {@link stubFhirRecords} server is at. */
const STUB_FHIR_BASE = 'https://fhir.example/r4'

/** A stub FHIR server, and every path it was asked to read, in order. */
interface StubFhirRecords {
  /** The {@link FhirRecords} layer reading from it. */
  readonly layer: Layer.Layer<FhirRecords>
  readonly readPaths: string[]
}

/**
 * A FHIR server at {@link STUB_FHIR_BASE} answering each read with the
 * answer whose key is the longest prefix of its path; a path no key matches
 * fails as a 404. Answers are Effects, so a test can hold one back.
 */
const stubFhirRecords = (
  answers: Readonly<Record<string, Effect.Effect<unknown, FhirReadFailed>>>,
  fhirBaseUrl: string = STUB_FHIR_BASE
): StubFhirRecords => {
  const readPaths: string[] = []
  const keys = Object.keys(answers).toSorted((left, right) => right.length - left.length)
  const read = (path: string): Effect.Effect<unknown, FhirReadFailed> =>
    Effect.suspend(() => {
      readPaths.push(path)
      const key = keys.find((each) => path.startsWith(each))
      const answer = key === undefined ? undefined : answers[key]
      return (
        answer ??
        Effect.fail(
          new FhirReadFailed({
            failure: { kind: 'error-status', status: 404, outcomeText: Option.none() },
          })
        )
      )
    })
  return { layer: Layer.succeed(FhirRecords, { fhirBaseUrl, read }), readPaths }
}

/** The server failing a read with `status`, its `OperationOutcome` saying `outcomeText` when given. */
const fhirFailure = (status: number, outcomeText?: string): Effect.Effect<never, FhirReadFailed> =>
  Effect.fail(
    new FhirReadFailed({
      failure: { kind: 'error-status', status, outcomeText: Option.fromNullable(outcomeText) },
    })
  )

/** A search-result bundle of `resources`, with `total` and a `next` link when given. */
const searchBundleOf = (
  resources: readonly unknown[],
  { total, nextUrl }: { readonly total?: number; readonly nextUrl?: string } = {}
): unknown => ({
  resourceType: 'Bundle',
  type: 'searchset',
  ...(total === undefined ? {} : { total }),
  entry: resources.map((resource) => ({ resource })),
  link: nextUrl === undefined ? [] : [{ relation: 'next', url: nextUrl }],
})

/** A whole message from `model` with `content`, stopped for `stopReason`. */
const messageOf = ({
  model = 'claude-sonnet-5',
  content,
  stopReason,
}: {
  readonly model?: string
  readonly content: readonly BetaContentBlock[]
  readonly stopReason: BetaStopReason | null
}): BetaMessage => ({
  id: 'msg_test',
  type: 'message',
  role: 'assistant',
  model,
  content: [...content],
  container: null,
  context_management: null,
  diagnostics: null,
  stop_details: null,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: {
    cache_creation: null,
    cache_creation_input_tokens: null,
    cache_read_input_tokens: null,
    fallback_credit: null,
    inference_geo: null,
    input_tokens: 1,
    iterations: null,
    output_tokens: 1,
    output_tokens_details: null,
    server_tool_use: null,
    service_tier: null,
    speed: null,
  },
})

export {
  STUB_FHIR_BASE,
  blockedStoragePage,
  failingReply,
  fhirFailure,
  heldReply,
  memoryStorage,
  memoryStoragePage,
  messageOf,
  modelInfoOf,
  onePatientChat,
  scriptedReply,
  searchBundleOf,
  stubClaude,
  stubFhirRecords,
  textBlock,
  textDelta,
  thinkingBlock,
  thinkingDelta,
  toolUseBlock,
}
export type { HeldReply, StorageCall, StubClaude, StubFhirRecords }

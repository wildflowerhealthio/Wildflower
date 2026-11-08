import Anthropic, {
  APIConnectionError,
  APIConnectionTimeoutError,
  AuthenticationError,
  BadRequestError,
  InternalServerError,
  OverloadedError,
  RateLimitError,
} from '@anthropic-ai/sdk'
import { Effect, Option } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import * as ApiKey from './api-key.ts'
import { Claude, ClaudeRequestFailed } from './claude.ts'

const headers = new Headers()

describe('ClaudeRequestFailed.fromThrown', () => {
  it.each([
    [
      'AuthenticationError',
      new AuthenticationError(401, undefined, 'no', headers),
      { kind: 'key-rejected', status: 401 },
    ],
    [
      'RateLimitError',
      new RateLimitError(429, undefined, 'slow', headers),
      { kind: 'rate-limited', status: 429 },
    ],
    [
      'OverloadedError',
      new OverloadedError(529, undefined, 'busy', headers),
      { kind: 'overloaded', status: 529 },
    ],
    [
      'APIConnectionError',
      new APIConnectionError({ message: 'offline' }),
      { kind: 'unreachable', status: null },
    ],
    [
      'APIConnectionTimeoutError',
      new APIConnectionTimeoutError(),
      { kind: 'unreachable', status: null },
    ],
    [
      'InternalServerError',
      new InternalServerError(500, undefined, 'oops', headers),
      { kind: 'api-error', status: 500 },
    ],
    [
      'BadRequestError',
      new BadRequestError(400, undefined, 'bad', headers),
      { kind: 'api-error', status: 400 },
    ],
    ['a thrown non-SDK error', new TypeError('boom'), { kind: 'unexpected-error', status: null }],
  ] as const)('should map %s by its class', (_name, thrown, expected) => {
    expect(ClaudeRequestFailed.fromThrown(thrown)).toEqual(ClaudeRequestFailed.make(expected))
  })

  it("should carry neither the SDK error's message nor anything else it held", () => {
    const failure = ClaudeRequestFailed.fromThrown(
      new AuthenticationError(401, { secret: 'model text' }, 'model text', headers)
    )

    expect(JSON.stringify(failure)).not.toContain('model text')
    expect(failure.message).not.toContain('model text')
  })
})

describe('Claude.layerForApiKey', () => {
  it("should build an SDK client on the person's key, sending no trace context and tracing no content", () => {
    const apiKey = Option.getOrThrow(ApiKey.fromInput('sk-ant-person'))

    const client = Effect.runSync(Claude.pipe(Effect.provide(Claude.layerForApiKey(apiKey))))

    expect(client).toBeInstanceOf(Anthropic)
    if (!(client instanceof Anthropic)) return
    expect(client.apiKey).toBe('sk-ant-person')
    expect(client.openTelemetry).toMatchObject({
      propagation: false,
      traces: { contentMode: 'metadata_only' },
    })
  })
})

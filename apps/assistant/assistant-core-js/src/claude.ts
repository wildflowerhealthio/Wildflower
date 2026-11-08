import Anthropic, {
  APIConnectionError,
  APIError,
  AuthenticationError,
  OverloadedError,
  RateLimitError,
} from '@anthropic-ai/sdk'
import type {
  BetaMessage,
  BetaMessageStreamParams,
  BetaRawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Context, Layer, Match, Redacted, Schema } from 'effect'

import type * as ApiKey from './api-key.ts'

/**
 * One streamed reply: its events as they arrive, then the whole message.
 * `@anthropic-ai/sdk`'s `BetaMessageStream` is one.
 */
interface ClaudeMessageStream extends AsyncIterable<BetaRawMessageStreamEvent> {
  finalMessage(): Promise<BetaMessage>
}

/**
 * The part of the `@anthropic-ai/sdk` client Assistant calls: the model list
 * and a streamed beta message. An `Anthropic` client is one; a test passes a
 * stand-in that answers without the network.
 *
 * @remarks
 * The listed models are taken as `unknown`: `ClaudeModel.list` decodes the
 * few fields it reads, so a listing is checked rather than trusted.
 */
interface ClaudeClient {
  readonly models: {
    list(params?: null, options?: Anthropic.RequestOptions): AsyncIterable<unknown>
  }
  readonly beta: {
    readonly messages: {
      stream(
        params: BetaMessageStreamParams,
        options?: Anthropic.RequestOptions
      ): ClaudeMessageStream
    }
  }
}

/**
 * The Claude API as the person's key reaches it, from the browser.
 * {@link Claude.layerForApiKey} builds the real client; a test provides a
 * stand-in {@link ClaudeClient} with `Layer.succeed`.
 */
class Claude extends Context.Tag('assistant-core-js/Claude')<Claude, ClaudeClient>() {
  /**
   * An `@anthropic-ai/sdk` client for `apiKey`, allowed to run in the
   * browser: the key is the person's own, and goes only to Anthropic.
   *
   * @remarks
   * Its OpenTelemetry spans carry metadata only, never the prompts or the
   * replies, and no trace context is sent to Anthropic's origin.
   */
  static readonly layerForApiKey = (apiKey: ApiKey.Type): Layer.Layer<Claude> =>
    Layer.sync(
      Claude,
      () =>
        new Anthropic({
          apiKey: Redacted.value(apiKey),
          dangerouslyAllowBrowser: true,
          openTelemetry: { propagation: false, traces: { contentMode: 'metadata_only' } },
        })
    )
}

/**
 * Why a call to the Claude API failed, by the SDK error class it threw:
 *
 * - `KeyRejected` — the API did not accept the key (`AuthenticationError`, 401);
 * - `RateLimited` — the key is over its rate limit (`RateLimitError`, 429);
 * - `Overloaded` — the API is overloaded (`OverloadedError`, 529);
 * - `Unreachable` — no answer came back (`APIConnectionError`, timeouts included);
 * - `Failed` — any other API error, with its status, or anything else thrown.
 */
const ClaudeFailureKind = Schema.Literal(
  'KeyRejected',
  'RateLimited',
  'Overloaded',
  'Unreachable',
  'Failed'
)

/**
 * A call to the Claude API that failed. It carries the kind of failure and
 * the HTTP status, never the SDK error's message or anything the model
 * wrote, so it can be thrown, logged and reported as it is.
 */
class ClaudeRequestFailed extends Schema.TaggedError<ClaudeRequestFailed>()('ClaudeRequestFailed', {
  kind: ClaudeFailureKind,
  /** The response's HTTP status; `null` when there was no response or no status. */
  status: Schema.NullOr(Schema.Int),
}) {
  /**
   * The failure `thrown` by an `@anthropic-ai/sdk` call, matched by error
   * class, the most specific first.
   */
  static readonly fromThrown = (thrown: unknown): ClaudeRequestFailed =>
    Match.value(thrown).pipe(
      Match.when(Match.instanceOf(AuthenticationError), ({ status }) =>
        ClaudeRequestFailed.make({ kind: 'KeyRejected', status })
      ),
      Match.when(Match.instanceOf(RateLimitError), ({ status }) =>
        ClaudeRequestFailed.make({ kind: 'RateLimited', status })
      ),
      Match.when(Match.instanceOf(OverloadedError), ({ status }) =>
        ClaudeRequestFailed.make({ kind: 'Overloaded', status })
      ),
      Match.when(Match.instanceOf(APIConnectionError), () =>
        ClaudeRequestFailed.make({ kind: 'Unreachable', status: null })
      ),
      Match.when(Match.instanceOf(APIError), ({ status }) =>
        ClaudeRequestFailed.make({ kind: 'Failed', status: status ?? null })
      ),
      Match.orElse(() => ClaudeRequestFailed.make({ kind: 'Failed', status: null }))
    )
}

export { Claude, ClaudeRequestFailed }
export type { ClaudeClient, ClaudeMessageStream }

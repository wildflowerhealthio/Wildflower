import type {
  BetaAssistantMessageParam,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaUserMessageParam,
} from '@anthropic-ai/sdk/resources/beta/messages/messages'
import { Predicate, Schema } from 'effect'

/**
 * Schemas for the `@anthropic-ai/sdk` message params a chat keeps: a user
 * message, an assistant message and a tool result.
 *
 * @remarks
 * A namespace module: `MessageParams.UserMessageSchema`,
 * `MessageParams.AssistantMessageSchema`, `MessageParams.ToolResultSchema`.
 * Each is a `Schema.declare` guard on the param's outline that asserts the
 * SDK's type: every block was written by this app from the SDK, and
 * mirroring the SDK's dozens of block types in schemas would drift from it.
 *
 * @packageDocumentation
 */

/**
 * Whether `value` has the outline of an `@anthropic-ai/sdk` message param
 * with `role`: string content, or an array of objects each naming its
 * block `type`.
 */
const isMessageParamWithRole =
  (role: BetaMessageParam['role']) =>
  (value: unknown): boolean =>
    Predicate.isRecord(value) &&
    value['role'] === role &&
    (Predicate.isString(value['content']) ||
      (globalThis.Array.isArray(value['content']) &&
        value['content'].every(
          (block: unknown) => Predicate.isRecord(block) && Predicate.isString(block['type'])
        )))

/**
 * A user message, as the SDK types it.
 *
 * @remarks
 * Checked only for its outline (role, and content that is a string or typed
 * blocks): the blocks are the SDK's dozens of types, every one written by
 * this app from what it sent or what the SDK returned, so the SDK's own
 * types are asserted rather than mirrored in schemas that would drift.
 */
const UserMessageSchema = Schema.declare(
  (value: unknown): value is BetaUserMessageParam => isMessageParamWithRole('user')(value),
  { identifier: 'BetaUserMessageParam' }
)

/** An assistant message, as the SDK types it; checked only for its outline, as {@link UserMessageSchema}. */
const AssistantMessageSchema = Schema.declare(
  (value: unknown): value is BetaAssistantMessageParam =>
    isMessageParamWithRole('assistant')(value),
  { identifier: 'BetaAssistantMessageParam' }
)

/**
 * A tool result, as the SDK types it; checked only for its outline (its
 * block type and the id of the call it answers), as {@link UserMessageSchema}.
 */
const ToolResultSchema = Schema.declare(
  (value: unknown): value is BetaToolResultBlockParam =>
    Predicate.isRecord(value) &&
    value['type'] === 'tool_result' &&
    Predicate.isString(value['tool_use_id']),
  { identifier: 'BetaToolResultBlockParam' }
)

export { AssistantMessageSchema, ToolResultSchema, UserMessageSchema }

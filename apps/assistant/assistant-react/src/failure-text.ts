import type { ClaudeRequestFailed, Turn } from '@wildflowerhealthio/assistant-core-js'
import { Match } from 'effect'

/** The line shown for a call to Claude that failed, by its kind. */
const claudeFailureText = (failure: ClaudeRequestFailed): string =>
  Match.value(failure.kind).pipe(
    Match.when('key-rejected', () => "This key wasn't accepted."),
    Match.when(
      'rate-limited',
      () => 'Your key is over its rate limit. Wait a moment, then try again.'
    ),
    Match.when('overloaded', () => 'Claude is overloaded right now. Try again in a moment.'),
    Match.when(
      'unreachable',
      () => "Couldn't reach Anthropic. Check your connection and try again."
    ),
    Match.when('api-error', () =>
      failure.status === null
        ? "Claude couldn't answer."
        : `Claude couldn't answer (error ${failure.status}).`
    ),
    Match.when('model-list-unreadable', () => "Anthropic's list of models couldn't be read."),
    Match.when('unexpected-error', () => "Claude couldn't answer."),
    Match.exhaustive
  )

/** The line shown for a turn that failed. */
const turnFailureText = (failure: Turn.Failure): string =>
  Match.value(failure).pipe(
    Match.tag('ClaudeRequestFailed', claudeFailureText),
    Match.tag('UnexpectedStop', ({ stopReason }) =>
      stopReason === 'max_tokens'
        ? 'Claude reached its output limit while asking to look something up, so the lookup didn’t run.'
        : `Claude stopped unexpectedly (${stopReason ?? 'no reason given'}).`
    ),
    Match.exhaustive
  )

export { claudeFailureText, turnFailureText }

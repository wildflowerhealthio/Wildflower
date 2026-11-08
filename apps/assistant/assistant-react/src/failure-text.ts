import type { ClaudeRequestFailed, Turn } from '@wildflowerhealthio/assistant-core-js'
import { Match } from 'effect'

/** The line shown for a call to Claude that failed, by its kind. */
const claudeFailureText = (failure: ClaudeRequestFailed): string =>
  Match.value(failure.kind).pipe(
    Match.when('KeyRejected', () => "This key wasn't accepted."),
    Match.when(
      'RateLimited',
      () => 'Your key is over its rate limit. Wait a moment, then try again.'
    ),
    Match.when('Overloaded', () => 'Claude is overloaded right now. Try again in a moment.'),
    Match.when(
      'Unreachable',
      () => "Couldn't reach Anthropic. Check your connection and try again."
    ),
    Match.when('Failed', () =>
      failure.status === null
        ? "Claude couldn't answer."
        : `Claude couldn't answer (error ${failure.status}).`
    ),
    Match.exhaustive
  )

/** The line shown for a turn that failed. */
const turnFailureText = (failure: ClaudeRequestFailed | Turn.UnexpectedStop): string =>
  Match.value(failure).pipe(
    Match.tag('ClaudeRequestFailed', claudeFailureText),
    Match.tag(
      'UnexpectedStop',
      ({ stopReason }) => `Claude stopped unexpectedly (${stopReason ?? 'no reason given'}).`
    ),
    Match.exhaustive
  )

export { claudeFailureText, turnFailureText }

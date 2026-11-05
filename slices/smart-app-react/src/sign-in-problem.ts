import type { SmartSupport } from '@wildflowerhealthio/fhir-r4-react/smart'
import { Match } from 'effect'

/**
 * The problem to show for signing in to `serverUrl` with the probe outcome
 * `support`, or `undefined` when there is none: `Smart`/`Open` redirect the
 * page away, so only `Unreachable` and `Unusable` are left to report.
 */
const signInProblem = (serverUrl: string, support: SmartSupport): string | undefined =>
  Match.value(support).pipe(
    Match.withReturnType<string | undefined>(),
    Match.tag(
      'Unreachable',
      ({ reason }) =>
        `Could not reach ${serverUrl}. Check the URL and that the server allows this app. (${reason})`
    ),
    Match.tag('Unusable', ({ reason }) => `Cannot sign in to ${serverUrl}. ${reason}`),
    Match.tag('Smart', 'Open', () => undefined),
    Match.exhaustive
  )

export { signInProblem }

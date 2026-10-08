import { Option } from 'effect'
import { HostCommandFailed, type HostCommandError } from 'servers-core'

/** The sentence a failed host command shows: the host's own message, when it ran. */
const failureText = (error: HostCommandError): string =>
  error instanceof HostCommandFailed
    ? error.refusal.pipe(
        Option.map((refusal) => refusal.message),
        Option.getOrElse(() => error.message)
      )
    : error.message

export { failureText }

import { NavigationBridge } from 'navigation-core'
import { Either, Schema } from 'effect'
import { Message } from 'effect-messaging-core'

const decodeEnvelope = Schema.decodeUnknownEither(Message.wireRoutingEnvelope)
const decodeNavigation = Schema.decodeEither(
  NavigationBridge.MessageSchemas.HostRequestedWebNavigation
)

/**
 * Find the path the host requested in the pre-injected initial messages.
 *
 * @returns The first `HostRequestedWebNavigation`'s path, or `'/'` when
 * none is present (e.g. standalone-web). Malformed envelopes are surfaced
 * via `console.warn`; entries with other tags are skipped — the bridge
 * replay fiber is the canonical decoder.
 */
const findInitialPath = (messages: ReadonlyArray<string>): string => {
  for (const entry of messages) {
    const envelopeResult = decodeEnvelope(entry)
    if (Either.isLeft(envelopeResult)) {
      console.warn(
        '[wildflower-react] dropping malformed initial message while seeking initial route',
        envelopeResult.left
      )
      continue
    }
    if (envelopeResult.right._tag !== 'HostRequestedWebNavigation') continue
    const navResult = decodeNavigation(entry)
    if (Either.isLeft(navResult)) {
      console.warn(
        '[wildflower-react] HostRequestedWebNavigation envelope failed payload decode',
        navResult.left
      )
      continue
    }
    return navResult.right.path
  }
  return '/'
}

export { findInitialPath }

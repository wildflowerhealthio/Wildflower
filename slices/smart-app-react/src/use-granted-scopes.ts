import { SmartRuntimeContext } from '@wildflowerhealthio/fhir-r4-react/smart'
import { useContextOrThrow } from '@wildflowerhealthio/react-kitchen-sink'
import type { Scope } from '@wildflowerhealthio/scopes-core'

/**
 * The scopes the page's sign-in was granted (`SmartConnection.grantedScopes`),
 * read off the runtime `SmartHandshakeGate` provides: what the Owner left
 * ticked on the consent card, which may be less than the app asked for.
 * Throws when no `SmartHandshakeGate` is above it.
 */
const useGrantedScopes = (): readonly Scope.Any[] =>
  useContextOrThrow(SmartRuntimeContext).connection.grantedScopes

export { useGrantedScopes }

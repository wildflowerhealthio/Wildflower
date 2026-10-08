import { Option, Schema } from 'effect'

import * as CertificateAuthority from './certificate-authority.ts'
import * as CertificateState from './certificate-state.ts'
import * as RunPolicy from './run-policy.ts'
import * as ServerStatus from './server-status.ts'

/** The relay a server's tunnel runs through. */
const RelaySchema = Schema.Union(
  Schema.Struct({ kind: Schema.Literal('wildflowerOfficial') }),
  Schema.Struct({ kind: Schema.Literal('selfHostedWildflower'), baseUrl: Schema.String }),
  Schema.Struct({ kind: Schema.Literal('rathole') })
)

/** A decoded {@link RelaySchema}. */
type Relay = typeof RelaySchema.Type

/**
 * One registered server as `servers_list` answers it: its domain, relay and
 * tunnel name, the launcher it opens apps from, the ACME CA its certificates
 * are ordered from, its run policy, its status on the host's unit runner, and
 * its certificate's state.
 *
 * @remarks
 * The status is one the `server-status` event carries for the same domain.
 * The certificate is the one the server's run reported, or, with none, the
 * state of the certificate its cache holds, as a stopped server's.
 */
const ListedServerSchema = Schema.Struct({
  domain: Schema.String,
  relay: RelaySchema,
  tunnelName: Schema.String,
  launcherUrl: Schema.String,
  certificateAuthority: CertificateAuthority.Schema,
  runPolicy: RunPolicy.Schema,
  status: ServerStatus.Schema,
  certificate: CertificateState.Schema,
})

/** A decoded {@link ListedServerSchema}. */
type Type = typeof ListedServerSchema.Type

/**
 * `server` with `status` in place of its own, and the certificate state the
 * status's run reported, when it has one, in place of its certificate.
 *
 * @remarks
 * A stopped status carries no certificate state, so `server` keeps the one it
 * had until the list is read again.
 */
const withStatus = (server: Type, status: ServerStatus.Type): Type => ({
  ...server,
  status,
  certificate: Option.getOrElse(ServerStatus.certificateOf(status), () => server.certificate),
})

export { ListedServerSchema as Schema, RelaySchema, withStatus }
export type { Relay, Type }

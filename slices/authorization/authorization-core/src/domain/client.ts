/**
 * A registered OAuth client, as the Owner's "Trusted Apps" list reads it: one
 * `clients` row, seeded by a migration or created when the Owner approved an
 * unknown app (trust on first use). `secret_hash` never leaves the server.
 *
 * Namespace module (`import { Client } from '@wildflowerhealthio/authorization-core/domain'`):
 * the wire shape is `Client.Schema` / `Client.Type`, with `Client.displayName`.
 */

import { Schema } from 'effect'

import * as RefreshPolicy from './refresh-policy.ts'

/**
 * One client as `GET /authorization/clients` returns it.
 *
 * - `clientId` is random and opaque; `name` is what a reader is shown
 *   ({@link displayName}).
 * - `disabledAt` is when the Owner disabled the client, and `null` while it's
 *   enabled. While it's set, `/oauth/authorize` and `/oauth/token` refuse the
 *   client.
 * - `essential` marks a client the Owner can't lose without being stuck — the
 *   Wildflower host app's and the browser-session client — which can't be
 *   disabled.
 * - `refreshPolicy` is how long the client's sign-ins last once it has signed
 *   in ({@link RefreshPolicy.Schema}).
 */
const ClientSchema = Schema.Struct({
  clientId: Schema.String,
  name: Schema.String,
  kind: Schema.Literal('public', 'confidential'),
  redirectUris: Schema.Array(Schema.String),
  allowedScopes: Schema.Array(Schema.String),
  allowedGrantTypes: Schema.Array(Schema.String),
  registeredAt: Schema.DateTimeUtc,
  disabledAt: Schema.NullOr(Schema.DateTimeUtc),
  essential: Schema.Boolean,
  refreshPolicy: RefreshPolicy.Schema,
})

type ClientType = typeof ClientSchema.Type

/**
 * The name the client `clientId` names registered under, looked up in
 * `clients`, for a reader: client ids are random and opaque. The id itself
 * while `clients` is still loading (`undefined`), or for a client that isn't
 * among them or registered no name.
 */
const displayName = (clients: readonly ClientType[] | undefined, clientId: string): string => {
  const name = clients?.find((client) => client.clientId === clientId)?.name ?? ''
  return name === '' ? clientId : name
}

export { ClientSchema as Schema, type ClientType as Type, displayName }

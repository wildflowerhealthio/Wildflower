import { Events, queryDb, State } from '@livestore/livestore'
import { Schema } from 'effect'

const ClientKindSchema = Schema.Literal('public', 'confidential')

type ClientKind = typeof ClientKindSchema.Type

const table = State.SQLite.table({
  name: 'clients',
  columns: {
    clientId: State.SQLite.text({ primaryKey: true }),
    name: State.SQLite.text(),
    kind: State.SQLite.json({ schema: ClientKindSchema }),
    redirectUris: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    allowedScopes: State.SQLite.json({ schema: Schema.Array(Schema.String) }),
    secretHash: State.SQLite.json({ schema: Schema.NullOr(Schema.String) }),
    registeredAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    disabledAt: State.SQLite.json({ schema: Schema.NullOr(Schema.DateTimeUtc) }),
  },
})

type ClientRow = (typeof table)['Type']

const queries = {
  all$: queryDb(table, { label: 'clients' }),
  byId$: (clientId: string) =>
    queryDb(table.where({ clientId }), {
      map: (rows): ClientRow | null => rows[0] ?? null,
      label: 'clientById',
    }),
}

const events = {
  clientRegistered: Events.synced({
    name: 'v1.ClientRegistered',
    schema: Schema.Struct({
      clientId: Schema.String,
      name: Schema.String,
      kind: ClientKindSchema,
      redirectUris: Schema.Array(Schema.String),
      allowedScopes: Schema.Array(Schema.String),
      secretHash: Schema.NullOr(Schema.String),
      registeredAt: Schema.DateTimeUtc,
    }),
  }),
  clientUpdated: Events.synced({
    name: 'v1.ClientUpdated',
    schema: Schema.Struct({
      clientId: Schema.String,
      name: Schema.String,
      redirectUris: Schema.Array(Schema.String),
      allowedScopes: Schema.Array(Schema.String),
      secretHash: Schema.NullOr(Schema.String),
    }),
  }),
  clientDisabled: Events.synced({
    name: 'v1.ClientDisabled',
    schema: Schema.Struct({
      clientId: Schema.String,
      disabledAt: Schema.DateTimeUtc,
    }),
  }),
} as const

const materializers = {
  'v1.ClientRegistered': ({
    clientId,
    name,
    kind,
    redirectUris,
    allowedScopes,
    secretHash,
    registeredAt,
  }: typeof events.clientRegistered.schema.Type) =>
    table.insert({
      clientId,
      name,
      kind,
      redirectUris,
      allowedScopes,
      secretHash,
      registeredAt,
      disabledAt: null,
    }),
  'v1.ClientUpdated': ({
    clientId,
    name,
    redirectUris,
    allowedScopes,
    secretHash,
  }: typeof events.clientUpdated.schema.Type) =>
    table.update({ name, redirectUris, allowedScopes, secretHash }).where({ clientId }),
  'v1.ClientDisabled': ({ clientId, disabledAt }: typeof events.clientDisabled.schema.Type) =>
    table.update({ disabledAt }).where({ clientId }),
}

export { ClientKindSchema, table, queries, events, materializers }
export type { ClientKind, ClientRow }

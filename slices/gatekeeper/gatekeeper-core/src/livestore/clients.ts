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
    secretHash: State.SQLite.text({ nullable: true }),
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
  // Patch shape: only `clientId` is required, every other field is
  // optional. An omitted field is left unchanged; a present field
  // (including `secretHash: null`) overwrites. This lets Owner-side UIs
  // edit individual fields without echoing the rest of the row back —
  // and avoids races where two concurrent edits clobber each other's
  // unrelated fields.
  clientUpdated: Events.synced({
    name: 'v1.ClientUpdated',
    schema: Schema.Struct({
      clientId: Schema.String,
      name: Schema.optional(Schema.String),
      redirectUris: Schema.optional(Schema.Array(Schema.String)),
      allowedScopes: Schema.optional(Schema.Array(Schema.String)),
      secretHash: Schema.optional(Schema.NullOr(Schema.String)),
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
  'v1.ClientUpdated': ({ clientId, ...patch }: typeof events.clientUpdated.schema.Type) => {
    const set: { -readonly [K in keyof typeof table.Type]?: (typeof table.Type)[K] } = {}
    if (patch.name !== undefined) set.name = patch.name
    if (patch.redirectUris !== undefined) set.redirectUris = patch.redirectUris
    if (patch.allowedScopes !== undefined) set.allowedScopes = patch.allowedScopes
    if (patch.secretHash !== undefined) set.secretHash = patch.secretHash
    return table.update(set).where({ clientId })
  },
  // Don't bump `disabledAt` if the client is already disabled — the
  // first disable wins and downstream auditors care about that
  // timestamp.
  'v1.ClientDisabled': ({ clientId, disabledAt }: typeof events.clientDisabled.schema.Type) =>
    table.update({ disabledAt }).where({ clientId, disabledAt: null }),
}

export { ClientKindSchema, table, queries, events, materializers }
export type { ClientKind, ClientRow }

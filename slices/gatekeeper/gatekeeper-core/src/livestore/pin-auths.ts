import { Events, queryDb, State } from '@livestore/livestore'
import { DateTime, Schema } from 'effect'

const PinAuthDurationSchema = Schema.Literal('request', '1min', '15min')

const table = State.SQLite.table({
  name: 'pinAuths',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    pin: State.SQLite.text(),
    returnTo: State.SQLite.text(),
    exp: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    status: State.SQLite.text(), // 'pending' | 'approved'
    duration: State.SQLite.json({ schema: Schema.NullOr(PinAuthDurationSchema) }),
    attempts: State.SQLite.integer({ default: 0 }),
  },
})

type PinAuthRow = (typeof table)['Type']

const queries = {
  all$: queryDb(table, { label: 'pinAuths' }),
  byId$: (id: string) =>
    queryDb(table.where({ id }), {
      map: (rows): PinAuthRow | null => rows[0] ?? null,
      label: 'pinAuthById',
    }),
  allExpired$: (now: DateTime.Utc) =>
    queryDb(table, {
      map: (rows): readonly PinAuthRow[] => rows.filter((row) => DateTime.lessThan(row.exp, now)),
      label: 'pinAuthsExpired',
    }),
}

const events = {
  pinAuthCreated: Events.synced({
    name: 'v1.PinAuthCreated',
    schema: Schema.Struct({
      id: Schema.String,
      pin: Schema.String,
      returnTo: Schema.String,
      exp: Schema.DateTimeUtc,
    }),
  }),
  pinAuthApproved: Events.synced({
    name: 'v1.PinAuthApproved',
    schema: Schema.Struct({
      id: Schema.String,
      duration: PinAuthDurationSchema,
    }),
  }),
  pinAuthAttemptFailed: Events.synced({
    name: 'v1.PinAuthAttemptFailed',
    schema: Schema.Struct({
      id: Schema.String,
      attempts: Schema.Int,
    }),
  }),
  pinAuthDeleted: Events.synced({
    name: 'v1.PinAuthDeleted',
    schema: Schema.Struct({
      id: Schema.String,
    }),
  }),
} as const

const materializers = {
  'v1.PinAuthCreated': ({ id, pin, returnTo, exp }: typeof events.pinAuthCreated.schema.Type) =>
    table.insert({
      id,
      pin,
      returnTo,
      exp,
      status: 'pending',
      duration: null,
      attempts: 0,
    }),
  'v1.PinAuthApproved': ({ id, duration }: typeof events.pinAuthApproved.schema.Type) =>
    table.update({ status: 'approved', duration }).where({ id }),
  'v1.PinAuthAttemptFailed': ({ id, attempts }: typeof events.pinAuthAttemptFailed.schema.Type) =>
    table.update({ attempts }).where({ id }),
  'v1.PinAuthDeleted': ({ id }: typeof events.pinAuthDeleted.schema.Type) =>
    table.delete().where({ id }),
}

type PinAuthDuration = typeof PinAuthDurationSchema.Type

export { PinAuthDurationSchema, table, queries, events, materializers }
export type { PinAuthRow, PinAuthDuration }

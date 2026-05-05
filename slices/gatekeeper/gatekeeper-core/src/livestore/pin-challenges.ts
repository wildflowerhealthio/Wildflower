import { Events, queryDb, State } from '@livestore/livestore'
import { DateTime, Schema } from 'effect'

const table = State.SQLite.table({
  name: 'pinChallenges',
  columns: {
    id: State.SQLite.text({ primaryKey: true }),
    pinHash: State.SQLite.text(),
    returnTo: State.SQLite.text(),
    expiresAt: State.SQLite.json({ schema: Schema.DateTimeUtc }),
    status: State.SQLite.text(), // 'pending' | 'verified' | 'rejected' | 'expired'
    attempts: State.SQLite.integer({ default: 0 }),
  },
})

type PinChallengeRow = (typeof table)['Type']

const queries = {
  all$: queryDb(table, { label: 'pinChallenges' }),
  byId$: (id: string) =>
    queryDb(table.where({ id }), {
      map: (rows): PinChallengeRow | null => rows[0] ?? null,
      label: 'pinChallengeById',
    }),
  allExpired$: (now: DateTime.Utc) =>
    queryDb(table, {
      map: (rows): readonly PinChallengeRow[] =>
        rows.filter((row) => DateTime.lessThan(row.expiresAt, now)),
      label: 'pinChallengesExpired',
    }),
}

const events = {
  pinChallengeIssued: Events.synced({
    name: 'v1.PinChallengeIssued',
    schema: Schema.Struct({
      id: Schema.String,
      pinHash: Schema.String,
      returnTo: Schema.String,
      expiresAt: Schema.DateTimeUtc,
    }),
  }),
  pinChallengeVerified: Events.synced({
    name: 'v1.PinChallengeVerified',
    schema: Schema.Struct({
      id: Schema.String,
    }),
  }),
  pinChallengeAttemptFailed: Events.synced({
    name: 'v1.PinChallengeAttemptFailed',
    schema: Schema.Struct({
      id: Schema.String,
      attempts: Schema.Int,
    }),
  }),
  pinChallengeRejected: Events.synced({
    name: 'v1.PinChallengeRejected',
    schema: Schema.Struct({
      id: Schema.String,
    }),
  }),
  pinChallengeExpired: Events.synced({
    name: 'v1.PinChallengeExpired',
    schema: Schema.Struct({
      id: Schema.String,
    }),
  }),
} as const

const materializers = {
  'v1.PinChallengeIssued': ({
    id,
    pinHash,
    returnTo,
    expiresAt,
  }: typeof events.pinChallengeIssued.schema.Type) =>
    table.insert({
      id,
      pinHash,
      returnTo,
      expiresAt,
      status: 'pending',
      attempts: 0,
    }),
  'v1.PinChallengeVerified': ({ id }: typeof events.pinChallengeVerified.schema.Type) =>
    table.update({ status: 'verified' }).where({ id }),
  'v1.PinChallengeAttemptFailed': ({
    id,
    attempts,
  }: typeof events.pinChallengeAttemptFailed.schema.Type) =>
    table.update({ attempts }).where({ id }),
  'v1.PinChallengeRejected': ({ id }: typeof events.pinChallengeRejected.schema.Type) =>
    table.update({ status: 'rejected' }).where({ id }),
  'v1.PinChallengeExpired': ({ id }: typeof events.pinChallengeExpired.schema.Type) =>
    table.update({ status: 'expired' }).where({ id }),
}

export { table, queries, events, materializers }
export type { PinChallengeRow }

import { type DateTime, Option, Schema } from 'effect'

/** Why a server's run stopped: the unit runner's stop reason. */
const StopReasonSchema = Schema.Literal(
  /** The run policy stopped being active: set to `off`, or its time ran out. */
  'policyInactive',
  /** The server was changed, so the run of its old record stopped. */
  'replaced',
  /** The server was removed. */
  'removed',
  /** The host restarted every running server, as on an iOS resume. */
  'stoppedForRestart',
  /** The run ended without being asked to: it failed, or its config couldn't be built. */
  'endedOnItsOwn',
  /** The platform ended the app's background time; `platformReason` says why. */
  'keepAliveRevoked'
)

/** Why the platform ended the app's background time. */
const PlatformStopReasonSchema = Schema.Literal(
  'userStop',
  'platformTimeout',
  'platformExpiration',
  'nativeNotificationStop',
  'osRestart',
  'bootRecovery',
  'taskCompleted',
  'error',
  'processExit',
  'unknown'
)

/**
 * How a server's latest run stopped: why, the platform's reason when the
 * platform stopped it, the run's error when it failed, and when.
 */
const RunStopSchema = Schema.Struct({
  reason: StopReasonSchema,
  platformReason: Schema.optionalWith(PlatformStopReasonSchema, { as: 'Option', exact: true }),
  error: Schema.optionalWith(Schema.String, { as: 'Option', exact: true }),
  stoppedAt: Schema.DateTimeUtc,
})

/** A decoded {@link RunStopSchema}. */
type RunStop = typeof RunStopSchema.Type

/**
 * Whether a running server's `/health` has answered through its public
 * origin, and the overall status it answered with (`pass`, `warn` or
 * `fail`); or why it hasn't yet.
 */
const HealthSchema = Schema.Union(
  Schema.Struct({
    kind: Schema.Literal('reachable'),
    status: Schema.Literal('pass', 'warn', 'fail'),
  }),
  Schema.Struct({ kind: Schema.Literal('unreachable'), error: Schema.String })
)

/** A decoded {@link HealthSchema}. */
type Health = typeof HealthSchema.Type

/** `health` while a run is in progress: absent until the run first reports it. */
const optionalHealth = Schema.optionalWith(HealthSchema, { as: 'Option', exact: true })

/**
 * One server's status on the host's unit runner, keyed by its domain, as
 * `servers_list` and the {@link EVENT} carry it.
 *
 * @remarks
 * Narrowed by its run state: a `running` status has `runningSince`; a
 * `stopped` one has the `lastStop` of its latest run, once it has run; only
 * a run in progress has `health`.
 */
const ServerStatusSchema = Schema.Union(
  Schema.Struct({
    domain: Schema.String,
    runState: Schema.Literal('starting'),
    health: optionalHealth,
  }),
  Schema.Struct({
    domain: Schema.String,
    runState: Schema.Literal('running'),
    runningSince: Schema.DateTimeUtc,
    health: optionalHealth,
  }),
  Schema.Struct({
    domain: Schema.String,
    runState: Schema.Literal('stopped'),
    lastStop: Schema.optionalWith(RunStopSchema, { as: 'Option', exact: true }),
  })
)

/** A decoded {@link ServerStatusSchema}. */
type Type = typeof ServerStatusSchema.Type

/** Where a server's latest run is: `starting`, `running` or `stopped`. */
type RunState = Type['runState']

/**
 * The Tauri event the host emits a server's status on, to the base's
 * webview, whenever it changes: one event per server.
 *
 * @remarks
 * A removed server gets no event; the base drops a server once
 * `servers_list` no longer lists it.
 */
const EVENT = 'server-status'

/** Decode an {@link EVENT}'s payload, as it arrives in the event's callback. */
const decodeEvent = Schema.decodeUnknownEither(ServerStatusSchema)

/** The server's health, while a run in progress has reported it. */
const healthOf = (status: Type): Option.Option<Health> =>
  status.runState === 'stopped' ? Option.none() : status.health

/** How the server's latest run stopped, while it is stopped and once it has run. */
const lastStopOf = (status: Type): Option.Option<RunStop> =>
  status.runState === 'stopped' ? status.lastStop : Option.none()

/** When the current run came up, while it is running. */
const runningSinceOf = (status: Type): Option.Option<DateTime.Utc> =>
  status.runState === 'running' ? Option.some(status.runningSince) : Option.none()

export {
  decodeEvent,
  EVENT,
  HealthSchema,
  healthOf,
  lastStopOf,
  PlatformStopReasonSchema,
  runningSinceOf,
  RunStopSchema,
  ServerStatusSchema as Schema,
  StopReasonSchema,
}
export type { Health, RunState, RunStop, Type }

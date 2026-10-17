import { Match, Schema } from 'effect'

/** The `actionId` the notification plugin reports for a tap on a notification's text. */
const TAP_ACTION_ID = 'tap'

/**
 * The `actionId` the plugin reports for the Open on a consent notification,
 * as the host registers it.
 */
const OPEN_ACTION_ID = 'open'

/**
 * The `actionId` the plugin reports for the Deny on a consent notification,
 * as the host registers it.
 */
const DENY_ACTION_ID = 'deny'

/**
 * An action on one of the app's notifications, as the notification plugin's
 * `actionPerformed` reports it: which action (`actionId`), and the id the
 * notification was posted under, the one thing about it every platform
 * reports.
 */
const NotificationActionSchema = Schema.Struct({
  actionId: Schema.String,
  notification: Schema.Struct({ id: Schema.Number }),
})

/** A decoded {@link NotificationActionSchema}. */
type Type = typeof NotificationActionSchema.Type

/**
 * What the Owner asks for with a notification action: `open` the consent
 * the notification announced (a tap on its text, or its Open), `deny` it (its
 * Deny), or `nothing`, as for a dismissal.
 */
type Intent = 'open' | 'deny' | 'nothing'

/** What the Owner asks for with `action`. */
const intentOf = (action: Type): Intent =>
  Match.value(action.actionId).pipe(
    Match.when(TAP_ACTION_ID, (): Intent => 'open'),
    Match.when(OPEN_ACTION_ID, (): Intent => 'open'),
    Match.when(DENY_ACTION_ID, (): Intent => 'deny'),
    Match.orElse((): Intent => 'nothing')
  )

export { DENY_ACTION_ID, intentOf, NotificationActionSchema as Schema, OPEN_ACTION_ID }
export type { Intent, Type }

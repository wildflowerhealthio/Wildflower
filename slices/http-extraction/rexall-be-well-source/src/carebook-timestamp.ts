import { Schema } from 'effect'

/**
 * A timestamp as the carebook dialect writes every one: second precision,
 * always `+00:00` (`2024-03-11T16:54:30+00:00`).
 */
const CarebookTimestampString = Schema.String.pipe(
  Schema.pattern(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\+00:00$/)
)

/**
 * A carebook timestamp ⇄ the instant it names. Encoding truncates to the
 * second and writes the dialect's `+00:00` form.
 */
const CarebookTimestamp = Schema.transform(CarebookTimestampString, Schema.DateTimeUtc, {
  strict: true,
  decode: (carebookTimestamp) => carebookTimestamp,
  // `DateTimeUtc` encodes as `toISOString()`: `YYYY-MM-DDTHH:mm:ss.sssZ`.
  encode: (isoTimestamp) => `${isoTimestamp.slice(0, 19)}+00:00`,
})

/** An instant as the carebook dialect writes it. See {@link CarebookTimestamp}. */
const carebookTimestampOf = Schema.encodeSync(CarebookTimestamp)

export { CarebookTimestamp, carebookTimestampOf }

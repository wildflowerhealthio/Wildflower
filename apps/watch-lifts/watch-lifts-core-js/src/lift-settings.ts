import type { Either, ParseResult } from 'effect'
import { Schema } from 'effect'

import { DEFAULT_WEIGHTS, EXERCISES, MAX_WEIGHT, PEOPLE } from './lifts.ts'
import type * as PhoneSettings from './phone-settings.ts'

/**
 * The weights the settings page edits and hands back to the watchapp.
 *
 * @remarks
 * A namespace module — consumers speak `LiftSettings.Schema`,
 * `LiftSettings.toJson`, `LiftSettings.fromJson`, `LiftSettings.DEFAULT`.
 *
 * The JSON {@link toJson} writes is the wire shape both ways: the watchapp's
 * PebbleKit JS opens the page with it in the `PhoneSettings.PARAM` query
 * parameter (`PhoneSettings.configurationUrl`), and the page hands it back
 * through `pebble-configuration`'s `ReturnTarget.handoffUrl`, where
 * `PhoneSettings.decodeResponse` parses it. That decoder can't use this Schema
 * (the phone's runtime is ES5, and Effect needs ES2015). The Schema is pinned
 * to `PhoneSettings.Settings`, so a field changed on one side and not the other
 * fails to compile, and `phone-settings.test.ts` round-trips one through the
 * other.
 *
 * @packageDocumentation
 */

/** A weight in whole pounds, 0 to `Lifts.MAX_WEIGHT`. */
const WeightSchema = Schema.Int.pipe(Schema.between(0, MAX_WEIGHT))

/**
 * The settings as the watchapp receives them. Pinned to
 * `PhoneSettings.Settings`, where the fields are documented: `Schema.Schema`
 * is invariant in its type, so the two must match exactly.
 */
const LiftSettingsSchema: Schema.Schema<PhoneSettings.Settings> = Schema.Struct({
  weights: Schema.Array(Schema.Array(WeightSchema).pipe(Schema.itemsCount(EXERCISES.length))).pipe(
    Schema.itemsCount(PEOPLE.length)
  ),
})

/** Every person's weight at every exercise. */
type Type = typeof LiftSettingsSchema.Type

/** The settings as the JSON the watchapp parses, and the page's query parameter carries. */
const toJson: (settings: Type) => string = Schema.encodeSync(Schema.parseJson(LiftSettingsSchema))

/**
 * Decodes the JSON {@link toJson} writes, such as the `PhoneSettings.PARAM`
 * query parameter's value, or fails when it is not the settings.
 */
const fromJson: (json: string) => Either.Either<Type, ParseResult.ParseError> =
  Schema.decodeUnknownEither(Schema.parseJson(LiftSettingsSchema))

/** The settings before the page has saved any: `Lifts.DEFAULT_WEIGHTS`. */
const DEFAULT: Type = { weights: DEFAULT_WEIGHTS }

export { DEFAULT, fromJson, LiftSettingsSchema as Schema, toJson }
export type { Type }

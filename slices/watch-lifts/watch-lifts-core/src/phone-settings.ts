import { decodeWebviewResponse } from 'pebble-configuration/pkjs'

import { DEFAULT_WEIGHTS, EXERCISES, MAX_WEIGHT, PEOPLE } from './lifts.ts'

/**
 * The weights as the watchapp's PebbleKit JS holds them: decoded from the
 * settings page's `webviewclosed` response or from `localStorage`, the page's
 * URL that opens pre-filled with them, and the message the watch receives.
 *
 * @remarks
 * A namespace module — consumers speak `PhoneSettings.decodeResponse`,
 * `PhoneSettings.toStored`, `PhoneSettings.decodeStored`,
 * `PhoneSettings.configurationUrl`, `PhoneSettings.toWatchMessage`.
 *
 * {@link Settings} is the shape the settings page's `LiftSettings.toJson`
 * writes: `LiftSettings.Schema` is pinned to it. The decode is hand-written
 * rather than that Schema because PebbleKit JS bundles it and the phone's
 * runtime is ES5, which Effect does not run on; `phone-settings.test.ts`
 * round-trips generated settings through `toJson` and this decode to hold the
 * two together. This module imports nothing of `LiftSettings`, not even its
 * types, so type-checking the phone's bundle never loads Effect.
 *
 * @packageDocumentation
 */

/** Every person's weight at every exercise. */
interface Settings {
  /**
   * Whole pounds from 0 to `Lifts.MAX_WEIGHT`, person-major:
   * `weights[person][exercise]`, one row per `Lifts.PEOPLE` entry and one
   * column per `Lifts.EXERCISES` entry, in their order.
   */
  readonly weights: ReadonlyArray<ReadonlyArray<number>>
}

/** The AppMessage dictionary the watch receives, keyed by `messageKeys` name. */
interface WatchMessage {
  /** {@link WEIGHTS_BYTES} bytes, as {@link toWatchMessage} lays them out. */
  readonly Weights: ReadonlyArray<number>
}

/** The settings before the page has saved any: `Lifts.DEFAULT_WEIGHTS`. */
const DEFAULT: Settings = { weights: DEFAULT_WEIGHTS }

/**
 * The query parameter the settings page reads the current settings from, as
 * the JSON `LiftSettings.toJson` writes.
 */
const PARAM = 'weights'

/**
 * How many bytes the watch message's `Weights` holds: two per weight, for
 * every person at every exercise. The watch's `WEIGHTS_WIRE_SIZE`
 * (src/c/weights-wire.h) is the same.
 */
const WEIGHTS_BYTES = 2 * PEOPLE.length * EXERCISES.length

/** Whether `value` is a whole number of pounds the settings accept. */
const isWeight = (value: unknown): value is number =>
  typeof value === 'number' && value % 1 === 0 && value >= 0 && value <= MAX_WEIGHT

/** `row` checked as one person's weights, one per exercise; throws otherwise. */
const decodeRow = (row: unknown, person: number): ReadonlyArray<number> => {
  if (!Array.isArray(row) || row.length !== EXERCISES.length) {
    throw new Error(`Settings field weights[${person}] must hold ${EXERCISES.length} weights`)
  }
  const weights: Array<number> = []
  for (let exercise = 0; exercise < row.length; exercise++) {
    const weight: unknown = row[exercise]
    if (!isWeight(weight)) {
      throw new Error(
        `Settings field weights[${person}][${exercise}] must be a whole number from 0 to ${MAX_WEIGHT}`
      )
    }
    weights.push(weight)
  }
  return weights
}

/**
 * Decodes parsed settings JSON, keeping only the fields the settings carry.
 * Throws when the value is not that shape.
 */
const decodeSettings = (settings: unknown): Settings => {
  if (typeof settings !== 'object' || settings === null || Array.isArray(settings)) {
    throw new Error('Settings must be a JSON object')
  }
  const weights: unknown = (settings as { readonly weights?: unknown }).weights
  if (!Array.isArray(weights) || weights.length !== PEOPLE.length) {
    throw new Error(`Settings field weights must hold a row for each of ${PEOPLE.length} people`)
  }
  const rows: Array<ReadonlyArray<number>> = []
  for (let person = 0; person < weights.length; person++) {
    rows.push(decodeRow(weights[person], person))
  }
  return { weights: rows }
}

/**
 * Decodes the settings page's `webviewclosed` response — the settings JSON,
 * URI-encoded (`pebble-configuration`'s `decodeWebviewResponse`). Throws when
 * the response is not that shape.
 */
const decodeResponse = (response: string): Settings =>
  decodeSettings(decodeWebviewResponse(response))

/** The `localStorage` text keeping `settings`. */
const toStored = (settings: Settings): string => JSON.stringify({ weights: settings.weights })

/**
 * Decodes what {@link toStored} last wrote: `null` when the settings page has
 * never saved any. Throws when it is not that shape.
 *
 * @param stored - What `localStorage.getItem` returns for it
 */
const decodeStored = (stored: string | null): Settings | null =>
  stored === null ? null : decodeSettings(JSON.parse(stored))

/**
 * The settings page's URL, opened pre-filled with `settings`: `pageUrl` with
 * {@link PARAM} set to their JSON, URI-encoded.
 *
 * @param pageUrl - The page's address, without a query or fragment
 */
const configurationUrl = (pageUrl: string, settings: Settings): string =>
  `${pageUrl}?${PARAM}=${encodeURIComponent(toStored(settings))}`

/**
 * The AppMessage the watch takes the weights from: `Weights`, a byte array of
 * {@link WEIGHTS_BYTES} bytes. Each weight is an unsigned 16-bit integer, low
 * byte first, in `settings.weights`' person-major order: the first person's
 * weight at each exercise, then the next person's. The watch decodes it with
 * `weights_wire_decode` (src/c/weights-wire.h), and the app's
 * `test/weights-wire.test.ts` round-trips one through the other.
 */
const toWatchMessage = (settings: Settings): WatchMessage => {
  const bytes: Array<number> = []
  for (let person = 0; person < settings.weights.length; person++) {
    const row = settings.weights[person] ?? []
    for (let exercise = 0; exercise < row.length; exercise++) {
      const weight = row[exercise] ?? 0
      bytes.push(weight & 0xff, (weight >> 8) & 0xff)
    }
  }
  return { Weights: bytes }
}

export {
  configurationUrl,
  decodeResponse,
  decodeStored,
  DEFAULT,
  PARAM,
  toStored,
  toWatchMessage,
  WEIGHTS_BYTES,
}
export type { Settings, WatchMessage }

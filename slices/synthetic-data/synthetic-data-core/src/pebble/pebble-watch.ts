import { WatchDevice } from 'fhir-sync-pebble-core'

import * as Seeded from '../seeded.ts'

/**
 * The watch a synthetic Pebble data set was recorded on, as PebbleKit JS
 * describes it to FHIR Sync for Pebble: `Pebble.getActiveWatchInfo()` and
 * `Pebble.getWatchToken()`.
 */

/** What `Pebble.getActiveWatchInfo()` reports, the fields `WatchDevice.describe` reads. */
interface WatchInfo {
  readonly model: string
  readonly platform: string
  readonly firmware: {
    readonly major: number
    readonly minor: number
    readonly patch: number
    readonly suffix: string
  }
}

interface PebbleWatch {
  /** `Pebble.getWatchToken()`: 32 lowercase hex digits, unique to the watch and the app. */
  readonly token: string
  readonly info: WatchInfo
}

/**
 * The watches FHIR Sync for Pebble runs on: its only target platform is
 * `emery`, the Pebble Time 2, on the firmware its own tests describe.
 */
const WATCH_INFOS: readonly [WatchInfo, ...WatchInfo[]] = [
  {
    model: 'pebble_time_2_black',
    platform: 'emery',
    firmware: { major: 4, minor: 9, patch: 0, suffix: '' },
  },
  {
    model: 'pebble_time_2_black',
    platform: 'emery',
    firmware: { major: 4, minor: 9, patch: 1, suffix: '' },
  },
]

/**
 * The watch keyed `keys` — typically its wearer's key — with its token hashed
 * from them and its model and firmware picked by them.
 */
const watchOf = (keys: readonly string[]): PebbleWatch => ({
  token: Seeded.uuidOf([...keys, 'pebble-watch-token']).replaceAll('-', ''),
  info:
    WATCH_INFOS[Seeded.integerOf([...keys, 'pebble-watch-info'], 0, WATCH_INFOS.length - 1)] ??
    WATCH_INFOS[0],
})

/** The watch as its Observations' `device`, exactly as the phone writes it. */
const toReference = (watch: PebbleWatch): WatchDevice.Reference =>
  WatchDevice.toReference(watch.info, watch.token)

export { toReference, watchOf }
export type { PebbleWatch, WatchInfo }

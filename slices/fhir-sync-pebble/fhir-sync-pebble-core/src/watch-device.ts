import { isFields, requireInteger } from './fields.ts'
import { joinIdComponents, localResourceId } from './local-resource-id.ts'

/**
 * The watch as an Observation's `device`: what `Pebble.getActiveWatchInfo()`
 * says it is, and which watch it is by `Pebble.getWatchToken()`.
 *
 * @remarks
 * A namespace module — consumers speak `WatchDevice.Reference`,
 * `WatchDevice.toReference`, `WatchDevice.observationId`. The watch token is
 * what makes a sync's writes idempotent: every Observation's id derives from
 * it ({@link observationId}), so the same record from the same watch is PUT
 * under the same id however often it is sent.
 *
 * @packageDocumentation
 */

/**
 * The identifier system for Pebble watch tokens: the PebbleKit JS docs for
 * `Pebble.getWatchToken()`, which returns a token unique to one watch and one
 * app (a watch gives each app a different one).
 */
const WATCH_TOKEN_SYSTEM = 'https://developer.repebble.com/docs/pebblekit-js/Pebble/#getWatchToken'

/**
 * The watch as an Observation's `device`: its description for people, and its
 * watch token as the identifier.
 */
interface Reference {
  readonly display: string
  readonly identifier: { readonly system: string; readonly value: string }
}

/**
 * The device display for the watch `Pebble.getActiveWatchInfo()` describes:
 * its model, platform and firmware, like "pebble_time_2_black (emery, firmware
 * 4.9.0)". Throws when the info is not that shape.
 */
const describe = (watchInfo: unknown): string => {
  if (!isFields(watchInfo)) {
    throw new Error('Watch info must be an object')
  }
  const firmware = watchInfo['firmware']
  if (!isFields(firmware)) {
    throw new Error('Watch info firmware must be an object')
  }
  const model = watchInfo['model']
  const platform = watchInfo['platform']
  if (typeof model !== 'string' || typeof platform !== 'string') {
    throw new Error('Watch info model and platform must be strings')
  }
  const version = [
    requireInteger(firmware, 'major'),
    requireInteger(firmware, 'minor'),
    requireInteger(firmware, 'patch'),
  ].join('.')
  const suffix = firmware['suffix']
  const versionWithSuffix =
    typeof suffix === 'string' && suffix.length > 0 ? `${version}-${suffix}` : version
  return `${model} (${platform}, firmware ${versionWithSuffix})`
}

/**
 * The Observations' `device` for the watch `Pebble.getActiveWatchInfo()`
 * describes and `Pebble.getWatchToken()` names. Throws when the info is not
 * that shape or the token is not a non-empty string: an Observation without
 * the token would get an id no other sync reproduces.
 */
const toReference = (watchInfo: unknown, watchToken: unknown): Reference => {
  if (typeof watchToken !== 'string' || watchToken.length === 0) {
    throw new Error('Watch token must be a non-empty string')
  }
  return {
    display: describe(watchInfo),
    identifier: { system: WATCH_TOKEN_SYSTEM, value: watchToken },
  }
}

/**
 * The id the Observation `recordKey` names is PUT under: `fhir-r4`'s
 * `localResourceId` over the watch token, the patient and `recordKey`, so a
 * record is one resource per watch and patient however often it is sent. The
 * patient is part of it so that syncing the same watch to another patient
 * writes new Observations rather than moving the first patient's.
 *
 * @param recordKey - What identifies the record among the watch's, e.g. its
 *   kind, type and start
 */
const observationId = (
  device: Reference,
  patientId: string,
  recordKey: ReadonlyArray<string>
): string =>
  localResourceId(
    device.identifier.system,
    'Observation',
    joinIdComponents([device.identifier.value, patientId, ...recordKey])
  )

export { describe, observationId, toReference, WATCH_TOKEN_SYSTEM }
export type { Reference }

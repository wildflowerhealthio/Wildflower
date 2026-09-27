import { isFields, requireInteger } from './fields.ts'

/**
 * The watch as an Observation's `device`: what `Pebble.getActiveWatchInfo()`
 * says it is.
 *
 * @remarks
 * A namespace module — consumers speak `WatchDevice.describe`.
 *
 * @packageDocumentation
 */

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

export { describe }

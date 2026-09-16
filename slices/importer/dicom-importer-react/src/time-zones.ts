/**
 * The time zones the DICOM settings picker offers without typing.
 *
 * @remarks
 * A separate module from the picker component so the list (and the runtime's
 * own zone folded into it) can be read and tested without rendering, and so
 * the `.tsx` exports only components — what `react(only-export-components)`
 * wants for fast refresh.
 *
 * @packageDocumentation
 */
import { runtimeTimeZone } from 'dicom-importer-core'

/**
 * North America's distinct civil zones, east to west, plus `UTC`.
 *
 * @remarks
 * One IANA name per distinct offset-and-DST-rule rather than per region, with
 * the two Canadian/US spellings kept separate where both are in common use
 * (`America/Toronto` and `America/New_York` share an offset today but are
 * distinct zones with their own histories, and a DICOM study's date can be old
 * enough for that to matter). `America/Phoenix` and `America/Regina` are here
 * because they do *not* observe DST — the cases most easily got wrong by
 * picking a neighbour.
 */
const NORTH_AMERICAN_TIME_ZONES: readonly string[] = [
  'America/St_Johns',
  'America/Halifax',
  'America/Toronto',
  'America/New_York',
  'America/Winnipeg',
  'America/Chicago',
  'America/Regina',
  'America/Denver',
  'America/Edmonton',
  'America/Phoenix',
  'America/Vancouver',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'America/Mexico_City',
  'UTC',
]

/**
 * The suggestion list: this runtime's own zone first — a study is usually
 * imported near where it was acquired — then the North American zones, with
 * no duplicate when the runtime's zone is already one of them.
 *
 * @returns The zones to offer, most likely first
 */
const suggestedTimeZones = (): readonly string[] => [
  ...new Set([runtimeTimeZone(), ...NORTH_AMERICAN_TIME_ZONES]),
]

export { NORTH_AMERICAN_TIME_ZONES, suggestedTimeZones }

import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildHostCDriver,
  type HostCDriver,
  numRunsFor,
} from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

// menu-text.c is the watch's pure formatting code. The Pebble SDK isn't
// needed to test it: buildHostCDriver compiles it with the host C compiler
// under the sanitizers, driven through menu-text-driver.c.
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

let driver: HostCDriver
/** DATA_TYPE_COUNT from data-type.h, read from the driver in beforeAll. */
let dataTypeCount: number
/** TIME_TEXT_SIZE from menu-text.h less the NUL: the longest time text. */
let maxTimeTextLength: number
/** PATIENT_SUBTITLE_SIZE from menu-text.h less the NUL. */
let maxPatientSubtitleLength: number

beforeAll(() => {
  driver = buildHostCDriver({
    name: 'fhir-sync-pebble-menu-text',
    sources: [join(packageDir, 'test/menu-text-driver.c'), join(packageDir, 'src/c/menu-text.c')],
  })
  const [count, timeTextSize, patientSubtitleSize] = driver.run('sizes').split(' ').map(Number)
  dataTypeCount = count
  maxTimeTextLength = timeTextSize - 1
  maxPatientSubtitleLength = patientSubtitleSize - 1
})

afterAll(() => {
  driver.dispose()
})

/** A wall-clock time as the watch's `struct tm` carries it; `month` is 0-11. */
interface ClockTime {
  readonly month: number
  readonly day: number
  readonly hour: number
  readonly minute: number
}

const clockTimeArbitrary: fc.Arbitrary<ClockTime> = fc.record({
  month: fc.integer({ min: 0, max: 11 }),
  day: fc.integer({ min: 1, max: 31 }),
  hour: fc.integer({ min: 0, max: 23 }),
  minute: fc.integer({ min: 0, max: 59 }),
})

const timeArgs = ({ month, day, hour, minute }: ClockTime, clock24h: boolean): string =>
  `${month} ${day} ${hour} ${minute} ${clock24h ? 1 : 0}`

const formatTime = (time: ClockTime, clock24h: boolean): string =>
  driver.run(`time ${timeArgs(time, clock24h)}`)

/** Text the driver accepts on one line: printable ASCII. */
const lineTextArbitrary = fc.stringMatching(/^[ -~]{0,40}$/)

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const pad2 = (value: number): string => String(value).padStart(2, '0')

/** What the watch should show for `time`: "Mon D HH:MM", or "Mon D H:MM AM|PM" on a 12-hour clock. */
const expectedTime = ({ month, day, hour, minute }: ClockTime, clock24h: boolean): string => {
  if (clock24h) {
    return `${MONTHS[month]} ${day} ${pad2(hour)}:${pad2(minute)}`
  }
  const hour12 = hour % 12 === 0 ? 12 : hour % 12
  return `${MONTHS[month]} ${day} ${hour12}:${pad2(minute)} ${hour < 12 ? 'AM' : 'PM'}`
}

// Every driver call spawns a sanitized process, so these properties over small
// formatters run fewer cases than the repo's usual 100.
const NUM_RUNS = numRunsFor({ base: 25 })

describe('menu_text_format_time', () => {
  it.each([
    [{ month: 8, day: 27, hour: 14, minute: 2 }, true, 'Sep 27 14:02'],
    [{ month: 8, day: 27, hour: 14, minute: 2 }, false, 'Sep 27 2:02 PM'],
    [{ month: 0, day: 1, hour: 0, minute: 0 }, false, 'Jan 1 12:00 AM'],
    [{ month: 11, day: 31, hour: 12, minute: 59 }, false, 'Dec 31 12:59 PM'],
  ])('formats %j (24h: %s) as %j', (time, clock24h, expected) => {
    expect(formatTime(time, clock24h)).toBe(expected)
  })

  it('writes any in-range time on either clock', () => {
    fc.assert(
      fc.property(clockTimeArbitrary, fc.boolean(), (time, clock24h) => {
        expect(formatTime(time, clock24h)).toBe(expectedTime(time, clock24h))
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('truncates out-of-range fields to a prefix of the full text', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 11 }),
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.integer({ min: 0, max: 2_000_000_000 }),
        fc.integer({ min: 0, max: 2_000_000_000 }),
        (month, day, hour, minute) => {
          const text = formatTime({ month, day, hour, minute }, true)
          expect(text.length).toBeLessThanOrEqual(maxTimeTextLength)
          expect(`${MONTHS[month]} ${day} ${pad2(hour)}:${pad2(minute)}`.startsWith(text)).toBe(
            true
          )
        }
      ),
      { numRuns: NUM_RUNS }
    )
  })
})

describe('menu_text_format_status_title', () => {
  it('reads "Sync failed" after a failed sync, even with an earlier success', () => {
    expect(driver.run('status-title failed')).toBe('Sync failed')
  })
})

describe.each([
  ['last-sync', 'Synced', 'Never synced'],
  // Without a failure the status title is the last-sync line.
  ['status-title', 'Synced', 'Never synced'],
  ['last-auth', 'Signed in', 'Not signed in'],
])('the %s line', (command, prefix, never) => {
  it(`reads ${JSON.stringify(never)} when there is no time`, () => {
    expect(driver.run(`${command} never`)).toBe(never)
  })

  it(`reads "${prefix} <time>" otherwise`, () => {
    fc.assert(
      fc.property(clockTimeArbitrary, fc.boolean(), (time, clock24h) => {
        expect(driver.run(`${command} ${timeArgs(time, clock24h)}`)).toBe(
          `${prefix} ${expectedTime(time, clock24h)}`
        )
      }),
      { numRuns: NUM_RUNS }
    )
  })
})

describe('menu_text_patient_title', () => {
  it('reads "Not connected" when not signed in, whatever the name', () => {
    fc.assert(
      fc.property(lineTextArbitrary, (name) => {
        expect(driver.run(`patient-title 0 ${name}`)).toBe('Not connected')
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('reads "Unnamed patient" when the record has no name', () => {
    expect(driver.run('patient-title 1 ')).toBe('Unnamed patient')
  })

  it('is the name otherwise', () => {
    fc.assert(
      fc.property(
        lineTextArbitrary.filter((name) => name.length > 0),
        (name) => {
          expect(driver.run(`patient-title 1 ${name}`)).toBe(name)
        }
      ),
      { numRuns: NUM_RUNS }
    )
  })
})

describe('menu_text_format_patient_subtitle', () => {
  it('asks to open the settings when not signed in, whatever the birth date', () => {
    fc.assert(
      fc.property(lineTextArbitrary, (birthDate) => {
        expect(driver.run(`patient-subtitle 0 ${birthDate}`)).toBe('Open settings on phone')
      }),
      { numRuns: NUM_RUNS }
    )
  })

  it('reads "Birth date unknown" when the record has none', () => {
    expect(driver.run('patient-subtitle 1 ')).toBe('Birth date unknown')
  })

  it('reads "Born <birth date>" for a FHIR date', () => {
    expect(driver.run('patient-subtitle 1 1815-12-10')).toBe('Born 1815-12-10')
  })

  it('truncates any birth date to a prefix of "Born <birth date>"', () => {
    fc.assert(
      fc.property(
        lineTextArbitrary.filter((birthDate) => birthDate.length > 0),
        (birthDate) => {
          expect(driver.run(`patient-subtitle 1 ${birthDate}`)).toBe(
            `Born ${birthDate}`.slice(0, maxPatientSubtitleLength)
          )
        }
      ),
      { numRuns: NUM_RUNS }
    )
  })
})

describe('menu_text_data_type_title', () => {
  it('titles each data type, in menu order', () => {
    const titles = Array.from({ length: dataTypeCount }, (_, dataType) =>
      driver.run(`data-type-title ${dataType}`)
    )
    expect(titles).toEqual([
      'Health Activity',
      'Heart Rate',
      'Steps',
      'Orientation',
      'Movement',
      'Ambient Light Level',
    ])
  })
})

describe('menu_text_sync_button_label', () => {
  it.each([
    ['ready', 'Sync Now'],
    ['loading', 'Syncing...'],
    ['disabled', 'Sync Now'],
  ])('labels the %s button %j', (state, expected) => {
    expect(driver.run(`sync-label ${state}`)).toBe(expected)
  })
})

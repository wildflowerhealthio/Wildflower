import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  buildHostCDriver,
  type HostCDriver,
  numRunsFor,
} from '@wildflowerhealthio/kitchen-sink/test'
import * as fc from 'fast-check'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

// sync.c runs one Sync Now: the messages it sends, its timer, and how it
// ends. It needs pebble.h, so buildHostCDriver builds it against the stand-in
// in pebble-stand-in/, whose AppMessage, timer and HealthService
// sync-driver.c records and scripts. One driver command line is one scenario.
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

let driver: HostCDriver

beforeAll(() => {
  driver = buildHostCDriver({
    name: 'fhir-sync-pebble-sync',
    sources: [
      join(packageDir, 'test/sync-driver.c'),
      join(packageDir, 'src/c/sync.c'),
      join(packageDir, 'src/c/state.c'),
      join(packageDir, 'src/c/minute-wire.c'),
    ],
    includeDirectories: [join(packageDir, 'test/pebble-stand-in')],
  })
})

afterAll(() => {
  driver.dispose()
})

/** Runs `steps`, whose outputs are single words, as one scenario and returns each step's. */
const runScenario = (steps: ReadonlyArray<string>): Array<string> =>
  driver.run(steps.join('; ')).split(' ')

/**
 * The output of `steps` past the first `outputsBefore` single-word ones: the
 * last step's, which may hold spaces.
 */
const lastOutput = (steps: ReadonlyArray<string>, outputsBefore: number): string =>
  driver.run(steps.join('; ')).split(' ').slice(outputsBefore).join(' ')

// A connected watch at 2026-09-21T14:13:20Z. Every data type is checked, but
// the stand-in has no minute history, so only the activities a scenario adds
// are sent.
const NOW = 1_790_000_000
const CONNECTED = [`clock ${NOW}`, 'connect wf-connection']
const DAY = 86_400

describe('sync_start', () => {
  it('should send SyncStart first, with its id and the connection', () => {
    expect(lastOutput([...CONNECTED, 'start', 'outbox'], 3)).toBe(
      `SyncStart=${NOW},ConnectionId=wf-connection`
    )
  })

  it('should give a sync started in the same second as the last a later id', () => {
    expect(lastOutput([...CONNECTED, 'start', 'fail-send', 'start', 'outbox'], 5)).toBe(
      `SyncStart=${NOW + 1},ConnectionId=wf-connection`
    )
  })

  it('should send each activity after SyncStart, then the counts', () => {
    const steps = [...CONNECTED, `activity 4 ${NOW - 600} ${NOW - 60}`, 'start', 'ack']
    expect(lastOutput([...steps, 'outbox'], steps.length)).toBe(
      `ActivityType=4,ActivityStart=${NOW - 600},ActivityEnd=${NOW - 60}`
    )
    expect(lastOutput([...steps, 'ack', 'outbox'], steps.length + 1)).toBe(
      'ActivityCount=1,MinuteHourCount=0'
    )
  })
})

describe('the timer', () => {
  it('should allow 60 s per message, then 90 s for the answer once the counts are sent', () => {
    expect(runScenario([...CONNECTED, 'start', 'timer', 'ack', 'timer', 'ack', 'timer'])).toEqual([
      'ok',
      'reset',
      'started',
      '60000',
      'acked',
      '60000',
      'acked',
      '90000',
    ])
  })

  it('should fail the sync when it fires', () => {
    expect(lastOutput([...CONNECTED, 'start', 'ack', 'ack', 'fire', 'status'], 6)).toBe('failed 0')
  })
})

describe('sync_handle_result', () => {
  it("should end the sync on the phone's answer to it", () => {
    fc.assert(
      fc.property(fc.boolean(), (succeeded) => {
        expect(
          lastOutput(
            [...CONNECTED, 'start', 'ack', 'ack', `result ${NOW} ${succeeded ? 1 : 0}`, 'status'],
            6
          )
        ).toBe(succeeded ? `idle ${NOW}` : 'failed 0')
      }),
      { numRuns: 2 }
    )
  })

  // A late answer to a sync the watch gave up on.
  it('should ignore an answer to any other sync', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 2 ** 31 - 1 }), fc.boolean(), (syncId, succeeded) => {
        fc.pre(syncId !== NOW)
        const steps = [...CONNECTED, 'start', 'ack', 'ack', `result ${syncId} ${succeeded ? 1 : 0}`]
        expect(lastOutput([...steps, 'status'], steps.length)).toBe('syncing 0')
        expect(lastOutput([...steps, 'timer'], steps.length)).toBe('90000')
      }),
      { numRuns: numRunsFor({ base: 10 }) }
    )
  })

  it('should ignore an answer when no sync is under way', () => {
    expect(lastOutput([...CONNECTED, `result ${NOW} 1`, 'status'], 3)).toBe('idle 0')
  })
})

describe('sync_abandon', () => {
  it('should fail the sync under way and stop its timer', () => {
    const steps = [...CONNECTED, 'start', 'ack', 'abandon']
    expect(lastOutput([...steps, 'status'], steps.length)).toBe('failed 0')
    expect(lastOutput([...steps, 'timer'], steps.length)).toBe('none')
  })

  it('should leave the watch alone when no sync is under way', () => {
    expect(lastOutput([...CONNECTED, 'abandon', 'status'], 3)).toBe('idle 0')
  })
})

describe('the activity lookback', () => {
  /** A scenario whose first sync succeeds at `NOW`, then a second a day later. */
  const secondSync = (activities: ReadonlyArray<string>): Array<string> => [
    ...CONNECTED,
    'start',
    'ack',
    `result ${NOW} 1`,
    `clock ${NOW + DAY}`,
    ...activities,
    'start',
  ]

  it('should look for activities from a day before the last sync', () => {
    const steps = secondSync([])
    expect(lastOutput([...steps, 'iterated'], steps.length)).toBe(String(NOW - DAY))
  })

  it('should send an activity that ended inside the lookback, and not one before it', () => {
    const steps = secondSync([
      `activity 1 ${NOW - DAY - 7200} ${NOW - DAY - 1}`,
      `activity 1 ${NOW - 8 * 3600} ${NOW - 600}`,
    ])
    expect(lastOutput([...steps, 'ack', 'outbox'], steps.length + 1)).toBe(
      `ActivityType=1,ActivityStart=${NOW - 8 * 3600},ActivityEnd=${NOW - 600}`
    )
    expect(lastOutput([...steps, 'ack', 'ack', 'outbox'], steps.length + 2)).toBe(
      'ActivityCount=1,MinuteHourCount=0'
    )
  })

  // The lookback moves only where the iteration starts.
  it("should still set Health Activity's last sync to the sync's start", () => {
    const steps = secondSync([`activity 4 ${NOW - 600} ${NOW - 60}`])
    expect(
      lastOutput(
        [...steps, 'ack', 'ack', 'ack', `result ${NOW + DAY} 1`, 'status'],
        steps.length + 4
      )
    ).toBe(`idle ${NOW + DAY}`)
  })

  it('should look from the beginning on the first sync', () => {
    expect(lastOutput([...CONNECTED, 'start', 'iterated'], 3)).toBe('0')
  })
})

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterAll, beforeAll, describe, expect, it } from 'vite-plus/test'

// reps-text.c is the watch's pure formatting code. The Pebble SDK isn't
// needed to test it: build it with the host C compiler (in C99, as the SDK
// compiles apps), under AddressSanitizer and UBSan so an overflow fails the
// test rather than passing by luck, and drive it through reps-text-driver.c.
const packageDir = join(dirname(fileURLToPath(import.meta.url)), '..')

let buildDir: string
let driverPath: string
/** MAX_SETS from src/c/state.h, read from the driver in beforeAll. */
let maxSets: number
/** REPS_TEXT_SIZE from reps-text.h less the NUL: the longest reps text. */
let maxRepsTextLength: number

beforeAll(() => {
  buildDir = mkdtempSync(join(tmpdir(), 'watch-lifts-reps-text-'))
  driverPath = join(buildDir, 'reps-text-driver')
  execFileSync(
    'cc',
    [
      '-std=c99',
      '-Wall',
      '-Wextra',
      '-Werror',
      '-g',
      '-fsanitize=address,undefined',
      '-fno-sanitize-recover=all',
      '-o',
      driverPath,
      join(packageDir, 'test/reps-text-driver.c'),
      join(packageDir, 'src/c/windows/exercise-detail-window/reps-text.c'),
    ],
    { stdio: 'inherit' }
  )
  const [sets, repsTextSize] = run('sizes').split(' ').map(Number)
  maxSets = sets
  maxRepsTextLength = repsTextSize - 1
})

afterAll(() => {
  rmSync(buildDir, { recursive: true, force: true })
})

/** Runs one driver command and returns its output line, trailing spaces kept. */
const run = (command: string): string =>
  execFileSync(driverPath, { input: `${command}\n`, encoding: 'utf8' }).replace(/\n$/, '')

const formatReps = (reps: ReadonlyArray<number>): string => run(['reps', ...reps].join(' '))
const formatWeight = (weight: number): string => run(`weight ${weight}`)

/** What the watch should show for reps that fit: each count followed by two spaces. */
const expectedReps = (reps: ReadonlyArray<number>): string =>
  reps
    .slice(0, maxSets)
    .map((rep) => `${rep}  `)
    .join('')

describe('reps_text_format_reps', () => {
  it('writes each set followed by two spaces', () => {
    expect(formatReps([5, 5, 5, 5, 5])).toBe('5  5  5  5  5  ')
  })

  // The case that overflowed: five two-digit sets fill the buffer exactly.
  it('fits five two-digit sets (5x10)', () => {
    expect(formatReps([10, 10, 10, 10, 10])).toBe('10  10  10  10  10  ')
  })

  it('writes nothing for no sets', () => {
    expect(formatReps([])).toBe('')
  })

  it('shows only the first MAX_SETS (5) sets', () => {
    expect(formatReps([1, 2, 3, 4, 5, 6, 7])).toBe('1  2  3  4  5  ')
  })

  it('matches the expected text for up to two-digit counts', () => {
    fc.assert(
      fc.property(fc.array(fc.integer({ min: 0, max: 99 }), { maxLength: maxSets + 3 }), (reps) => {
        expect(formatReps(reps)).toBe(expectedReps(reps))
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  it('truncates wider counts to a prefix of the full text', () => {
    fc.assert(
      fc.property(
        fc.array(fc.integer({ min: 0, max: 99_999 }), { maxLength: maxSets + 3 }),
        (reps) => {
          const text = formatReps(reps)
          expect(text.length).toBeLessThanOrEqual(maxRepsTextLength)
          expect(expectedReps(reps).startsWith(text)).toBe(true)
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('reps_text_format_weight', () => {
  it.each([
    [45, '45 lbs - 0 lbs / side'],
    [50, '50 lbs - 2.5 lbs / side'],
    [135, '135 lbs - 45 lbs / side'],
    [140, '140 lbs - 47.5 lbs / side'],
  ])('formats %i lbs as %j', (weight, expected) => {
    expect(formatWeight(weight)).toBe(expected)
  })

  // Weights under the 45 lb bar aren't handled yet: they print a truncated,
  // negative per-side weight.
  it('splits the weight above the bar evenly between the two sides', () => {
    fc.assert(
      fc.property(fc.integer({ min: 45, max: 2000 }), (weight) => {
        const match = /^(\d+) lbs - (\d+(?:\.5)?) lbs \/ side$/.exec(formatWeight(weight))
        expect(match?.[1]).toBe(String(weight))
        expect(45 + 2 * Number(match?.[2])).toBe(weight)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

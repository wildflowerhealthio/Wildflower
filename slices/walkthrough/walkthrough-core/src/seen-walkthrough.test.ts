import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Arbitrary, DateTime } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, test } from 'vite-plus/test'
import {
  readSeenWalkthrough,
  SeenWalkthrough,
  seenWalkthroughStorageKey,
  type WalkthroughStorage,
  writeSeenWalkthrough,
} from './seen-walkthrough.ts'

const seenWalkthroughArb = Arbitrary.make(SeenWalkthrough)

const WALKTHROUGH_ID = 'home'

describe('readSeenWalkthrough', () => {
  test('reads unseen when nothing is stored', () => {
    expect(readSeenWalkthrough(memoryStorage(), WALKTHROUGH_ID, 1)).toBeUndefined()
  })

  test('property: reads back the record written for the current version', () => {
    fc.assert(
      fc.property(seenWalkthroughArb, (seenWalkthrough) => {
        const storage = memoryStorage()
        writeSeenWalkthrough(storage, WALKTHROUGH_ID, seenWalkthrough)

        expect(readSeenWalkthrough(storage, WALKTHROUGH_ID, seenWalkthrough.version)).toStrictEqual(
          seenWalkthrough
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test('property: reads unseen when the stored record is for another version', () => {
    fc.assert(
      fc.property(seenWalkthroughArb, fc.integer(), (seenWalkthrough, currentVersion) => {
        fc.pre(currentVersion !== seenWalkthrough.version)
        const storage = memoryStorage()
        writeSeenWalkthrough(storage, WALKTHROUGH_ID, seenWalkthrough)

        expect(readSeenWalkthrough(storage, WALKTHROUGH_ID, currentVersion)).toBeUndefined()
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })

  test.each([
    { label: 'not JSON', stored: 'seen it' },
    { label: 'JSON that is not an object', stored: 'true' },
    {
      label: 'a record missing its outcome',
      stored: JSON.stringify({ version: 1, decidedAt: '2026-10-22T00:00:00.000Z' }),
    },
    {
      label: 'a record with an unknown outcome',
      stored: JSON.stringify({
        version: 1,
        outcome: 'Dismissed',
        decidedAt: '2026-10-22T00:00:00.000Z',
      }),
    },
    {
      label: 'a record with a fractional version',
      stored: JSON.stringify({
        version: 1.5,
        outcome: 'Finished',
        decidedAt: '2026-10-22T00:00:00.000Z',
      }),
    },
  ])('reads unseen when the stored value is $label', ({ stored }) => {
    const storage = memoryStorage()
    storage.setItem(seenWalkthroughStorageKey(WALKTHROUGH_ID), stored)

    expect(readSeenWalkthrough(storage, WALKTHROUGH_ID, 1)).toBeUndefined()
  })

  test('property: reads only the record of the walkthrough it names', () => {
    fc.assert(
      fc.property(
        seenWalkthroughArb,
        fc.string(),
        fc.string(),
        (seenWalkthrough, writtenId, readId) => {
          fc.pre(writtenId !== readId)
          const storage = memoryStorage()
          writeSeenWalkthrough(storage, writtenId, seenWalkthrough)

          expect(readSeenWalkthrough(storage, readId, seenWalkthrough.version)).toBeUndefined()
          expect(readSeenWalkthrough(storage, writtenId, seenWalkthrough.version)).toStrictEqual(
            seenWalkthrough
          )
        }
      ),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('storage failures', () => {
  test('a storage error reaches the caller rather than reading or writing a default', () => {
    const storageError = new Error('storage is disabled')
    const failingStorage: WalkthroughStorage = {
      getItem: () => {
        throw storageError
      },
      setItem: () => {
        throw storageError
      },
    }
    const seenWalkthrough: SeenWalkthrough = {
      version: 1,
      outcome: 'Finished',
      decidedAt: DateTime.unsafeMake('2026-10-22T00:00:00.000Z'),
    }

    expect(() => readSeenWalkthrough(failingStorage, WALKTHROUGH_ID, 1)).toThrow(storageError)
    expect(() => writeSeenWalkthrough(failingStorage, WALKTHROUGH_ID, seenWalkthrough)).toThrow(
      storageError
    )
  })
})

describe('writeSeenWalkthrough', () => {
  test('property: a later record replaces an earlier one', () => {
    fc.assert(
      fc.property(seenWalkthroughArb, seenWalkthroughArb, (earlierRecord, laterRecord) => {
        const storage = memoryStorage()
        writeSeenWalkthrough(storage, WALKTHROUGH_ID, earlierRecord)
        writeSeenWalkthrough(storage, WALKTHROUGH_ID, laterRecord)

        expect(readSeenWalkthrough(storage, WALKTHROUGH_ID, laterRecord.version)).toStrictEqual(
          laterRecord
        )
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// Helpers

/** A {@link WalkthroughStorage} stand-in backed by a `Map`. */
const memoryStorage = (): WalkthroughStorage => {
  const items = new Map<string, string>()
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value)
    },
  }
}

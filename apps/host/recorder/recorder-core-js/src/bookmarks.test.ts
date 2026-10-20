import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { Array, DateTime, Effect, Either, Option } from 'effect'
import * as fc from 'fast-check'
import { describe, expect, it } from 'vite-plus/test'

import golden from '../../recorder-wire-golden.json' with { type: 'json' }
import {
  addBookmark,
  type Bookmark,
  BOOKMARK_ADD_COMMAND,
  BOOKMARK_RECORDED_COMMAND,
  BOOKMARK_REMOVE_COMMAND,
  BOOKMARK_RENAME_COMMAND,
  BOOKMARKS_COMMAND,
  bookmarkUrl,
  BookmarksUnavailable,
  byRecency,
  markBookmarkRecorded,
  readBookmarks,
  removeBookmark,
  renameBookmark,
} from './bookmarks.ts'
import type { InvokeHostCommand } from './save-folder.ts'

/** One host call: the command and its arguments. */
interface HostCall {
  readonly command: string
  readonly args: Record<string, unknown> | undefined
}

/** An `invoke` that records each call and answers with the golden bookmarks. */
const recordingInvoke = (): { readonly invoke: InvokeHostCommand; readonly calls: HostCall[] } => {
  const calls: HostCall[] = []
  return {
    calls,
    invoke: (command, args) => {
      calls.push({ command, args })
      return Promise.resolve(golden.commands.recorder_bookmarks)
    },
  }
}

describe('readBookmarks', () => {
  it('should ask the host for its bookmarks and decode the golden answer', async () => {
    // Arrange
    const host = recordingInvoke()

    // Act
    const bookmarks = await Effect.runPromise(readBookmarks(host.invoke))

    // Assert
    expect(host.calls).toEqual([{ command: BOOKMARKS_COMMAND, args: undefined }])
    expect(Object.keys(golden.commands)).toContain(BOOKMARKS_COMMAND)
    expect(bookmarks).toEqual([
      {
        name: 'LifeLabs reports',
        url: 'https://www.on.mycarecompass.lifelabs.com/reports',
        lastRecordedAt: DateTime.unsafeMake('2026-09-25T14:02:11Z'),
      },
      {
        name: 'Shoppers prescriptions',
        url: 'https://mypharmacy.shoppersdrugmart.ca/en/prescription-dashboard/',
        lastRecordedAt: null,
      },
    ])
  })

  it("should carry the host's reason when it can't read them", async () => {
    // Act
    const result = await Effect.runPromise(
      Effect.either(
        readBookmarks(() =>
          Promise.reject('parsing recorder-bookmarks.json: expected value at line 1 column 1')
        )
      )
    )

    // Assert
    expect(result).toEqual(
      Either.left(
        new BookmarksUnavailable({
          message: 'parsing recorder-bookmarks.json: expected value at line 1 column 1',
        })
      )
    )
  })

  it('should refuse an answer whose bookmark has no name', async () => {
    // Act
    const result = await Effect.runPromise(
      Effect.either(
        readBookmarks(() =>
          Promise.resolve([{ name: '', url: 'https://a.example/', lastRecordedAt: null }])
        )
      )
    )

    // Assert
    expect(Either.isLeft(result)).toBe(true)
  })
})

describe('the bookmark changes', () => {
  const args = golden.commandArgs

  it.each([
    [
      BOOKMARK_ADD_COMMAND,
      (invoke: InvokeHostCommand) =>
        addBookmark(invoke, args.recorder_bookmark_add.name, args.recorder_bookmark_add.url),
    ],
    [
      BOOKMARK_RENAME_COMMAND,
      (invoke: InvokeHostCommand) =>
        renameBookmark(
          invoke,
          args.recorder_bookmark_rename.url,
          args.recorder_bookmark_rename.name
        ),
    ],
    [
      BOOKMARK_REMOVE_COMMAND,
      (invoke: InvokeHostCommand) => removeBookmark(invoke, args.recorder_bookmark_remove.url),
    ],
    [
      BOOKMARK_RECORDED_COMMAND,
      (invoke: InvokeHostCommand) =>
        markBookmarkRecorded(invoke, args.recorder_bookmark_recorded.url),
    ],
  ] as const)(
    '%s should send its golden arguments and decode the answer',
    async (command, change) => {
      // Arrange
      const host = recordingInvoke()

      // Act
      const bookmarks = await Effect.runPromise(change(host.invoke))

      // Assert
      expect(host.calls).toEqual([{ command, args: args[command] }])
      expect(bookmarks.map(({ name }) => name)).toEqual([
        'LifeLabs reports',
        'Shoppers prescriptions',
      ])
    }
  )

  it('should pin every mutating command in the golden file', () => {
    expect(Object.keys(args).toSorted()).toEqual(
      [
        BOOKMARK_ADD_COMMAND,
        BOOKMARK_RECORDED_COMMAND,
        BOOKMARK_REMOVE_COMMAND,
        BOOKMARK_RENAME_COMMAND,
      ].toSorted()
    )
  })

  it("should carry the host's reason for a refused add", async () => {
    // Act
    const result = await Effect.runPromise(
      Effect.either(
        addBookmark(
          () => Promise.reject('https://a.example/ is already bookmarked'),
          'A',
          'https://a.example/'
        )
      )
    )

    // Assert
    expect(result).toEqual(
      Either.left(new BookmarksUnavailable({ message: 'https://a.example/ is already bookmarked' }))
    )
  })
})

describe('byRecency', () => {
  const bookmarkArbitrary: fc.Arbitrary<Bookmark> = fc.record({
    name: fc.string({ minLength: 1, maxLength: 8 }),
    url: fc.webUrl({ validSchemes: ['https'] }),
    lastRecordedAt: fc.option(
      fc
        .integer({ min: 1_700_000_000_000, max: 1_700_000_100_000 })
        .map((millis) => DateTime.unsafeMake(millis)),
      { nil: null }
    ),
  })

  it('should put the most recently recorded first, every never-recorded last, ties by name', () => {
    fc.assert(
      fc.property(fc.array(bookmarkArbitrary, { maxLength: 12 }), (bookmarks) => {
        // Act
        const sorted = byRecency(bookmarks)

        // Assert
        expect(sorted).toHaveLength(bookmarks.length)
        expect(new Set(sorted)).toEqual(new Set(bookmarks))
        for (const [earlier, later] of Array.zip(sorted, sorted.slice(1))) {
          if (earlier.lastRecordedAt === null) {
            expect(later.lastRecordedAt).toBeNull()
          }
          if (earlier.lastRecordedAt !== null && later.lastRecordedAt !== null) {
            expect(DateTime.toEpochMillis(earlier.lastRecordedAt)).toBeGreaterThanOrEqual(
              DateTime.toEpochMillis(later.lastRecordedAt)
            )
          }
          const sameRecency =
            earlier.lastRecordedAt === later.lastRecordedAt ||
            (earlier.lastRecordedAt !== null &&
              later.lastRecordedAt !== null &&
              DateTime.Equivalence(earlier.lastRecordedAt, later.lastRecordedAt))
          if (sameRecency) {
            expect(earlier.name <= later.name).toBe(true)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

describe('bookmarkUrl', () => {
  it('should make the forms with and without a trailing slash one key', () => {
    fc.assert(
      fc.property(fc.domain(), fc.constantFrom('http', 'https'), (domain, scheme) => {
        // Act
        const bare = bookmarkUrl(`${scheme}://${domain}`)
        const slashed = bookmarkUrl(`${scheme}://${domain}/`)

        // Assert
        expect(Option.isSome(bare)).toBe(true)
        expect(bare).toEqual(slashed)
      }),
      { numRuns: numRunsFor({ base: 50 }) }
    )
  })

  it("should have no key for what doesn't parse as a URL", () => {
    expect(bookmarkUrl('https://')).toEqual(Option.none())
    expect(bookmarkUrl('example.com')).toEqual(Option.none())
  })
})

import { Array, Data, DateTime, Effect, Option, Order, Schema } from 'effect'

import { HttpUrl } from './bridge.ts'
import { type InvokeHostCommand, messageOf } from './save-folder.ts'

/**
 * The Recorder's bookmarks, as the host keeps them in
 * `<data root>/recorder-bookmarks.json`: one host command per read or change,
 * each answering with every bookmark after it.
 *
 * @packageDocumentation
 */

/** The host command that answers with every {@link Bookmark}. */
const BOOKMARKS_COMMAND = 'recorder_bookmarks'
/** The host command that bookmarks a URL: `{ name, url }`. */
const BOOKMARK_ADD_COMMAND = 'recorder_bookmark_add'
/** The host command that renames a bookmark: `{ url, name }`. */
const BOOKMARK_RENAME_COMMAND = 'recorder_bookmark_rename'
/** The host command that drops a bookmark: `{ url }`. */
const BOOKMARK_REMOVE_COMMAND = 'recorder_bookmark_remove'
/** The host command that stamps a bookmark as recorded now: `{ url }`. */
const BOOKMARK_RECORDED_COMMAND = 'recorder_bookmark_recorded'

/**
 * A page the user records from, and when a recording last started from it.
 *
 * @remarks
 * Wire: `{"name":"LifeLabs reports","url":"https://…","lastRecordedAt":"2026-09-25T14:02:11Z"}`,
 * `"lastRecordedAt":null` when never recorded, pinned by
 * `recorder-wire-golden.json`, which `recorder-rust`'s `Bookmark` reads too.
 * The URL is the bookmark's key.
 */
const Bookmark = Schema.Struct({
  /** What the page calls it. */
  name: Schema.NonEmptyString,
  /** The page, normalised by {@link bookmarkUrl}. */
  url: HttpUrl,
  /** When a recording last started from exactly this URL; `null` when never. */
  lastRecordedAt: Schema.NullOr(Schema.DateTimeUtc),
})
type Bookmark = typeof Bookmark.Type

const Bookmarks = Schema.Array(Bookmark)

/** The host couldn't read or change the bookmarks, and `message` says why. */
class BookmarksUnavailable extends Data.TaggedError('BookmarksUnavailable')<{
  readonly message: string
}> {}

/** Call a bookmark command and decode its answer, every bookmark. */
const invokeBookmarksCommand = (
  invoke: InvokeHostCommand,
  command: string,
  args?: Record<string, unknown>
): Effect.Effect<readonly Bookmark[], BookmarksUnavailable> =>
  Effect.tryPromise({
    try: () => invoke(command, args),
    catch: (error) => new BookmarksUnavailable({ message: messageOf(error) }),
  }).pipe(
    Effect.flatMap((answer) =>
      Schema.decodeUnknown(Bookmarks)(answer).pipe(
        Effect.mapError((error) => new BookmarksUnavailable({ message: messageOf(error) }))
      )
    )
  )

/**
 * Read every bookmark from the host.
 *
 * @param invoke - Tauri's `invoke`
 * @returns Every bookmark, in the file's order, or {@link BookmarksUnavailable}
 *   with the host's reason
 */
const readBookmarks = (
  invoke: InvokeHostCommand
): Effect.Effect<readonly Bookmark[], BookmarksUnavailable> =>
  invokeBookmarksCommand(invoke, BOOKMARKS_COMMAND)

/**
 * Bookmark `url` as `name`.
 *
 * @param invoke - Tauri's `invoke`
 * @param name - what the page will call it
 * @param url - the page, already through {@link bookmarkUrl}
 * @returns Every bookmark after the add, or {@link BookmarksUnavailable} with
 *   the host's reason, such as the URL being bookmarked already
 */
const addBookmark = (
  invoke: InvokeHostCommand,
  name: string,
  url: string
): Effect.Effect<readonly Bookmark[], BookmarksUnavailable> =>
  invokeBookmarksCommand(invoke, BOOKMARK_ADD_COMMAND, { name, url })

/**
 * Call the bookmark at `url` `name`.
 *
 * @param invoke - Tauri's `invoke`
 * @param url - the bookmark's URL
 * @param name - its new name
 * @returns Every bookmark after the rename, or {@link BookmarksUnavailable}
 *   with the host's reason
 */
const renameBookmark = (
  invoke: InvokeHostCommand,
  url: string,
  name: string
): Effect.Effect<readonly Bookmark[], BookmarksUnavailable> =>
  invokeBookmarksCommand(invoke, BOOKMARK_RENAME_COMMAND, { url, name })

/**
 * Drop the bookmark at `url`.
 *
 * @param invoke - Tauri's `invoke`
 * @param url - the bookmark's URL
 * @returns Every bookmark left, or {@link BookmarksUnavailable} with the
 *   host's reason
 */
const removeBookmark = (
  invoke: InvokeHostCommand,
  url: string
): Effect.Effect<readonly Bookmark[], BookmarksUnavailable> =>
  invokeBookmarksCommand(invoke, BOOKMARK_REMOVE_COMMAND, { url })

/**
 * Tell the host a recording started from `url`. The host stamps the bookmark
 * at exactly that URL with its own clock; a URL that isn't bookmarked changes
 * nothing.
 *
 * @param invoke - Tauri's `invoke`
 * @param url - the recorded page, already through {@link bookmarkUrl}
 * @returns Every bookmark after the stamp, or {@link BookmarksUnavailable}
 *   with the host's reason
 */
const markBookmarkRecorded = (
  invoke: InvokeHostCommand,
  url: string
): Effect.Effect<readonly Bookmark[], BookmarksUnavailable> =>
  invokeBookmarksCommand(invoke, BOOKMARK_RECORDED_COMMAND, { url })

/**
 * Most recently recorded first, never recorded last, ties by name.
 */
const RecencyOrder: Order.Order<Bookmark> = Order.combine(
  Order.mapInput(Order.reverse(Option.getOrder(DateTime.Order)), (bookmark: Bookmark) =>
    Option.fromNullable(bookmark.lastRecordedAt)
  ),
  Order.mapInput(Order.string, (bookmark: Bookmark) => bookmark.name)
)

/**
 * `bookmarks` sorted for the page: most recently recorded first, never
 * recorded last, ties by name.
 *
 * @param bookmarks - the host's bookmarks
 * @returns A sorted copy
 */
const byRecency = (bookmarks: readonly Bookmark[]): readonly Bookmark[] =>
  Array.sort(bookmarks, RecencyOrder)

/**
 * `url` as a bookmark's key: the URL parser's own spelling, so
 * `https://a.example` and `https://a.example/` are one bookmark.
 *
 * @param url - a URL the user typed or picked
 * @returns The normalised URL, or `None` when `url` doesn't parse as one
 */
const bookmarkUrl = (url: string): Option.Option<string> =>
  URL.canParse(url) ? Option.some(new URL(url).href) : Option.none()

export {
  addBookmark,
  Bookmark,
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
}

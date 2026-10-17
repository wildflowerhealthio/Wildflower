import {
  addBookmark,
  type Bookmark,
  type BookmarksUnavailable,
  type InvokeHostCommand,
  markBookmarkRecorded,
  readBookmarks,
  removeBookmark,
  renameBookmark,
} from '@wildflowerhealthio/recorder-core-js'
import { Effect, Either, type Option } from 'effect'
import { useCallback, useEffect, useRef, useState } from 'react'

/** The bookmarks, as the page shows them. */
type BookmarksState =
  | { readonly _tag: 'Reading' }
  | { readonly _tag: 'Read'; readonly bookmarks: readonly Bookmark[] }
  /** The host couldn't read them, or its answer didn't decode; `message` says why. */
  | { readonly _tag: 'Unreadable'; readonly message: string }

/**
 * A bookmark change: `None` once the host's answer has replaced the list, or
 * the host's refusal for the page to show.
 */
type BookmarkChange = Promise<Option.Option<BookmarksUnavailable>>

/** What {@link useBookmarks} gives the page. */
interface Bookmarks {
  readonly state: BookmarksState
  /** Whether a change is waiting on the host, so the page holds the others. */
  readonly isChanging: boolean
  /** Bookmark `url`, already through `bookmarkUrl`, as `name`. */
  readonly add: (name: string, url: string) => BookmarkChange
  /** Call the bookmark at `url` `name`. */
  readonly rename: (url: string, name: string) => BookmarkChange
  /** Drop the bookmark at `url`. */
  readonly remove: (url: string) => BookmarkChange
  /** Tell the host a recording started from `url`, already through `bookmarkUrl`. */
  readonly recorded: (url: string) => BookmarkChange
}

/**
 * The Recorder's bookmarks: read from the host once, when the page mounts,
 * and replaced by the host's answer to each change.
 *
 * @remarks
 * An answer lands only if no later request's answer has landed already, so a
 * slow read or change can't overwrite the list a later one answered with. A
 * refused change lands nothing, so it never holds back an earlier answer: the
 * read on mount still lands when a change made before it answers is refused.
 *
 * @param invoke - Tauri's `invoke`
 */
const useBookmarks = (invoke: InvokeHostCommand): Bookmarks => {
  const [state, setState] = useState<BookmarksState>({ _tag: 'Reading' })
  const [changesInFlight, setChangesInFlight] = useState(0)
  const requestsMade = useRef(0)
  const lastLandedRequest = useRef(0)
  const mounted = useRef(true)

  /**
   * Run `request`, and put its answer in place unless a later request's
   * answer already has: the bookmarks, or, for the read on mount, why there
   * are none. A refused change puts nothing in place.
   */
  const settle = useCallback(
    (
      request: Effect.Effect<readonly Bookmark[], BookmarksUnavailable>,
      refusal: 'leaves the list' | 'is unreadable'
    ): Promise<Either.Either<readonly Bookmark[], BookmarksUnavailable>> => {
      requestsMade.current += 1
      const thisRequest = requestsMade.current
      return Effect.runPromise(Effect.either(request)).then((answer) => {
        const lands =
          mounted.current &&
          thisRequest > lastLandedRequest.current &&
          (Either.isRight(answer) || refusal === 'is unreadable')
        if (lands) {
          lastLandedRequest.current = thisRequest
          setState(
            Either.match(answer, {
              onRight: (bookmarks): BookmarksState => ({ _tag: 'Read', bookmarks }),
              onLeft: ({ message }): BookmarksState => ({ _tag: 'Unreadable', message }),
            })
          )
        }
        return answer
      })
    },
    []
  )

  useEffect(() => {
    mounted.current = true
    void settle(readBookmarks(invoke), 'is unreadable')
    return () => {
      mounted.current = false
    }
  }, [invoke, settle])

  /** Run a change, counting it as in flight, and hand back its refusal. */
  const change = useCallback(
    (request: Effect.Effect<readonly Bookmark[], BookmarksUnavailable>): BookmarkChange => {
      setChangesInFlight((count) => count + 1)
      return settle(request, 'leaves the list').then((answer) => {
        if (mounted.current) setChangesInFlight((count) => count - 1)
        return Either.getLeft(answer)
      })
    },
    [settle]
  )

  return {
    state,
    isChanging: changesInFlight > 0,
    add: (name, url) => change(addBookmark(invoke, name, url)),
    rename: (url, name) => change(renameBookmark(invoke, url, name)),
    remove: (url) => change(removeBookmark(invoke, url)),
    recorded: (url) => change(markBookmarkRecorded(invoke, url)),
  }
}

export { useBookmarks }
export type { BookmarkChange, Bookmarks, BookmarksState }

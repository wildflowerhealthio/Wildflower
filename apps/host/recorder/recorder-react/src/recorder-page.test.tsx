import { act, cleanup, render, screen, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { MessageHandler } from '@wildflowerhealthio/effect-messaging-core'
import type { HandlerCoordinator } from '@wildflowerhealthio/effect-messaging-react'
import { HandlerCoordinatorContext } from '@wildflowerhealthio/effect-messaging-react'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import {
  BOOKMARK_ADD_COMMAND,
  BOOKMARK_RECORDED_COMMAND,
  BOOKMARK_REMOVE_COMMAND,
  BOOKMARK_RENAME_COMMAND,
  BOOKMARKS_COMMAND,
  SAVE_FOLDER_COMMAND,
} from '@wildflowerhealthio/recorder-core-js'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import golden from '../../recorder-wire-golden.json' with { type: 'json' }
import { RecorderPage } from './recorder-page.tsx'
import { RecorderProvider } from './recorder-provider.tsx'
import type { RecorderSender } from './recorder-sender-context.ts'
import { RecorderSenderProvider } from './recorder-sender-provider.tsx'

/**
 * The page's affordances, over a coordinator that really holds the registered
 * handler records so the host's side of a recording can be played back into it.
 * The state machine itself is covered in `use-recorder.test.tsx`; what is
 * asserted here is only what the user can see and press.
 */

/**
 * jsdom has no native `<dialog>`: `showModal` and `close` are modelled as the
 * `open` attribute, and the original descriptors are put back after each test.
 */
const dialogMethodDescriptors = (['showModal', 'close'] as const).map(
  (method) =>
    [method, Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method)] as const
)

/** `HTMLDialogElement.showModal` as jsdom lacks it: the dialog gains `open`. */
function showModalAsOpen(this: HTMLDialogElement): void {
  this.setAttribute('open', '')
}

/** `HTMLDialogElement.close` as jsdom lacks it: the dialog loses `open`, and fires `close`. */
function closeAsNotOpen(this: HTMLDialogElement): void {
  this.removeAttribute('open')
  this.dispatchEvent(new Event('close'))
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = showModalAsOpen
  HTMLDialogElement.prototype.close = closeAsNotOpen
})

// Each test renders its own page; clear the previous one so the role queries
// (which throw on multiple matches) see one page at a time.
afterEach(() => {
  cleanup()
  vi.useRealTimers()
  for (const [method, descriptor] of dialogMethodDescriptors) {
    if (descriptor === undefined) Reflect.deleteProperty(HTMLDialogElement.prototype, method)
    else Object.defineProperty(HTMLDialogElement.prototype, method, descriptor)
  }
})

describe('RecorderPage', () => {
  it('should keep Start disabled until the URL is one the sniffer will open', async () => {
    // Arrange
    const { user } = renderPage()
    const url = screen.getByLabelText('URL')

    // Act
    await user.type(url, 'https://example.com')

    // Assert
    expect(isStartDisabled()).toBe(false)
  })

  it('should never enable Start for a URL the bridge would refuse', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.oneof(
          fc.constant('ftp://files.example.com'),
          fc.constant('javascript:alert(1)'),
          fc.constant('file:///etc/passwd'),
          fc.webPath()
        ),
        async (refused) => {
          // Arrange
          const { user } = renderPage()

          // Act
          await typeLiterally(user, screen.getByLabelText('URL'), refused)

          // Assert
          expect(isStartDisabled()).toBe(true)
          cleanup()
        }
      ),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('should offer Stop & Save only while recording', async () => {
    // Arrange
    const { user } = renderPage()
    await user.type(screen.getByLabelText('URL'), 'https://example.com')

    // Assert
    expect(screen.queryByRole('button', { name: 'Stop & Save' })).toBeNull()

    // Act
    await user.click(startButton())

    // Assert
    expect(screen.getByRole('button', { name: 'Stop & Save' })).toBeDefined()
    expect(screen.getByRole('status').textContent).toBe('0 responses recorded')
  })

  it('should disable the URL field while recording', async () => {
    // Arrange
    const harness = renderPage()
    await harness.user.type(screen.getByLabelText('URL'), 'https://example.com')

    // Act
    await harness.user.click(startButton())

    // Assert
    expect(screen.getByLabelText('URL').hasAttribute('disabled')).toBe(true)
  })

  it('should show the error banner when the host refuses to write', async () => {
    // Arrange
    const harness = renderPage()
    await harness.user.type(screen.getByLabelText('URL'), 'https://example.com')
    await harness.user.click(startButton())
    await harness.user.click(screen.getByRole('button', { name: 'Stop & Save' }))
    const fileName = harness.savedFileNames[0] ?? ''

    // Act
    await act(async () => {
      await Effect.runPromise(
        harness.deliver({
          _tag: 'HarSaveFailed',
          fileName,
          message: 'the recordings folder is not writable',
        })
      )
    })

    // Assert
    expect(screen.getByRole('alert').textContent).toContain('the recordings folder is not writable')
  })

  it('should show where the host wrote the recording', async () => {
    // Arrange
    const harness = renderPage()
    await harness.user.type(screen.getByLabelText('URL'), 'https://example.com')
    await harness.user.click(startButton())

    // Act
    await harness.user.click(screen.getByRole('button', { name: 'Stop & Save' }))
    const fileName = harness.savedFileNames[0] ?? ''
    await act(async () => {
      await Effect.runPromise(
        harness.deliver({
          _tag: 'HarSaved',
          fileName,
          path: `/home/user/Documents/Wildflower Recordings/${fileName}`,
        })
      )
    })

    // Assert
    expect(screen.getByRole('status').textContent).toBe(
      `Saved to /home/user/Documents/Wildflower Recordings/${fileName}`
    )
  })

  it('should show the saved path above the buttons, with Show file beside Start', async () => {
    // Arrange
    const harness = renderPage()

    // Act
    await saveOneRecording(harness)

    // Assert
    const status = screen.getByRole('status')
    const showFile = screen.getByRole('button', { name: 'Show file' })
    expect(
      status.compareDocumentPosition(startButton()) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy()
    expect(showFile.parentElement).toBe(startButton().parentElement)
  })

  it('should show the folder recordings are saved to', async () => {
    // Act
    renderPage()

    // Assert
    const folder = await screen.findByText(DESKTOP_SAVE_FOLDER.path)
    expect(folder.parentElement?.textContent).toBe(
      `Recordings are saved to ${DESKTOP_SAVE_FOLDER.path}`
    )
  })

  it("should say why recordings can't be saved when the host has no folder", async () => {
    // Act
    renderPage({ saveFolder: () => Promise.reject('no recordings folder: no Documents') })

    // Assert
    expect((await screen.findByRole('alert')).textContent).toBe(
      "Recordings can't be saved on this device: no recordings folder: no Documents"
    )
  })

  it('should reveal the saved file on Show file', async () => {
    // Arrange
    const harness = renderPage()
    const path = await saveOneRecording(harness)

    // Act
    await harness.user.click(screen.getByRole('button', { name: 'Show file' }))

    // Assert
    expect(harness.revealedPaths).toEqual([path])
  })

  it("should say so when the file can't be shown", async () => {
    // Arrange
    const harness = renderPage({
      revealFile: () => Promise.reject(new Error('no file manager')),
    })
    await saveOneRecording(harness)

    // Act
    await harness.user.click(screen.getByRole('button', { name: 'Show file' }))

    // Assert
    expect((await screen.findByRole('alert')).textContent).toContain(
      "The file couldn't be shown: no file manager"
    )
  })

  it("should offer no Show file where the platform can't reveal one", async () => {
    // Arrange
    const harness = renderPage({
      saveFolder: () =>
        Promise.resolve({
          path: '/storage/emulated/0/Documents/Wildflower Recordings',
          revealsFiles: false,
        }),
    })

    // Act
    await saveOneRecording(harness)

    // Assert
    expect(screen.queryByRole('button', { name: 'Show file' })).toBeNull()
  })

  describe('bookmarks', () => {
    it('should list the bookmarks most recently recorded first, saying when each was', async () => {
      // Arrange
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-16T12:00:00Z'))

      // Act
      renderPage({ bookmarks: [SHOPPERS, LIFELABS] })

      // Assert
      const rows = await screen.findAllByRole('listitem')
      // Each row's first button is the bookmark itself; its menu comes after.
      expect(rows.map((row) => row.querySelector('button')?.textContent)).toEqual([
        `${LIFELABS.name}last recorded 2 weeks ago${LIFELABS.url}`,
        `${SHOPPERS.name}never recorded${SHOPPERS.url}`,
      ])
    })

    it("should fill the URL field with a bookmark's URL when its name is pressed", async () => {
      // Arrange
      const harness = renderPage()

      // Act
      await harness.user.click(await bookmarkRow(LIFELABS.name))

      // Assert
      expect(screen.getByLabelText<HTMLInputElement>('URL').value).toBe(LIFELABS.url)
      expect(harness.bookmarkCalls.map(({ command }) => command)).toEqual([BOOKMARKS_COMMAND])
    })

    it('should bookmark the URL under the name the user gives it', async () => {
      // Arrange
      const harness = renderPage()
      await screen.findByText(LIFELABS.name)
      await harness.user.type(screen.getByLabelText('URL'), 'https://lab.example')
      await harness.user.click(screen.getByRole('button', { name: 'Bookmark this' }))
      const name = screen.getByLabelText<HTMLInputElement>('Bookmark name')
      expect(name.value).toBe('lab.example')

      // Act
      await harness.user.clear(name)
      await harness.user.type(name, 'Lab results')
      await harness.user.click(screen.getByRole('button', { name: 'Save' }))

      // Assert
      expect(harness.bookmarkCalls.at(-1)).toEqual({
        command: BOOKMARK_ADD_COMMAND,
        args: { name: 'Lab results', url: 'https://lab.example/' },
      })
      expect(await screen.findByText('Lab results')).toBeDefined()
      expect(screen.queryByLabelText('Bookmark name')).toBeNull()
      expect(screen.queryByRole('button', { name: 'Bookmark this' })).toBeNull()
    })

    it.each([
      ['bookmarked', LIFELABS.url],
      ['not http(s)', 'ftp://lab.example'],
      ['not a URL', 'https://'],
    ])('should offer no Bookmark this for a URL that is %s', async (_why, unbookmarkable) => {
      // Arrange
      const harness = renderPage()
      await screen.findByText(LIFELABS.name)

      // Act
      await harness.user.type(screen.getByLabelText('URL'), unbookmarkable)

      // Assert
      expect(screen.queryByRole('button', { name: 'Bookmark this' })).toBeNull()
    })

    it('should offer Bookmark this after a save, for the URL just recorded', async () => {
      // Arrange
      const harness = renderPage()
      await screen.findByText(LIFELABS.name)

      // Act
      await saveOneRecording(harness)

      // Assert
      expect(screen.getByRole('button', { name: 'Bookmark this' })).toBeDefined()
    })

    it('should rename a bookmark and show the renamed list', async () => {
      // Arrange
      const harness = renderPage()
      await harness.user.click(
        await screen.findByRole('button', { name: `Actions for ${LIFELABS.name}` })
      )
      await harness.user.click(screen.getByRole('menuitem', { name: 'Rename' }))
      const name = screen.getByLabelText(`New name for ${LIFELABS.name}`)

      // Act
      await harness.user.clear(name)
      await harness.user.type(name, 'LifeLabs results')
      await harness.user.click(screen.getByRole('button', { name: 'Save' }))

      // Assert
      expect(harness.bookmarkCalls.at(-1)).toEqual({
        command: BOOKMARK_RENAME_COMMAND,
        args: { url: LIFELABS.url, name: 'LifeLabs results' },
      })
      expect(await screen.findByText('LifeLabs results')).toBeDefined()
      expect(screen.queryByText(LIFELABS.name)).toBeNull()
      expect(screen.queryByLabelText(`New name for ${LIFELABS.name}`)).toBeNull()
    })

    it('should ask before removing a bookmark, and keep it on Cancel', async () => {
      // Arrange
      const harness = renderPage()
      await harness.user.click(
        await screen.findByRole('button', { name: `Actions for ${SHOPPERS.name}` })
      )

      // Act
      await harness.user.click(screen.getByRole('menuitem', { name: 'Remove' }))
      const dialog = screen.getByRole('dialog')
      expect(dialog.textContent).toContain(`Remove the bookmark "${SHOPPERS.name}"?`)
      await harness.user.click(within(dialog).getByRole('button', { name: 'Cancel' }))

      // Assert
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(harness.bookmarkCalls.at(-1)?.command).not.toBe(BOOKMARK_REMOVE_COMMAND)
      expect(screen.getByText(SHOPPERS.name)).toBeDefined()
    })

    it('should remove a bookmark once confirmed and show the list without it', async () => {
      // Arrange
      const harness = renderPage()
      await harness.user.click(
        await screen.findByRole('button', { name: `Actions for ${SHOPPERS.name}` })
      )
      await harness.user.click(screen.getByRole('menuitem', { name: 'Remove' }))

      // Act
      await harness.user.click(
        within(screen.getByRole('dialog')).getByRole('button', { name: 'Remove' })
      )

      // Assert
      expect(harness.bookmarkCalls.at(-1)).toEqual({
        command: BOOKMARK_REMOVE_COMMAND,
        args: { url: SHOPPERS.url },
      })
      await vi.waitFor(() => {
        expect(screen.queryByText(SHOPPERS.name)).toBeNull()
      })
      expect(screen.queryByRole('dialog')).toBeNull()
      expect(screen.getAllByRole('listitem')).toHaveLength(1)
    })

    it('should tell the host which URL a recording started from', async () => {
      // Arrange
      const harness = renderPage()
      await harness.user.click(await bookmarkRow(LIFELABS.name))

      // Act
      await harness.user.click(startButton())

      // Assert
      expect(harness.bookmarkCalls.at(-1)).toEqual({
        command: BOOKMARK_RECORDED_COMMAND,
        args: { url: LIFELABS.url },
      })
      const row = (await bookmarkRow(LIFELABS.name)).closest('li')
      expect(within(row ?? document.body).getByText('last recorded now')).toBeDefined()
    })

    it("should say why bookmarks can't be read, and still record", async () => {
      // Arrange
      const harness = renderPage({
        bookmarkCommand: () => Promise.reject('parsing recorder-bookmarks.json: expected value'),
      })
      expect((await screen.findByRole('alert')).textContent).toBe(
        "Bookmarks can't be read on this device: parsing recorder-bookmarks.json: expected value"
      )
      await harness.user.type(screen.getByLabelText('URL'), 'https://example.com')

      // Act
      await harness.user.click(startButton())

      // Assert
      expect(screen.getByRole('button', { name: 'Stop & Save' })).toBeDefined()
      expect(screen.getAllByRole('alert')).toHaveLength(1)
    })

    it('should still show the read bookmarks when a stamp sent before they arrive is refused', async () => {
      // Arrange
      const read = Promise.withResolvers<unknown>()
      const harness = renderPage({
        bookmarkCommand: (command) =>
          command === BOOKMARKS_COMMAND
            ? read.promise
            : Promise.reject('replacing recorder-bookmarks.json: disk full'),
      })
      await harness.user.type(screen.getByLabelText('URL'), 'https://example.com')
      await harness.user.click(startButton())
      expect((await screen.findByRole('alert')).textContent).toContain('disk full')

      // Act
      await act(async () => {
        read.resolve([LIFELABS])
        await read.promise
      })

      // Assert
      expect(await screen.findByText(LIFELABS.name)).toBeDefined()
      expect(screen.queryByText('Reading the bookmarks…')).toBeNull()
    })

    it("should show the host's reason when it refuses a bookmark", async () => {
      // Arrange
      const harness = renderPage({
        bookmarkCommand: (command, args) =>
          command === BOOKMARK_ADD_COMMAND
            ? Promise.reject(`${String(args?.['url'])} is already bookmarked`)
            : Promise.resolve([LIFELABS]),
      })
      await screen.findByText(LIFELABS.name)
      await harness.user.type(screen.getByLabelText('URL'), 'https://lab.example')
      await harness.user.click(screen.getByRole('button', { name: 'Bookmark this' }))

      // Act
      await harness.user.click(screen.getByRole('button', { name: 'Save' }))

      // Assert
      expect((await screen.findByRole('alert')).textContent).toContain(
        'https://lab.example/ is already bookmarked'
      )
      expect(screen.getByLabelText('Bookmark name')).toBeDefined()
    })
  })
})

// Helpers

/** Record nothing from example.com, stop, and have the host answer that it saved; the saved path. */
const saveOneRecording = async (harness: PageHarness): Promise<string> => {
  // Let the folder's read settle, so Show file's offer follows the host's answer.
  await act(async () => {})
  await harness.user.type(screen.getByLabelText('URL'), 'https://example.com')
  await harness.user.click(startButton())
  await harness.user.click(screen.getByRole('button', { name: 'Stop & Save' }))
  const fileName = harness.savedFileNames[0] ?? ''
  const path = `${DESKTOP_SAVE_FOLDER.path}/${fileName}`
  await act(async () => {
    await Effect.runPromise(harness.deliver({ _tag: 'HarSaved', fileName, path }))
  })
  return path
}

/**
 * Type `text` into `element` character for character.
 *
 * @remarks
 * `user.type` reads `{` and `[` as the start of a key descriptor (`{Enter}`);
 * doubling them types the literal character instead, which is what a URL
 * fragment out of `fc.webPath()` needs.
 */
const typeLiterally = async (
  user: ReturnType<typeof userEvent.setup>,
  element: HTMLElement,
  text: string
): Promise<void> => {
  // `user.type` rejects an empty string; leaving the field untouched is the
  // same state an empty URL would produce anyway.
  if (text === '') return
  await user.type(element, text.replaceAll('{', '{{').replaceAll('[', '[['))
}

/** A bookmark's row, which fills the URL field, found by the bookmark's name. */
const bookmarkRow = async (name: string): Promise<HTMLElement> => {
  const row = (await screen.findByText(name)).closest('button')
  if (row === null) throw new Error(`No row for the bookmark ${name}`)
  return row
}

/** The Start control. */
const startButton = (): HTMLElement => screen.getByRole('button', { name: 'Start recording' })

/** Whether Start refuses to be pressed, read off the DOM rather than a cast. */
const isStartDisabled = (): boolean => startButton().hasAttribute('disabled')

/**
 * The routing-erased view of a typed handler record — what a tag→handler map
 * can hold.
 *
 * @remarks
 * A `BridgeHandlerRecord`'s handlers take `never`, so calling one back needs
 * the shape the transport dispatches through re-imposed: the same erasure
 * the Tauri transport's dispatch performs.
 */
const erase = (handlers: object): MessageHandler.AnyHandlers =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  handlers as MessageHandler.AnyHandlers

/** A decoded host→web message, as the transport hands one to a handler. */
type HostMessage = { readonly _tag: string; readonly [field: string]: unknown }

/** One bookmark command the page sent the host. */
interface BookmarkCall {
  readonly command: string
  readonly args: Record<string, unknown> | undefined
}

interface PageHarness {
  readonly user: ReturnType<typeof userEvent.setup>
  readonly savedFileNames: string[]
  readonly revealedPaths: string[]
  readonly bookmarkCalls: BookmarkCall[]
  readonly deliver: (message: HostMessage) => Effect.Effect<void>
}

/** A bookmark as the host sends it. */
type WireBookmark = (typeof golden.commands.recorder_bookmarks)[number]

/** What the fake host does when asked for the recordings folder, to reveal a file, and about bookmarks. */
interface FakeHost {
  readonly saveFolder?: () => Promise<unknown>
  readonly revealFile?: (path: string) => Promise<void>
  /** The bookmarks the default bookmark host starts with: the golden ones. */
  readonly bookmarks?: readonly WireBookmark[]
  /** Answer a bookmark command in place of the default, in-memory host. */
  readonly bookmarkCommand?: (
    command: string,
    args: Record<string, unknown> | undefined
  ) => Promise<unknown>
}

/** The desktop's answer, from the golden file both languages read. */
const DESKTOP_SAVE_FOLDER = golden.commands.recorder_save_folder

/** The golden answer's bookmark at `index`. */
const goldenBookmark = (index: number): WireBookmark => {
  const bookmark = golden.commands.recorder_bookmarks[index]
  if (bookmark === undefined) throw new Error(`the golden file has no bookmark ${index}`)
  return bookmark
}

/** The golden bookmarks: one recorded, one never. */
const LIFELABS = goldenBookmark(0)
const SHOPPERS = goldenBookmark(1)

/** When the in-memory host stamps a recording: the clock, as the real host reads it. */
const stampNow = (): string => new Date().toISOString()

/**
 * A host that keeps `initial` in memory and changes it as `recorder-rust`'s
 * `JsonBookmarks` does, answering every command with the whole list.
 */
const inMemoryBookmarkHost = (
  initial: readonly WireBookmark[]
): NonNullable<FakeHost['bookmarkCommand']> => {
  let bookmarks = [...initial]
  const argument = (args: Record<string, unknown> | undefined, field: string): string =>
    String(args?.[field])
  return (command, args) => {
    const url = argument(args, 'url')
    switch (command) {
      case BOOKMARKS_COMMAND:
        break
      case BOOKMARK_ADD_COMMAND:
        bookmarks = [...bookmarks, { name: argument(args, 'name'), url, lastRecordedAt: null }]
        break
      case BOOKMARK_RENAME_COMMAND:
        bookmarks = bookmarks.map((bookmark) =>
          bookmark.url === url ? { ...bookmark, name: argument(args, 'name') } : bookmark
        )
        break
      case BOOKMARK_REMOVE_COMMAND:
        bookmarks = bookmarks.filter((bookmark) => bookmark.url !== url)
        break
      case BOOKMARK_RECORDED_COMMAND:
        bookmarks = bookmarks.map((bookmark) =>
          bookmark.url === url ? { ...bookmark, lastRecordedAt: stampNow() } : bookmark
        )
        break
      default:
        return Promise.reject(new Error(`no ${command} on this fake host`))
    }
    return Promise.resolve(bookmarks)
  }
}

/** Render the page over a coordinator and senders that record what they see. */
const renderPage = (host: FakeHost = {}): PageHarness => {
  const registered = new Map<string, MessageHandler.AnyHandlers>()
  const savedFileNames: string[] = []
  const coordinator: HandlerCoordinator = {
    register: (bridge, handlers) =>
      Effect.sync(() => {
        registered.set(bridge.name, erase(handlers))
      }),
    unregister: (bridge, handlers) =>
      Effect.sync(() => {
        if (Object.is(registered.get(bridge.name), erase(handlers))) {
          registered.delete(bridge.name)
        }
      }),
  }
  const send: RecorderSender = (message) =>
    Effect.sync(() => {
      if (message._tag === 'SaveHar') savedFileNames.push(message.fileName)
    })
  const revealedPaths: string[] = []
  const bookmarkCalls: BookmarkCall[] = []
  const bookmarkCommand =
    host.bookmarkCommand ?? inMemoryBookmarkHost(host.bookmarks ?? [LIFELABS, SHOPPERS])
  const invoke = (command: string, args?: Record<string, unknown>): Promise<unknown> => {
    if (command === SAVE_FOLDER_COMMAND) {
      return (host.saveFolder ?? (() => Promise.resolve(DESKTOP_SAVE_FOLDER)))()
    }
    bookmarkCalls.push({ command, args })
    return bookmarkCommand(command, args)
  }
  const revealFile = (path: string): Promise<void> => {
    revealedPaths.push(path)
    return host.revealFile?.(path) ?? Promise.resolve()
  }
  render(
    <HandlerCoordinatorContext.Provider value={coordinator}>
      <RecorderSenderProvider send={send}>
        <RecorderProvider>
          <RecorderPage invoke={invoke} revealFile={revealFile} />
        </RecorderProvider>
      </RecorderSenderProvider>
    </HandlerCoordinatorContext.Provider>
  )
  return {
    // No timer between keystrokes: the property types many generated URLs.
    user: userEvent.setup({ delay: null }),
    savedFileNames,
    revealedPaths,
    bookmarkCalls,
    deliver: (message) => {
      const handler = registered.get('Recorder')?.[message._tag]
      if (handler === undefined) throw new Error(`no Recorder handler for ${message._tag}`)
      return handler(message)
    },
  }
}

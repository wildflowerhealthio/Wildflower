import { act, cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { MessageHandler } from '@wildflowerhealthio/effect-messaging-core'
import type { HandlerCoordinator } from '@wildflowerhealthio/effect-messaging-react'
import { HandlerCoordinatorContext } from '@wildflowerhealthio/effect-messaging-react'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { SAVE_FOLDER_COMMAND } from '@wildflowerhealthio/recorder-core-js'
import { Effect } from 'effect'
import * as fc from 'fast-check'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import golden from '../../recorder-wire-golden.json' with { type: 'json' }
import { RecorderPage } from './recorder-page.tsx'
import type { RecorderSender } from './recorder-sender-context.ts'
import { RecorderSenderProvider } from './recorder-sender-provider.tsx'

/**
 * The page's affordances, over a coordinator that really holds the registered
 * handler records so the host's side of a recording can be played back into it.
 * The state machine itself is covered in `use-recorder.test.tsx`; what is
 * asserted here is only what the user can see and press.
 */

// Each test renders its own page; clear the previous one so the role queries
// (which throw on multiple matches) see one page at a time.
afterEach(() => {
  cleanup()
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

interface PageHarness {
  readonly user: ReturnType<typeof userEvent.setup>
  readonly savedFileNames: string[]
  readonly revealedPaths: string[]
  readonly deliver: (message: HostMessage) => Effect.Effect<void>
}

/** What the fake host does when asked for the recordings folder, and to reveal a file. */
interface FakeHost {
  readonly saveFolder?: () => Promise<unknown>
  readonly revealFile?: (path: string) => Promise<void>
}

/** The desktop's answer, from the golden file both languages read. */
const DESKTOP_SAVE_FOLDER = golden.commands.recorder_save_folder

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
  const invoke = (command: string): Promise<unknown> =>
    command === SAVE_FOLDER_COMMAND
      ? (host.saveFolder ?? (() => Promise.resolve(DESKTOP_SAVE_FOLDER)))()
      : Promise.reject(new Error(`no ${command} on this fake host`))
  const revealFile = (path: string): Promise<void> => {
    revealedPaths.push(path)
    return host.revealFile?.(path) ?? Promise.resolve()
  }
  render(
    <HandlerCoordinatorContext.Provider value={coordinator}>
      <RecorderSenderProvider send={send}>
        <RecorderPage invoke={invoke} revealFile={revealFile} />
      </RecorderSenderProvider>
    </HandlerCoordinatorContext.Provider>
  )
  return {
    // No timer between keystrokes: the property types many generated URLs.
    user: userEvent.setup({ delay: null }),
    savedFileNames,
    revealedPaths,
    deliver: (message) => {
      const handler = registered.get('Recorder')?.[message._tag]
      if (handler === undefined) throw new Error(`no Recorder handler for ${message._tag}`)
      return handler(message)
    },
  }
}

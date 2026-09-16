import { act, cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { CollectorSenderProvider, type CollectorSender } from 'collector-react'
import { Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { HandlerCoordinator } from 'effect-messaging-react'
import { HandlerCoordinatorContext } from 'effect-messaging-react'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import type { HarRecorderSender } from '../../../har-recorder-sender-context.ts'
import { HarRecorderSenderProvider } from '../../../har-recorder-sender-provider.tsx'
import { HarRecorderPage } from './index.tsx'

/**
 * The page's affordances, over a coordinator that really holds the registered
 * handler records so the host's side of a recording can be played back into it.
 * The state machine itself is covered in `use-har-recorder.test.tsx`; what is
 * asserted here is only what the user can see and press.
 */

// Each test renders its own page; clear the previous one so the role queries
// (which throw on multiple matches) see one page at a time.
afterEach(() => {
  cleanup()
})

describe('HarRecorderPage', () => {
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
        harness.deliver('HarRecorder', {
          _tag: 'HarSaveFailed',
          fileName,
          message: 'saved_data is not writable',
        })
      )
    })

    // Assert
    expect(screen.getByRole('alert').textContent).toContain('saved_data is not writable')
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
        harness.deliver('HarRecorder', {
          _tag: 'HarSaved',
          fileName,
          path: `/home/user/saved_data/${fileName}`,
        })
      )
    })

    // Assert
    expect(screen.getByRole('status').textContent).toBe(
      `Saved to /home/user/saved_data/${fileName}`
    )
  })
})

// Helpers

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
 * `makeHandlerCoordinator`'s `recompose` performs.
 */
const erase = (handlers: object): MessageHandler.AnyHandlers =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  handlers as MessageHandler.AnyHandlers

/** A decoded host→web message, as the transport hands one to a handler. */
type HostMessage = { readonly _tag: string; readonly [field: string]: unknown }

interface PageHarness {
  readonly user: ReturnType<typeof userEvent.setup>
  readonly savedFileNames: string[]
  readonly deliver: (bridgeName: string, message: HostMessage) => Effect.Effect<void>
}

/** Render the page over a coordinator and senders that record what they see. */
const renderPage = (): PageHarness => {
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
  const collectorSender: CollectorSender = () => Effect.void
  const harRecorderSender: HarRecorderSender = (message) =>
    Effect.sync(() => {
      savedFileNames.push(message.fileName)
    })
  render(
    <HandlerCoordinatorContext.Provider value={coordinator}>
      <CollectorSenderProvider send={collectorSender}>
        <HarRecorderSenderProvider send={harRecorderSender}>
          <HarRecorderPage />
        </HarRecorderSenderProvider>
      </CollectorSenderProvider>
    </HandlerCoordinatorContext.Provider>
  )
  return {
    user: userEvent.setup(),
    savedFileNames,
    deliver: (bridgeName, message) => {
      const handler = registered.get(bridgeName)?.[message._tag]
      if (handler === undefined) throw new Error(`no ${bridgeName} handler for ${message._tag}`)
      return handler(message)
    },
  }
}

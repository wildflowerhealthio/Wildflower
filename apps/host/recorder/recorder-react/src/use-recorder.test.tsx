import { act, renderHook, type RenderHookResult } from '@testing-library/react'
import type { MessageHandler } from '@wildflowerhealthio/effect-messaging-core'
import type { HandlerCoordinator } from '@wildflowerhealthio/effect-messaging-react'
import { HandlerCoordinatorContext } from '@wildflowerhealthio/effect-messaging-react'
import { harFromJson } from '@wildflowerhealthio/http-archive'
import { numRunsFor } from '@wildflowerhealthio/kitchen-sink/test'
import { recordingFileName } from '@wildflowerhealthio/recorder-core-js'
import type { DateTime } from 'effect'
import { Effect, Encoding } from 'effect'
import * as fc from 'fast-check'
import type { JSX, ReactNode } from 'react'
import { describe, expect, it } from 'vite-plus/test'

import type { RecorderOutboundMessage, RecorderSender } from './recorder-sender-context.ts'
import { RecorderSenderProvider } from './recorder-sender-provider.tsx'
import { useRecorder, type Recorder, type RecorderState } from './use-recorder.ts'

/**
 * The hook against a fake coordinator and a fake sender. Everything the
 * recorder does is observable as an ordered {@link Harness.log} of bridge
 * traffic, which is what the ordering assertions below read — `SaveHar` has to
 * reach the host before `SniffingComplete` closes the window that produced it.
 */

const START_URL = 'https://example.com/patients'

/** A decoded host→web message, as the transport hands one to a handler. */
type HostMessage = { readonly _tag: string; readonly [field: string]: unknown }

describe('useRecorder', () => {
  it('should register its handlers on mount, before anything is opened', async () => {
    // Arrange
    const harness = makeHarness()

    // Act
    const { result } = renderRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })

    // Assert
    expect(harness.log).toEqual([
      { kind: 'register', bridge: 'Recorder' },
      { kind: 'send', tag: 'Open' },
    ])
  })

  it('should open exactly the URL it was started with', async () => {
    await fc.assert(
      fc.asyncProperty(fc.webUrl({ withQueryParameters: true }), async (url) => {
        // Arrange
        const harness = makeHarness()

        // Act
        const { result, unmount } = renderRecorder(harness)
        await act(async () => {
          result.current.start(url)
        })

        // Assert
        expect(harness.sent).toEqual([{ _tag: 'Open', source: { _tag: 'Uri', uri: url } }])
        unmount()
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('should count a response when it finishes, not while its chunks arrive', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })

    // Act
    await deliver(harness, responseStart('r1'))
    await deliver(harness, responseData('r1', '{"resourceType":"Patient"}'))

    // Assert
    expect(recordingCount(result.current.state)).toBe(0)

    // Act
    await deliver(harness, { _tag: 'ResponseFinished', id: 'r1' })

    // Assert
    expect(recordingCount(result.current.state)).toBe(1)
  })

  it('should drop sniffer events that arrive while nothing is recording', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderRecorder(harness)

    // Act — a window left over from before, still reporting.
    await deliver(harness, responseStart('r0'))
    await deliver(harness, { _tag: 'ResponseFinished', id: 'r0' })
    await act(async () => {
      result.current.start(START_URL)
    })

    // Assert
    expect(recordingCount(result.current.state)).toBe(0)
  })

  it('should save the archive before closing the sniffer window', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })
    await deliver(harness, responseStart('r1'))
    await deliver(harness, responseData('r1', '{"resourceType":"Patient"}'))
    await deliver(harness, { _tag: 'ResponseFinished', id: 'r1' })
    const startedAt = recordingStartedAt(result.current.state)

    // Act
    await act(async () => {
      result.current.stop()
    })

    // Assert
    expect(harness.log.slice(2)).toEqual([
      { kind: 'send', tag: 'SaveHar' },
      { kind: 'send', tag: 'SniffingComplete' },
    ])
    const saved = savedArchives(harness)[0]
    expect(saved?.fileName).toBe(recordingFileName(startedAt, START_URL))
    const har = await Effect.runPromise(harFromJson(saved?.text))
    expect(har.log.entries.map((entry) => entry.request.url)).toEqual([
      'https://example.com/Patient',
    ])
    expect(result.current.state).toEqual({ _tag: 'Saving', fileName: saved?.fileName })
  })

  it('should save when the user closes the recorder window', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })

    // Act
    await deliver(harness, { _tag: 'UserDismissed' })

    // Assert
    expect(savedArchives(harness)).toHaveLength(1)
    expect(harness.log.slice(2)).toEqual([
      { kind: 'send', tag: 'SaveHar' },
      { kind: 'send', tag: 'SniffingComplete' },
    ])
  })

  it('should never save twice when stopped again', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })
    // The window's X and the button both land on `stop()`; whichever runs
    // second must find nothing left to save.
    await deliver(harness, { _tag: 'UserDismissed' })
    const afterFirstStop = [...harness.log]

    // Act
    await act(async () => {
      result.current.stop()
    })

    // Assert
    expect(harness.log).toEqual(afterFirstStop)
    expect(savedArchives(harness)).toHaveLength(1)
  })

  it('should report the path the host wrote the pending recording to', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })
    await act(async () => {
      result.current.stop()
    })
    const { fileName } = savedArchives(harness)[0] ?? { fileName: '' }

    // Act
    await deliver(harness, {
      _tag: 'HarSaved',
      fileName,
      path: `/home/user/Downloads/Wildflower Recordings/${fileName}`,
    })

    // Assert
    expect(result.current.state).toEqual({
      _tag: 'Saved',
      path: `/home/user/Downloads/Wildflower Recordings/${fileName}`,
    })
  })

  it('should never act on an answer about another file name', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (suffix) => {
        // Arrange
        const harness = makeHarness()
        const { result, unmount } = renderRecorder(harness)
        await act(async () => {
          result.current.start(START_URL)
        })
        await act(async () => {
          result.current.stop()
        })
        const saving = result.current.state
        // Ends in `-other.har`, where the pending name ends in `-example.com.har`.
        const otherFileName = `${suffix}-other.har`

        // Act
        await deliver(harness, {
          _tag: 'HarSaved',
          fileName: otherFileName,
          path: '/home/user/Downloads/Wildflower Recordings/somebody-elses.har',
        })
        await deliver(harness, {
          _tag: 'HarSaveFailed',
          fileName: otherFileName,
          message: 'somebody elses failure',
        })

        // Assert
        expect(result.current.state).toEqual(saving)
        unmount()
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('should surface the reason the host refused to write', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })
    await act(async () => {
      result.current.stop()
    })
    const { fileName } = savedArchives(harness)[0] ?? { fileName: '' }

    // Act
    await deliver(harness, {
      _tag: 'HarSaveFailed',
      fileName,
      message: 'the recordings folder is not writable',
    })

    // Assert
    expect(result.current.state).toEqual({
      _tag: 'Failed',
      message: 'the recordings folder is not writable',
    })
  })

  it('should ignore a second start while already recording', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })
    const logAfterFirstStart = [...harness.log]

    // Act
    await act(async () => {
      result.current.start('https://other.example.com')
    })

    // Assert
    expect(harness.log).toEqual(logAfterFirstStart)
    expect(harness.sent).toHaveLength(1)
  })

  it('should preserve the SaveHar error when the sniffer teardown also fails', async () => {
    // Both SaveHar and SniffingComplete fail — the page must show the first,
    // more informative error rather than the teardown's.
    const harness = makeHarness({
      senderFailures: new Map([
        ['SaveHar', 'encode boom'],
        ['SniffingComplete', 'teardown boom'],
      ]),
    })
    const { result } = renderRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })

    await act(async () => {
      result.current.stop()
    })

    expect(result.current.state).toEqual({
      _tag: 'Failed',
      message: 'encode boom',
    })
  })

  it('should fail the recording when the window cannot be opened', async () => {
    // Arrange — a sender that rejects Open
    const harness = makeHarness()
    const failingSender: RecorderSender = (message) =>
      message._tag === 'Open' ? Effect.die(new Error('bridge down')) : harness.send(message)
    const { result } = renderHook(() => useRecorder(), {
      wrapper: ({ children }: { readonly children: ReactNode }): JSX.Element => (
        <HandlerCoordinatorContext.Provider value={harness.coordinator}>
          <RecorderSenderProvider send={failingSender}>{children}</RecorderSenderProvider>
        </HandlerCoordinatorContext.Provider>
      ),
    })

    // Act
    await act(async () => {
      result.current.start(START_URL)
    })

    // Assert
    expect(result.current.state._tag).toBe('Failed')
  })

  it('should allow a new recording after the previous one saved', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })
    await act(async () => {
      result.current.stop()
    })
    const { fileName } = savedArchives(harness)[0] ?? { fileName: '' }
    await deliver(harness, {
      _tag: 'HarSaved',
      fileName,
      path: `/home/user/Downloads/Wildflower Recordings/${fileName}`,
    })
    expect(result.current.state._tag).toBe('Saved')

    // Act
    await act(async () => {
      result.current.start('https://second.example.com')
    })

    // Assert
    expect(result.current.state._tag).toBe('Recording')
    expect(harness.sent.filter((message) => message._tag === 'Open')).toHaveLength(2)
  })

  it('should close the sniffer window when unmounted mid-recording', async () => {
    // Arrange
    const harness = makeHarness()
    const { result, unmount } = renderRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })

    // Act
    await act(async () => {
      unmount()
    })

    // Assert
    expect(harness.log.slice(2)).toEqual([
      { kind: 'unregister', bridge: 'Recorder' },
      { kind: 'send', tag: 'SniffingComplete' },
    ])
    expect(savedArchives(harness)).toHaveLength(0)
    expect(harness.registered.has('Recorder')).toBe(false)
  })

  it('should leave the window alone when unmounted while idle', async () => {
    // Arrange
    const harness = makeHarness()
    const { unmount } = renderRecorder(harness)

    // Act
    await act(async () => {
      unmount()
    })

    // Assert
    expect(harness.log).toEqual([
      { kind: 'register', bridge: 'Recorder' },
      { kind: 'unregister', bridge: 'Recorder' },
    ])
  })
})

// Helpers

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

/** One observed piece of bridge traffic, in the order the hook produced it. */
type LogEntry =
  | { readonly kind: 'register' | 'unregister'; readonly bridge: string }
  | { readonly kind: 'send'; readonly tag: string }

interface HarnessOptions {
  readonly senderFailures?: ReadonlyMap<string, string>
}

interface Harness {
  readonly log: LogEntry[]
  readonly registered: Map<string, MessageHandler.AnyHandlers>
  readonly coordinator: HandlerCoordinator
  readonly send: RecorderSender
  readonly sent: RecorderOutboundMessage[]
}

/**
 * A coordinator that really holds the handler record the hook registers (so
 * host→web messages can be delivered back into it) and a sender that records
 * what it was asked to send, all onto one ordered log.
 */
const makeHarness = (options?: HarnessOptions): Harness => {
  const log: LogEntry[] = []
  const registered = new Map<string, MessageHandler.AnyHandlers>()
  const sent: RecorderOutboundMessage[] = []
  const failures = options?.senderFailures ? new Map(options.senderFailures) : undefined

  const maybeFail = (tag: string): Effect.Effect<void> | undefined => {
    const message = failures?.get(tag)
    if (message === undefined) return undefined
    failures?.delete(tag)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return Effect.fail(new Error(message)) as unknown as Effect.Effect<void>
  }

  return {
    log,
    registered,
    sent,
    coordinator: {
      register: (bridge, handlers) =>
        Effect.sync(() => {
          registered.set(bridge.name, erase(handlers))
          log.push({ kind: 'register', bridge: bridge.name })
        }),
      unregister: (bridge, handlers) =>
        Effect.sync(() => {
          if (Object.is(registered.get(bridge.name), erase(handlers))) {
            registered.delete(bridge.name)
          }
          log.push({ kind: 'unregister', bridge: bridge.name })
        }),
    },
    send: (message) =>
      maybeFail(message._tag) ??
      Effect.sync(() => {
        sent.push(message)
        log.push({ kind: 'send', tag: message._tag })
      }),
  }
}

/** The `SaveHar`s the recorder sent, in order. */
const savedArchives = (
  harness: Harness
): readonly { readonly fileName: string; readonly text: string }[] =>
  harness.sent.flatMap((message) =>
    message._tag === 'SaveHar' ? [{ fileName: message.fileName, text: message.text }] : []
  )

const renderRecorder = (harness: Harness): RenderHookResult<Recorder, void> => {
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <HandlerCoordinatorContext.Provider value={harness.coordinator}>
      <RecorderSenderProvider send={harness.send}>{children}</RecorderSenderProvider>
    </HandlerCoordinatorContext.Provider>
  )
  return renderHook(() => useRecorder(), { wrapper })
}

/** Push a host→web message into the registered handler record. */
const deliver = async (harness: Harness, message: HostMessage): Promise<void> => {
  const handler = harness.registered.get('Recorder')?.[message._tag]
  if (handler === undefined) throw new Error(`no Recorder handler for ${message._tag}`)
  await act(async () => {
    await Effect.runPromise(handler(message))
  })
}

const responseStart = (id: string): HostMessage => ({
  _tag: 'ResponseStart',
  id,
  url: 'https://example.com/Patient',
  method: 'GET',
  status: 200,
  statusText: 'OK',
  headers: [['content-type', 'application/json']],
})

const responseData = (id: string, body: string): HostMessage => ({
  _tag: 'ResponseData',
  id,
  data: Encoding.encodeBase64(new TextEncoder().encode(body)),
})

/** The live response count, or `-1` if the recorder is not recording at all. */
const recordingCount = (state: RecorderState): number =>
  state._tag === 'Recording' ? state.count : -1

const recordingStartedAt = (state: RecorderState): DateTime.Utc => {
  if (state._tag !== 'Recording') throw new Error(`expected Recording, got ${state._tag}`)
  return state.startedAt
}

import { act, renderHook, type RenderHookResult } from '@testing-library/react'
import type { CollectorSender } from 'collector-react'
import { CollectorSenderProvider } from 'collector-react'
import type { DateTime } from 'effect'
import { Effect, Encoding } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import type { HandlerCoordinator } from 'effect-messaging-react'
import { HandlerCoordinatorContext } from 'effect-messaging-react'
import * as fc from 'fast-check'
import { recordingFileName } from 'har-recorder-core'
import { harFromJson } from 'http-archive'
import { numRunsFor } from 'kitchen-sink/test'
import type { JSX, ReactNode } from 'react'
import { describe, expect, it } from 'vite-plus/test'

import type { HarRecorderSender } from './har-recorder-sender-context.ts'
import { HarRecorderSenderProvider } from './har-recorder-sender-provider.tsx'
import { useHarRecorder, type HarRecorder, type HarRecorderState } from './use-har-recorder.ts'

/**
 * The hook against a fake coordinator and two fake senders. Everything the
 * recorder does is observable as an ordered {@link Harness.log} of bridge
 * traffic, which is what the ordering assertions below read — `SaveHar` has to
 * reach the host before `SniffingComplete` closes the window that produced it.
 */

const START_URL = 'https://example.com/patients'

/** A decoded host→web message, as the transport hands one to a handler. */
type HostMessage = { readonly _tag: string; readonly [field: string]: unknown }

describe('useHarRecorder', () => {
  it('should register the collector handlers before opening the URL', async () => {
    // Arrange
    const harness = makeHarness()

    // Act
    const { result } = renderHarRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })

    // Assert
    expect(harness.log).toEqual([
      { kind: 'register', bridge: 'HarRecorder' },
      { kind: 'register', bridge: 'Collector' },
      { kind: 'send', bridge: 'Collector', tag: 'Open' },
    ])
  })

  it('should open exactly the URL it was started with', async () => {
    await fc.assert(
      fc.asyncProperty(fc.webUrl({ withQueryParameters: true }), async (url) => {
        // Arrange
        const harness = makeHarness()

        // Act
        const { result, unmount } = renderHarRecorder(harness)
        await act(async () => {
          result.current.start(url)
        })

        // Assert
        expect(harness.sentCollectorMessages).toEqual([
          { _tag: 'Open', source: { _tag: 'Uri', uri: url } },
        ])
        unmount()
      }),
      { numRuns: numRunsFor({ base: 20 }) }
    )
  })

  it('should count a response when it finishes, not while its chunks arrive', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderHarRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })

    // Act
    await deliverCollector(harness, responseStart('r1'))
    await deliverCollector(harness, responseData('r1', '{"resourceType":"Patient"}'))

    // Assert
    expect(recordingCount(result.current.state)).toBe(0)

    // Act
    await deliverCollector(harness, { _tag: 'ResponseFinished', id: 'r1' })

    // Assert
    expect(recordingCount(result.current.state)).toBe(1)
  })

  it('should save the archive before closing the sniffer window, then unregister', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderHarRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })
    await deliverCollector(harness, responseStart('r1'))
    await deliverCollector(harness, responseData('r1', '{"resourceType":"Patient"}'))
    await deliverCollector(harness, { _tag: 'ResponseFinished', id: 'r1' })
    const startedAt = recordingStartedAt(result.current.state)

    // Act
    await act(async () => {
      result.current.stop()
    })

    // Assert
    expect(harness.log.slice(3)).toEqual([
      { kind: 'send', bridge: 'HarRecorder', tag: 'SaveHar' },
      { kind: 'send', bridge: 'Collector', tag: 'SniffingComplete' },
      { kind: 'unregister', bridge: 'Collector' },
    ])
    const saved = harness.sentHarRecorderMessages[0]
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
    const { result } = renderHarRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })

    // Act
    await deliverCollector(harness, { _tag: 'UserDismissed' })

    // Assert
    expect(harness.sentHarRecorderMessages).toHaveLength(1)
    expect(harness.log.slice(3)).toEqual([
      { kind: 'send', bridge: 'HarRecorder', tag: 'SaveHar' },
      { kind: 'send', bridge: 'Collector', tag: 'SniffingComplete' },
      { kind: 'unregister', bridge: 'Collector' },
    ])
  })

  it('should never save twice when stopped again', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderHarRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })
    // The window's X and the button both land on `stop()`; whichever runs
    // second must find nothing left to save.
    await deliverCollector(harness, { _tag: 'UserDismissed' })
    const afterFirstStop = [...harness.log]

    // Act
    await act(async () => {
      result.current.stop()
    })

    // Assert
    expect(harness.log).toEqual(afterFirstStop)
    expect(harness.sentHarRecorderMessages).toHaveLength(1)
  })

  it('should report the path the host wrote the pending recording to', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderHarRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })
    await act(async () => {
      result.current.stop()
    })
    const { fileName } = harness.sentHarRecorderMessages[0] ?? { fileName: '' }

    // Act
    await deliverHarRecorder(harness, {
      _tag: 'HarSaved',
      fileName,
      path: `/home/user/saved_data/${fileName}`,
    })

    // Assert
    expect(result.current.state).toEqual({
      _tag: 'Saved',
      path: `/home/user/saved_data/${fileName}`,
    })
  })

  it('should never act on an answer about another file name', async () => {
    await fc.assert(
      fc.asyncProperty(fc.string(), async (suffix) => {
        // Arrange
        const harness = makeHarness()
        const { result, unmount } = renderHarRecorder(harness)
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
        await deliverHarRecorder(harness, {
          _tag: 'HarSaved',
          fileName: otherFileName,
          path: '/home/user/saved_data/somebody-elses.har',
        })
        await deliverHarRecorder(harness, {
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
    const { result } = renderHarRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })
    await act(async () => {
      result.current.stop()
    })
    const { fileName } = harness.sentHarRecorderMessages[0] ?? { fileName: '' }

    // Act
    await deliverHarRecorder(harness, {
      _tag: 'HarSaveFailed',
      fileName,
      message: 'saved_data is not writable',
    })

    // Assert
    expect(result.current.state).toEqual({
      _tag: 'Failed',
      message: 'saved_data is not writable',
    })
  })

  it('should ignore a second start while already recording', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderHarRecorder(harness)
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
    expect(harness.sentCollectorMessages).toHaveLength(1)
  })

  it('should preserve the SaveHar error when the sniffer teardown also fails', async () => {
    // Both SaveHar and SniffingComplete fail — the page must show the first,
    // more informative error rather than the teardown's.
    const harness = makeHarness({
      senderFailures: new Map([
        ['HarRecorder:SaveHar', 'encode boom'],
        ['Collector:SniffingComplete', 'teardown boom'],
      ]),
    })
    const { result } = renderHarRecorder(harness)
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

  it('should transition to Failed and unregister handlers when start fails', async () => {
    // Arrange — a sender that rejects Open
    const harness = makeHarness()
    const failingSender: CollectorSender = (message) =>
      message._tag === 'Open'
        ? Effect.die(new Error('bridge down'))
        : harness.collectorSender(message)
    const { result } = renderHook(() => useHarRecorder(), {
      wrapper: ({ children }: { readonly children: ReactNode }): JSX.Element => (
        <HandlerCoordinatorContext.Provider value={harness.coordinator}>
          <CollectorSenderProvider send={failingSender}>
            <HarRecorderSenderProvider send={harness.harRecorderSender}>
              {children}
            </HarRecorderSenderProvider>
          </CollectorSenderProvider>
        </HandlerCoordinatorContext.Provider>
      ),
    })

    // Act
    await act(async () => {
      result.current.start(START_URL)
    })

    // Assert
    expect(result.current.state._tag).toBe('Failed')
    expect(harness.registered.has('Collector')).toBe(false)
  })

  it('should allow a new recording after the previous one saved', async () => {
    // Arrange
    const harness = makeHarness()
    const { result } = renderHarRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })
    await act(async () => {
      result.current.stop()
    })
    const { fileName } = harness.sentHarRecorderMessages[0] ?? { fileName: '' }
    await deliverHarRecorder(harness, {
      _tag: 'HarSaved',
      fileName,
      path: `/home/user/saved_data/${fileName}`,
    })
    expect(result.current.state._tag).toBe('Saved')

    // Act
    await act(async () => {
      result.current.start('https://second.example.com')
    })

    // Assert
    expect(result.current.state._tag).toBe('Recording')
    expect(harness.sentCollectorMessages).toHaveLength(3)
  })

  it('should close the sniffer window when unmounted mid-recording', async () => {
    // Arrange
    const harness = makeHarness()
    const { result, unmount } = renderHarRecorder(harness)
    await act(async () => {
      result.current.start(START_URL)
    })

    // Act
    await act(async () => {
      unmount()
    })

    // Assert
    expect(harness.log.slice(3)).toEqual([
      { kind: 'unregister', bridge: 'HarRecorder' },
      { kind: 'send', bridge: 'Collector', tag: 'SniffingComplete' },
      { kind: 'unregister', bridge: 'Collector' },
    ])
    expect(harness.sentHarRecorderMessages).toHaveLength(0)
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
 * `makeHandlerCoordinator`'s `recompose` performs.
 */
const erase = (handlers: object): MessageHandler.AnyHandlers =>
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  handlers as MessageHandler.AnyHandlers

/** One observed piece of bridge traffic, in the order the hook produced it. */
type LogEntry =
  | { readonly kind: 'register' | 'unregister'; readonly bridge: string }
  | { readonly kind: 'send'; readonly bridge: string; readonly tag: string }

interface HarnessOptions {
  readonly senderFailures?: ReadonlyMap<string, string>
}

interface Harness {
  readonly log: LogEntry[]
  readonly registered: Map<string, MessageHandler.AnyHandlers>
  readonly coordinator: HandlerCoordinator
  readonly collectorSender: CollectorSender
  readonly harRecorderSender: HarRecorderSender
  readonly sentCollectorMessages: unknown[]
  readonly sentHarRecorderMessages: { readonly fileName: string; readonly text: string }[]
}

/**
 * A coordinator that really holds the handler records the hook registers (so
 * host→web messages can be delivered back into it) and two senders that record
 * what they were asked to send, all onto one ordered log.
 */
const makeHarness = (options?: HarnessOptions): Harness => {
  const log: LogEntry[] = []
  const registered = new Map<string, MessageHandler.AnyHandlers>()
  const sentCollectorMessages: unknown[] = []
  const sentHarRecorderMessages: { readonly fileName: string; readonly text: string }[] = []
  const failures = options?.senderFailures ? new Map(options.senderFailures) : undefined

  const maybeFail = (key: string): Effect.Effect<void> | undefined => {
    const message = failures?.get(key)
    if (message === undefined) return undefined
    failures?.delete(key)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    return Effect.fail(new Error(message)) as unknown as Effect.Effect<void>
  }

  return {
    log,
    registered,
    sentCollectorMessages,
    sentHarRecorderMessages,
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
    collectorSender: (message) =>
      maybeFail(`Collector:${message._tag}`) ??
      Effect.sync(() => {
        sentCollectorMessages.push(message)
        log.push({ kind: 'send', bridge: 'Collector', tag: message._tag })
      }),
    harRecorderSender: (message) =>
      maybeFail(`HarRecorder:${message._tag}`) ??
      Effect.sync(() => {
        sentHarRecorderMessages.push({ fileName: message.fileName, text: message.text })
        log.push({ kind: 'send', bridge: 'HarRecorder', tag: message._tag })
      }),
  }
}

const renderHarRecorder = (harness: Harness): RenderHookResult<HarRecorder, void> => {
  const wrapper = ({ children }: { readonly children: ReactNode }): JSX.Element => (
    <HandlerCoordinatorContext.Provider value={harness.coordinator}>
      <CollectorSenderProvider send={harness.collectorSender}>
        <HarRecorderSenderProvider send={harness.harRecorderSender}>
          {children}
        </HarRecorderSenderProvider>
      </CollectorSenderProvider>
    </HandlerCoordinatorContext.Provider>
  )
  return renderHook(() => useHarRecorder(), { wrapper })
}

/** Push a host→web message into whichever handler record is registered. */
const deliver = async (
  harness: Harness,
  bridgeName: string,
  message: HostMessage
): Promise<void> => {
  const handler = harness.registered.get(bridgeName)?.[message._tag]
  if (handler === undefined) throw new Error(`no ${bridgeName} handler for ${message._tag}`)
  await act(async () => {
    await Effect.runPromise(handler(message))
  })
}

const deliverCollector = async (harness: Harness, message: HostMessage): Promise<void> =>
  deliver(harness, 'Collector', message)

const deliverHarRecorder = async (harness: Harness, message: HostMessage): Promise<void> =>
  deliver(harness, 'HarRecorder', message)

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
const recordingCount = (state: HarRecorderState): number =>
  state._tag === 'Recording' ? state.count : -1

const recordingStartedAt = (state: HarRecorderState): DateTime.Utc => {
  if (state._tag !== 'Recording') throw new Error(`expected Recording, got ${state._tag}`)
  return state.startedAt
}

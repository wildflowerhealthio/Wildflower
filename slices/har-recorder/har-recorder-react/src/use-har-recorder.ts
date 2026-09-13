import type { CollectorBridge } from 'collector-fundamentals/bridge'
import { useCollectorRegister, useCollectorSender } from 'collector-react'
import { DateTime, Effect } from 'effect'
import type { MessageHandler } from 'effect-messaging-core'
import { type HarRecorderBridge, Recording, recordingFileName, toHar } from 'har-recorder-core'
import { harToJson } from 'http-archive'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useHarRecorderRegister } from './use-har-recorder-register.ts'
import { useHarRecorderSender } from './use-har-recorder-sender.ts'

/**
 * The HAR Recorder's state machine: open a URL in the sniffer webview, keep
 * every response it reports, and hand the finished archive to the host.
 *
 * @remarks
 * The recorder straddles two bridges: the sniffer events ride `CollectorBridge`
 * (so this hook borrows `collector-react`'s hooks rather than re-declaring
 * those tags), while `SaveHar` and its answers ride `HarRecorderBridge`. See
 * the [package AGENTS.md](../AGENTS.md).
 *
 * @packageDocumentation
 */

/** Every `CollectorBridge` Host→Web tag, handled. */
type CollectorHandlers = MessageHandler.HandlersFor<CollectorBridge['HostToWeb']>

/** The host's two answers to a `SaveHar`. */
type HarRecorderHandlers = MessageHandler.HandlersFor<HarRecorderBridge['HostToWeb']>

/**
 * Where a recording is, as the page renders it.
 *
 * @remarks
 * `Saved` and `Failed` are terminal for *that* recording, not for the hook: a
 * new {@link HarRecorder.start} from either lands back in `Recording`.
 */
type HarRecorderState =
  | { readonly _tag: 'Idle' }
  /** Capturing. `count` is how many responses have settled so far. */
  | {
      readonly _tag: 'Recording'
      readonly count: number
      readonly startUrl: string
      readonly startedAt: DateTime.Utc
    }
  /** The archive is with the host; awaiting `HarSaved` / `HarSaveFailed`. */
  | { readonly _tag: 'Saving'; readonly fileName: string }
  /** The host wrote the file at `path`. */
  | { readonly _tag: 'Saved'; readonly path: string }
  /** Nothing was written, and `message` says why. */
  | { readonly _tag: 'Failed'; readonly message: string }

/** The imperative surface the recorder page drives. */
interface HarRecorder {
  /** The current state, re-rendered on every settled response while recording. */
  readonly state: HarRecorderState
  /** Open `url` in the sniffer webview and start keeping its responses. */
  readonly start: (url: string) => void
  /** Stop, emit the archive, and ask the host to write it. Idempotent. */
  readonly stop: () => void
}

/** {@link HarRecorderState} without the live `count`, which is held apart. */
type Phase =
  | { readonly _tag: 'Idle' }
  | { readonly _tag: 'Recording'; readonly startUrl: string; readonly startedAt: DateTime.Utc }
  | { readonly _tag: 'Saving'; readonly fileName: string }
  | { readonly _tag: 'Saved'; readonly path: string }
  | { readonly _tag: 'Failed'; readonly message: string }

/** The in-flight recording plus what emitting its archive needs. */
interface ActiveRecording {
  readonly recording: Recording
  readonly startUrl: string
  readonly startedAt: DateTime.Utc
}

/** An `Error`'s message, or a best-effort string for anything else thrown. */
const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

/**
 * Drives one HAR recording at a time.
 *
 * @returns The {@link HarRecorder}: the current {@link HarRecorderState} plus
 *   `start(url)` and `stop()`
 *
 * @remarks
 * **Ordering.** `start` registers the `CollectorBridge` handlers *before*
 * sending `Open`, and `stop` sends `SaveHar` before `SniffingComplete` (which
 * closes the sniffer webview) and only then unregisters. The
 * [Design Explanation](../../docs/Design%20Explanation.md) says why both orders
 * are the way round they are.
 *
 * `stop` is idempotent and a dismissed sniffer window runs it too, so the
 * recording — which exists only in this page — is never lost silently. A
 * `HarSaved` / `HarSaveFailed` for a file name other than the pending one is
 * ignored, so a late answer cannot overwrite the current result. `count` is
 * bumped only on `ResponseFinished`, and the {@link Recording} is a ref rather
 * than state: both keep a body's hundreds of chunks from re-rendering the page.
 */
const useHarRecorder = (): HarRecorder => {
  const sendCollectorMessage = useCollectorSender()
  const collectorRegister = useCollectorRegister()
  const sendHarRecorderMessage = useHarRecorderSender()
  const harRecorderRegister = useHarRecorderRegister()

  const [phase, setPhase] = useState<Phase>({ _tag: 'Idle' })
  const [count, setCount] = useState(0)

  /** The in-flight recording; `null` whenever there is nothing to stop. */
  const activeRef = useRef<ActiveRecording | null>(null)
  /** The file name the host's next answer must carry to be ours. */
  const pendingFileNameRef = useRef<string | null>(null)
  /** Lets the `UserDismissed` handler, built once below, call the latest `stop`. */
  const stopRef = useRef<() => void>(() => {})

  // One handler record per hook instance, built once: `unregister` is
  // set-if-equal (see `makeHandlerCoordinator`), so a freshly-built object each
  // render would leave the coordinator unable to evict the one it holds.
  const [handlers] = useState<{
    readonly collector: CollectorHandlers
    readonly harRecorder: HarRecorderHandlers
  }>(() => {
    /** Run `act` against the live recording, or drop the event if there is none. */
    const withActive = (act: (active: ActiveRecording) => void): Effect.Effect<void> =>
      Effect.sync(() => {
        const active = activeRef.current
        if (active !== null) act(active)
      })
    /** Is this answer about the recording the page is waiting on? */
    const isPending = (fileName: string): boolean => pendingFileNameRef.current === fileName
    return {
      collector: {
        ResponseStart: (message) =>
          withActive(({ recording }) => {
            recording.onResponseStart(message, DateTime.unsafeNow())
          }),
        ResponseData: (message) =>
          withActive(({ recording }) => {
            recording.onResponseData(message)
          }),
        ResponseFinished: (message) =>
          withActive(({ recording }) => {
            recording.onResponseFinished(message)
            setCount(recording.count)
          }),
        RequestError: (message) =>
          withActive(({ recording }) => {
            recording.onRequestError(message)
          }),
        Cancelled: (message) =>
          withActive(({ recording }) => {
            recording.onCancelled(message)
          }),
        UserDismissed: () =>
          Effect.sync(() => {
            stopRef.current()
          }),
        // Not part of a recording, but a handler record must cover every
        // inbound tag of its bridge, so these are explicit no-ops.
        PageLoaded: () => Effect.void,
        PageRequested: () => Effect.void,
        SnifferDisposed: () => Effect.void,
      },
      harRecorder: {
        HarSaved: ({ fileName, path }) =>
          Effect.sync(() => {
            if (!isPending(fileName)) return
            pendingFileNameRef.current = null
            setPhase({ _tag: 'Saved', path })
          }),
        HarSaveFailed: ({ fileName, message }) =>
          Effect.sync(() => {
            if (!isPending(fileName)) return
            pendingFileNameRef.current = null
            setPhase({ _tag: 'Failed', message })
          }),
      },
    }
  })

  const start = useCallback(
    (url: string): void => {
      if (activeRef.current !== null) return
      const startedAt = DateTime.unsafeNow()
      activeRef.current = { recording: Recording.empty(), startUrl: url, startedAt }
      pendingFileNameRef.current = null
      setCount(0)
      setPhase({ _tag: 'Recording', startUrl: url, startedAt })
      Effect.runPromise(
        collectorRegister
          .register(handlers.collector)
          .pipe(
            Effect.andThen(
              sendCollectorMessage({ _tag: 'Open', source: { _tag: 'Uri', uri: url } })
            )
          )
      ).catch((error: unknown) => {
        // Nothing is capturing and no webview opened — say so, rather than
        // leaving a "Recording" that counts to zero forever.
        activeRef.current = null
        setPhase({ _tag: 'Failed', message: messageOf(error) })
      })
    },
    [collectorRegister, handlers, sendCollectorMessage]
  )

  const stop = useCallback((): void => {
    const active = activeRef.current
    if (active === null) return
    // Cleared before any Effect runs, so the button and a racing
    // `UserDismissed` cannot both reach `SaveHar`.
    activeRef.current = null

    const { recording, startUrl, startedAt } = active
    const fileName = recordingFileName(startedAt, startUrl)
    pendingFileNameRef.current = fileName
    setPhase({ _tag: 'Saving', fileName })

    const har = toHar(recording, { startUrl, startedAt, stoppedAt: DateTime.unsafeNow() })
    Effect.runPromise(
      harToJson(har).pipe(
        Effect.flatMap((text) => sendHarRecorderMessage({ _tag: 'SaveHar', fileName, text })),
        // Caught rather than thrown so the `SniffingComplete` below still
        // runs; otherwise a failed encode leaves an unclosable sniffer window.
        Effect.catchAll((error) =>
          Effect.sync(() => {
            pendingFileNameRef.current = null
            setPhase({ _tag: 'Failed', message: messageOf(error) })
          })
        ),
        Effect.andThen(sendCollectorMessage({ _tag: 'SniffingComplete' })),
        Effect.andThen(collectorRegister.unregister(handlers.collector))
      )
    ).catch((error: unknown) => {
      setPhase({ _tag: 'Failed', message: messageOf(error) })
    })
  }, [collectorRegister, handlers, sendCollectorMessage, sendHarRecorderMessage])

  // Mirror-written after every render (no deps) so the unmount teardown below
  // reaches the current sender and coordinator without depending on either —
  // a dependency change would tear down mid-recording and close the sniffer
  // window out from under the user. `stop` is mirrored for the same reason.
  const sendCollectorMessageRef = useRef(sendCollectorMessage)
  const collectorRegisterRef = useRef(collectorRegister)
  useEffect(() => {
    stopRef.current = stop
    sendCollectorMessageRef.current = sendCollectorMessage
    collectorRegisterRef.current = collectorRegister
  })

  // Listened for over the whole mounted lifetime, not just while recording:
  // `HarSaved` arrives after `stop()` tore the collector handlers down.
  useEffect(() => {
    Effect.runFork(
      harRecorderRegister
        .register(handlers.harRecorder)
        .pipe(
          Effect.catchAll((error) =>
            Effect.logError('useHarRecorder: HarRecorder handler registration failed', error)
          )
        )
    )
    return () => {
      Effect.runFork(
        harRecorderRegister
          .unregister(handlers.harRecorder)
          .pipe(
            Effect.catchAll((error) =>
              Effect.logError('useHarRecorder: HarRecorder handler unregistration failed', error)
            )
          )
      )
    }
  }, [handlers, harRecorderRegister])

  // Unmounting mid-recording still closes the sniffer webview: only
  // `SniffingComplete` takes it down, so navigating away without one orphans
  // the window. The archive is lost with the page either way.
  useEffect(() => {
    const teardown = (): void => {
      const wasRecording = activeRef.current !== null
      activeRef.current = null
      if (!wasRecording) return
      Effect.runFork(
        sendCollectorMessageRef
          .current({ _tag: 'SniffingComplete' })
          .pipe(Effect.andThen(collectorRegisterRef.current.unregister(handlers.collector)))
          .pipe(
            Effect.catchAll((error) =>
              Effect.logError('useHarRecorder: unmount teardown failed', error)
            )
          )
      )
    }
    return teardown
  }, [handlers])

  const state = useMemo<HarRecorderState>(
    () => (phase._tag === 'Recording' ? { ...phase, count } : phase),
    [count, phase]
  )

  return { state, start, stop }
}

export { useHarRecorder }
export type { HarRecorder, HarRecorderState }

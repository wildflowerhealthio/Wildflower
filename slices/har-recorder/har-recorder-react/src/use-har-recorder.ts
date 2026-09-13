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
 * The recorder straddles two bridges. Its *intake* is the collector's data
 * plane — the sniffer events ride `CollectorBridge`, so this hook borrows
 * `collector-react`'s register and sender hooks rather than re-declaring those
 * tags. Its *output* is `HarRecorderBridge`: `SaveHar` out, `HarSaved` /
 * `HarSaveFailed` back.
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
 * new {@link HarRecorder.start} from either lands back in `Recording`, which is
 * what lets a page record twice without remounting.
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
 * **Ordering.** `start(url)` registers the `CollectorBridge` handler record and
 * *then* sends one `Open`, so the sniffer's first events cannot land on a
 * dropped receiver. `stop()` sends `SaveHar`, then `SniffingComplete` (which is
 * what closes the sniffer webview), then unregisters: the host must hold the
 * bytes before the webview that produced them goes away.
 *
 * **The window's X saves too.** The host reports a dismissed sniffer window as
 * `UserDismissed`, which runs the same `stop()` — the recording exists only in
 * this page, so discarding it on a close would lose it silently.
 *
 * **Idempotence.** A `stop()` past the first is a no-op: the active recording
 * is cleared synchronously, before any Effect runs, so a `UserDismissed`
 * racing the button cannot send `SaveHar` twice.
 *
 * **Re-renders.** `count` is bumped only on `ResponseFinished` — one render per
 * settled response and none for the chunks in between, which for a body
 * arriving in hundreds of `ResponseData` messages is the difference between a
 * counter and a render storm. The {@link Recording} itself is a ref, never
 * state: it is megabytes of body bytes, and none of it is rendered.
 *
 * **Answers are matched by file name.** A `HarSaved` / `HarSaveFailed` whose
 * `fileName` is not the pending one is ignored, so a late answer for an earlier
 * recording cannot overwrite the current one's result.
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
  /**
   * Lets the `UserDismissed` handler — built once, below — call the latest
   * `stop`, which is defined after it.
   */
  const stopRef = useRef<() => void>(() => {})

  // One handler record per hook instance, for both bridges, built once by a
  // lazy `useState` initializer. `unregister` is set-if-equal (see
  // `makeHandlerCoordinator`), so handing it a freshly-built object each render
  // would leave the coordinator unable to evict the one it holds.
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
        // Not part of a recording: the two page notifications that drive the
        // collector's step machine, and the teardown signal that follows our
        // own `SniffingComplete`. A handler record must cover every inbound tag
        // of its bridge, so these are explicit no-ops rather than absent.
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
        // A failure to encode or to send is surfaced here rather than thrown,
        // because the webview still has to be closed below: otherwise the user
        // is left with a live sniffer window and no way to end the run.
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
  // reaches the current sender and coordinator without listing either as a
  // dependency — a dependency change would run the teardown mid-recording and
  // close the sniffer window out from under the user.
  const sendCollectorMessageRef = useRef(sendCollectorMessage)
  const collectorRegisterRef = useRef(collectorRegister)
  useEffect(() => {
    // Same reason for `stop`: the `UserDismissed` handler is built once and
    // reads the latest `stop` through this ref rather than being rebuilt.
    stopRef.current = stop
    sendCollectorMessageRef.current = sendCollectorMessage
    collectorRegisterRef.current = collectorRegister
  })

  // The recorder's own answers are listened for over the whole mounted
  // lifetime, not just while recording: `HarSaved` arrives after `stop()` has
  // already torn the collector handlers down.
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

  // Unmounting mid-recording still has to close the sniffer webview: the host
  // opened it on our `Open` and only `SniffingComplete` takes it down, so
  // navigating away without one leaves an orphaned window. The archive is lost
  // with the page either way — there is no one left to show a path to.
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

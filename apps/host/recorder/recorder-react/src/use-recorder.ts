import type { MessageHandler } from '@wildflowerhealthio/effect-messaging-core'
import { harToJson } from '@wildflowerhealthio/http-archive'
import {
  type RecorderBridge,
  Recording,
  recordingFileName,
  toHar,
} from '@wildflowerhealthio/recorder-core-js'
import { DateTime, Effect } from 'effect'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useRecorderRegister } from './use-recorder-register.ts'
import { useRecorderSender } from './use-recorder-sender.ts'

/**
 * The Recorder's state machine: open a URL in the sniffer webview, keep every
 * response it reports, and hand the finished archive to the host.
 *
 * @remarks
 * Everything rides one bridge, `RecorderBridge`: the sniffer's events and the
 * window's lifecycle in, `Open` / `SniffingComplete` out, and `SaveHar` with
 * its two answers. See the [package AGENTS.md](../AGENTS.md).
 *
 * @packageDocumentation
 */

/** Every `RecorderBridge` Host→Web tag, handled. */
type RecorderHandlers = MessageHandler.HandlersFor<RecorderBridge['HostToWeb']>

/**
 * Where a recording is, as the page renders it.
 *
 * @remarks
 * `Saved` and `Failed` are terminal for *that* recording, not for the hook: a
 * new {@link Recorder.start} from either lands back in `Recording`.
 */
type RecorderState =
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
interface Recorder {
  /** The current state, re-rendered on every settled response while recording. */
  readonly state: RecorderState
  /** Open `url` in the sniffer webview and start keeping its responses. */
  readonly start: (url: string) => void
  /** Stop, emit the archive, and ask the host to write it. Idempotent. */
  readonly stop: () => void
}

/** {@link RecorderState} without the live `count`, which is held apart. */
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
 * Drives one recording at a time.
 *
 * @returns The {@link Recorder}: the current {@link RecorderState} plus
 *   `start(url)` and `stop()`
 *
 * @remarks
 * **Handlers live as long as the hook.** The `RecorderBridge` record is
 * registered on mount and unregistered on unmount, so it is in place before
 * any `Open` and still there when `HarSaved` arrives after the window has
 * closed; a sniffer event with no recording running is dropped.
 *
 * **Ordering.** `stop` sends `SaveHar` before `SniffingComplete` (which closes
 * the sniffer webview). The
 * [Design Explanation](../../docs/Design%20Explanation.md) says why.
 *
 * `stop` is idempotent and a dismissed sniffer window runs it too, so the
 * recording — which exists only in this hook — is never lost silently. A
 * `HarSaved` / `HarSaveFailed` for a file name other than the pending one is
 * ignored, so a late answer cannot overwrite the current result. `count` is
 * bumped only on `ResponseFinished`, and the {@link Recording} is a ref rather
 * than state: both keep a body's hundreds of chunks from re-rendering the page.
 */
const useRecorder = (): Recorder => {
  const send = useRecorderSender()
  const register = useRecorderRegister()

  const [phase, setPhase] = useState<Phase>({ _tag: 'Idle' })
  const [count, setCount] = useState(0)

  /** The in-flight recording; `null` whenever there is nothing to stop. */
  const activeRef = useRef<ActiveRecording | null>(null)
  /** The file name the host's next answer must carry to be ours. */
  const pendingFileNameRef = useRef<string | null>(null)
  /** Lets the `UserDismissed` handler, built once below, call the latest `stop`. */
  const stopRef = useRef<() => void>(() => {})

  // One handler record per hook instance, built once: `unregister` is
  // set-if-equal (see `HandlerCoordinator.unregister`), so a freshly-built object each
  // render would leave the coordinator unable to evict the one it holds.
  const [handlers] = useState<RecorderHandlers>(() => {
    /** Run `act` against the live recording, or drop the event if there is none. */
    const withActive = (act: (active: ActiveRecording) => void): Effect.Effect<void> =>
      Effect.sync(() => {
        const active = activeRef.current
        if (active !== null) act(active)
      })
    /** Is this answer about the recording the page is waiting on? */
    const isPending = (fileName: string): boolean => pendingFileNameRef.current === fileName
    return {
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
    }
  })

  const start = useCallback(
    (url: string): void => {
      if (activeRef.current !== null) return
      if (phase._tag === 'Saving') return
      const startedAt = DateTime.unsafeNow()
      activeRef.current = { recording: Recording.empty(), startUrl: url, startedAt }
      pendingFileNameRef.current = null
      setCount(0)
      setPhase({ _tag: 'Recording', startUrl: url, startedAt })
      Effect.runPromise(send({ _tag: 'Open', source: { _tag: 'Uri', uri: url } })).catch(
        (error: unknown) => {
          activeRef.current = null
          setPhase({ _tag: 'Failed', message: messageOf(error) })
        }
      )
    },
    [phase, send]
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
    Effect.runFork(
      harToJson(har).pipe(
        Effect.flatMap((text) => send({ _tag: 'SaveHar', fileName, text })),
        // Caught rather than thrown so the `SniffingComplete` below still
        // runs; otherwise a failed encode leaves an unclosable sniffer window.
        Effect.catchAll((error) =>
          Effect.sync(() => {
            pendingFileNameRef.current = null
            setPhase({ _tag: 'Failed', message: messageOf(error) })
          })
        ),
        Effect.andThen(
          send({ _tag: 'SniffingComplete' }).pipe(
            Effect.catchAll((error) =>
              Effect.logError('useRecorder: closing the sniffer window failed', error)
            )
          )
        )
      )
    )
  }, [send])

  // Mirror-written after every render (no deps) so the unmount teardown below
  // reaches the current sender without depending on it — a dependency change
  // would tear down mid-recording and close the sniffer window out from under
  // the user. `stop` is mirrored for the same reason.
  const sendRef = useRef(send)
  useEffect(() => {
    stopRef.current = stop
    sendRef.current = send
  })

  // Registered for the whole mounted lifetime, not just while recording:
  // `HarSaved` arrives after `stop()` closed the window. Unmounting
  // mid-recording still closes the sniffer webview: only `SniffingComplete`
  // takes it down, so leaving without one orphans the window. The archive is
  // lost with the hook either way.
  useEffect(() => {
    Effect.runFork(
      register
        .register(handlers)
        .pipe(
          Effect.catchAll((error) =>
            Effect.logError('useRecorder: Recorder handler registration failed', error)
          )
        )
    )
    return () => {
      const wasRecording = activeRef.current !== null
      activeRef.current = null
      Effect.runFork(
        register.unregister(handlers).pipe(
          Effect.andThen(
            wasRecording ? sendRef.current({ _tag: 'SniffingComplete' }) : Effect.void
          ),
          Effect.catchAll((error) => Effect.logError('useRecorder: unmount teardown failed', error))
        )
      )
    }
  }, [handlers, register])

  const state = useMemo<RecorderState>(
    () => (phase._tag === 'Recording' ? { ...phase, count } : phase),
    [count, phase]
  )

  return { state, start, stop }
}

export { useRecorder }
export type { Recorder, RecorderState }

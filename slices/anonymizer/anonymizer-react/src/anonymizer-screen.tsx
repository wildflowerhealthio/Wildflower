import { Effect, Either } from 'effect'
import { useCallback, useEffect, useMemo, useState, type JSX, type ReactNode } from 'react'

import { acceptFor, identify, type PickedFile } from 'anonymizer-fundamentals'

import { LocalFilePicker } from './local-file-picker.tsx'
import { formatRegistry, type BoundFormat } from './registry.tsx'
import styles from './anonymizer-screen.module.css'

/**
 * The anonymize surface a host app mounts: pick one file, let the registry
 * identify its format, review that format's redaction, download the anonymized
 * artifact. Client-side end to end — identify, decode, review, blob download —
 * and **issues no writes**.
 *
 * @remarks
 * The screen owns the pick state and the decode lifecycle, nothing else. A
 * pick is identified against the closed registry (`identify` — first claiming
 * format wins), decoded **once per picked identity** through the winning
 * format's `decodeToPanel`, and the resulting element — which closes over the
 * decoded value — is what re-renders, so the format panel's rebuild identity
 * stays stable. `Pick another` discards the current pick.
 *
 * The optional {@link AnonymizerScreenProps.serverSource} render-slot is the
 * one seam a host uses to offer picks the shell cannot: a list of server-held
 * archives, say. The slot only hands back a {@link PickedFile}; whatever
 * fetching or auth that took is the host's business, and this package still
 * never speaks to a server.
 */
interface AnonymizerScreenProps {
  /**
   * Extra pick sources a host renders below the local picker, given the same
   * pick callback the picker uses.
   */
  readonly serverSource?: (onPick: (file: PickedFile) => void) => ReactNode
}

/** The alert shown when no registered format claims the picked file. */
const UNIDENTIFIED_ERROR = 'That file was not recognized as an anonymizable format.'

/** What decoding one pick produced. */
type DecodeOutcome =
  | { readonly _tag: 'decoded'; readonly panel: JSX.Element }
  | { readonly _tag: 'failed'; readonly message: string }

/** The anonymize flow. */
const AnonymizerScreen = ({ serverSource }: AnonymizerScreenProps = {}): JSX.Element => {
  const [picked, setPicked] = useState<PickedFile | null>(null)
  // The finished decode, keyed by the pick it belongs to. Keying (rather than
  // clearing state synchronously in the effect) is what makes "still decoding"
  // a derived fact: an outcome for a different pick simply does not count.
  const [outcome, setOutcome] = useState<{
    readonly of: PickedFile
    readonly result: DecodeOutcome
  } | null>(null)

  // Identified once per picked identity; `null` file → no identification,
  // `undefined` → picked but unclaimed.
  const bound: BoundFormat | undefined | null = useMemo(
    () => (picked === null ? null : identify(formatRegistry, picked)),
    [picked]
  )

  // Decode once per picked identity, asynchronously (a format's decode may be
  // async — PDF extraction). The cancelled flag keeps a stale decode from
  // clobbering a newer pick's state.
  useEffect(() => {
    if (picked === null || bound === null || bound === undefined) return undefined
    let cancelled = false
    void Effect.runPromise(Effect.either(bound.decodeToPanel(picked))).then((result) => {
      if (cancelled) return
      setOutcome({
        of: picked,
        result: Either.match(result, {
          onLeft: (failure): DecodeOutcome => ({ _tag: 'failed', message: failure.message }),
          onRight: (panel): DecodeOutcome => ({ _tag: 'decoded', panel }),
        }),
      })
    })
    return () => {
      cancelled = true
    }
  }, [picked, bound])

  const decode = outcome !== null && outcome.of === picked ? outcome.result : null

  const startOver = useCallback((): void => setPicked(null), [])
  const onPick = useCallback((file: PickedFile): void => setPicked(file), [])

  if (picked === null) {
    return (
      <div className={styles.screen}>
        <section aria-label="File source" className={styles.sources}>
          <LocalFilePicker accept={acceptFor(formatRegistry)} onPick={onPick} />
          {serverSource?.(onPick)}
        </section>
      </div>
    )
  }

  if (bound === undefined) {
    return (
      <div className={styles.screen}>
        <p role="alert" className={styles.error}>
          {UNIDENTIFIED_ERROR}
        </p>
        <button type="button" className={styles.back} onClick={startOver}>
          Pick another
        </button>
      </div>
    )
  }

  if (decode === null) {
    return (
      <div className={styles.screen}>
        <p role="status">Reading {picked.fileName}…</p>
      </div>
    )
  }

  if (decode._tag === 'failed') {
    return (
      <div className={styles.screen}>
        <p role="alert" className={styles.error}>
          {decode.message}
        </p>
        <button type="button" className={styles.back} onClick={startOver}>
          Pick another
        </button>
      </div>
    )
  }

  return (
    <div className={styles.screen}>
      {decode.panel}
      <button type="button" className={styles.back} onClick={startOver}>
        Pick another
      </button>
    </div>
  )
}

export { AnonymizerScreen, type AnonymizerScreenProps, UNIDENTIFIED_ERROR }

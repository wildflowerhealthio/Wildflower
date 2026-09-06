import { Schema } from 'effect'
import { AnonymizePanel } from 'har-anonymizer-react'
import { HttpArchive } from 'har-importer-core/har'
import { type JSX, useCallback, useMemo, useState } from 'react'

import { type PickedHar } from './sources/picked-har.ts'
import { SourcePicker } from './sources/source-picker.tsx'
import styles from './anonymizer-screen.module.css'

/**
 * The anonymize surface a host app mounts: pick one HAR, review the redaction,
 * download the anonymized archive. Takes no props — {@link SourcePicker} reads its
 * authed runner out of router context, and the panel below it downloads a blob
 * from the app's own origin.
 *
 * @remarks
 * The screen owns the pick state and nothing else: the picker feeds one file at
 * a time ({@link SourcePicker} in `'single'` mode), the file's text is decoded
 * through the shared {@link HttpArchive.LogFromHarJson} parser once per picked
 * identity (the decoded log is what triggers a rebuild inside
 * {@link AnonymizePanel}, so it must be a stable reference — the `useMemo` keyed
 * on the pick is the memoisation the panel's traps call out), and `Pick another`
 * discards the current pick.
 *
 * **The screen issues no writes.** The picker's server list reads through
 * `fetchHarArchive` (a `DocumentReference` GET), and every downstream step is
 * local: parse, redact preview, blob download. Nothing here touches a FHIR
 * write client. The scope hardened elsewhere in this slice — `.rs`/`.u` on the
 * types the import flow writes — is not needed by this screen and is not asked
 * for by it.
 *
 * @packageDocumentation
 */

/** The alert shown when a picked archive is not decodable HAR (a server-held file that has drifted). */
const HAR_PARSE_ERROR = 'That archive could not be read as a HAR.'

/** Single decoder, reused per pick. */
const decodeLog = Schema.decodeEither(HttpArchive.LogFromHarJson)

/** The anonymize flow. */
const AnonymizerScreen = (): JSX.Element => {
  const [picked, setPicked] = useState<PickedHar | null>(null)

  // Decode once per picked identity. The decoded `HttpArchive.Log` is the
  // memoised reference the panel's rebuild effect depends on; recomputing per
  // render would re-parse and re-anonymize on every keystroke.
  const decoded = useMemo(() => (picked === null ? null : decodeLog(picked.text)), [picked])

  const startOver = useCallback((): void => setPicked(null), [])

  const onPick = useCallback((picks: readonly PickedHar[]): void => {
    const first = picks[0]
    if (first !== undefined) setPicked(first)
  }, [])

  if (picked === null || decoded === null) {
    return (
      <div className={styles['screen']}>
        <SourcePicker mode="single" onPick={onPick} />
      </div>
    )
  }

  if (decoded._tag === 'Left') {
    return (
      <div className={styles['screen']}>
        <p role="alert" className={styles['error']}>
          {HAR_PARSE_ERROR}
        </p>
        <button type="button" className={styles['back']} onClick={startOver}>
          Pick another
        </button>
      </div>
    )
  }

  return (
    <div className={styles['screen']}>
      <AnonymizePanel log={decoded.right} fileName={picked.fileName} />
      <button type="button" className={styles['back']} onClick={startOver}>
        Pick another
      </button>
    </div>
  )
}

export { AnonymizerScreen, HAR_PARSE_ERROR }

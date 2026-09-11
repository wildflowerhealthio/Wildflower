import { Array as Arr, Effect } from 'effect'
import { useRef, useState, type ChangeEvent, type DragEvent, type JSX } from 'react'

import { acceptLocalHar, type ReadableFile } from './local-har.ts'
import type { PickedHar } from './picked-har.ts'
import { ServerHarArchiveList } from './server-har-archive-list.tsx'
import styles from './source-picker.module.css'

/**
 * The one control that turns any of three sources into a {@link PickedHar}: a
 * file dropped on the zone, a file chosen through the OS picker, or a HAR archive
 * already uploaded to the device's own FHIR server.
 *
 * @remarks
 * Drop is an enhancement, not the only path: the zone is itself a button that
 * opens the file picker, so the whole surface is reachable by keyboard and named
 * for a screen reader. A local file — dropped or chosen — is validated through
 * `web-trace-core`'s HAR parser at the picker, so a file that is not a HAR is
 * rejected *here*, next to the control the user just used, rather than surfacing
 * as a failure downstream. The server picks come from
 * {@link ServerHarArchiveList}, which fetches the chosen archive and decodes it
 * through the archive codec; the resulting pick carries the archive's own
 * reference so a later step links provenance without re-uploading the bytes.
 *
 * Presentation and interaction only. Nothing here parses HAR or encodes an
 * archive — both live in `web-trace-core`, below this package.
 *
 * @packageDocumentation
 */

/**
 * How many HARs a caller consumes at once.
 *
 * @remarks
 * The picker offers the same three sources either way — dropped, chosen through
 * the OS picker, uploaded to the FHIR server — and clamps a local batch to the
 * mode. `'batch'` (the default) is the importer flow: several HARs previewed and
 * confirmed together. `'single'` is a one-at-a-time flow: a batch that fell out
 * of a multi-file drop is trimmed to the first-accepted file, and the OS dialog
 * only offers one file to begin with.
 */
type SourcePickerMode = 'batch' | 'single'

/** Props for {@link SourcePicker}. */
interface SourcePickerProps {
  /**
   * Called with the chosen HARs once a source resolves to at least one.
   *
   * @remarks
   * Local picking is a batch in the default `'batch'` mode — the OS dialog
   * allows several files and a drop can carry many — so this takes a list,
   * previewed and confirmed together. A server archive is picked one at a time
   * and arrives as a single-element list. In `'single'` mode this always fires
   * with exactly one file. Fires only when at least one file was accepted; a
   * re-pick replaces the previous batch. The picker holds no selection of its
   * own; the caller owns what happens next.
   */
  readonly onPick: (picks: readonly PickedHar[]) => void
  /**
   * Whether the caller consumes a batch of HARs or a single HAR at a time.
   * Defaults to `'batch'`. See {@link SourcePickerMode}.
   */
  readonly mode?: SourcePickerMode
  /**
   * The OS dialog's `accept` attribute — a comma-joined list of extensions and
   * MIME types (`'.har,application/json'`). Composed by the shell from the
   * registered format bindings' own `accept` tokens (see
   * `importer-fundamentals`' `acceptFor`), so a new format that lands surfaces
   * its extensions here without the picker learning about it. A hint only:
   * drop and "All files" bypass it, and the actual decision is downstream
   * `decode`.
   */
  readonly accept: string
}

/**
 * The notice for files a batch pick rejected, naming them.
 *
 * @param names - The rejected files' names
 * @returns A one-line summary listing the rejected files
 *
 * @remarks
 * Names rather than parser detail: in a batch, *which* files were not HARs is the
 * actionable fact. A single rejected file with nothing accepted keeps its full
 * parser detail instead — that is the case a user is debugging one file.
 */
const rejectedNotice = (names: readonly string[]): string =>
  `${names.length} ${names.length === 1 ? 'file was not a valid HAR' : 'files were not valid HARs'}: ${names.join(', ')}`

/** One rejected file, its name and the parser's reason. */
interface RejectedFile {
  readonly name: string
  readonly message: string
}

/**
 * The picker error to show after a batch validates, or `null` for a clean batch.
 *
 * @remarks
 * A single rejected file with nothing accepted keeps its full parser detail —
 * the case a user is debugging one file; a mix reports the rejected names, since
 * _which_ files were not HARs is the actionable fact there.
 */
const pickerError = (rejected: readonly RejectedFile[], acceptedCount: number): string | null => {
  if (rejected.length === 0) return null
  if (acceptedCount === 0 && rejected.length === 1) return rejected[0]?.message ?? null
  return rejectedNotice(rejected.map((one) => one.name))
}

/**
 * The picker: a drop-and-pick zone, the file input it opens, a rejection notice,
 * and the server archive list.
 */
const SourcePicker = ({ onPick, mode = 'batch', accept }: SourcePickerProps): JSX.Element => {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

  // Validate every picked file through the HAR parser concurrently, then split
  // the outcomes with `Array.separate`: accepted picks are handed on as a batch,
  // rejected ones reported. A lone rejected file keeps its full parser detail
  // (the case worth debugging); a mix reports names. In `single` mode the
  // accepted list is clamped to the first file — a drop that carried several
  // still reaches the caller as one, since the preview downstream is per
  // archive.
  const acceptFiles = (files: readonly ReadableFile[]): Promise<void> =>
    Effect.runPromise(
      Effect.forEach(
        files,
        (file) =>
          acceptLocalHar(file).pipe(
            Effect.mapError((message) => ({ name: file.name, message })),
            Effect.either
          ),
        { concurrency: 'unbounded' }
      ).pipe(
        Effect.map((results) => {
          const [rejected, accepted] = Arr.separate(results)
          setError(pickerError(rejected, accepted.length))
          if (accepted.length === 0) return
          const chosen = mode === 'single' ? accepted.slice(0, 1) : accepted
          onPick(chosen)
        })
      )
    )

  const openPicker = (): void => fileInputRef.current?.click()

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const files = Array.from(event.target.files ?? [])
    // Reset the input so choosing the same file twice in a row still fires a
    // change — the browser suppresses it otherwise.
    event.target.value = ''
    if (files.length > 0) void acceptFiles(files)
  }

  const onDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    setDragActive(false)
    const files = Array.from(event.dataTransfer.files)
    if (files.length > 0) void acceptFiles(files)
  }

  const onDragOver = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    setDragActive(true)
  }

  return (
    <section aria-label="HAR source" className={styles.picker}>
      <button
        type="button"
        className={dragActive ? `${styles.zone} ${styles.zoneActive}` : styles.zone}
        onClick={openPicker}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragActive(false)}
      >
        {mode === 'single'
          ? 'Choose a HAR file, or drop it here'
          : 'Choose HAR files, or drop them here'}
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        aria-label="HAR file"
        multiple={mode === 'batch'}
        className={styles.fileInput}
        onChange={onFileInputChange}
      />
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <ServerHarArchiveList
        onPick={(picked) => {
          setError(null)
          onPick([picked])
        }}
      />
    </section>
  )
}

export { SourcePicker, type SourcePickerMode, type SourcePickerProps }

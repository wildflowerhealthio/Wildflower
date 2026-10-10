import { Array as Arr, Effect } from 'effect'
import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type JSX,
  type RefObject,
} from 'react'

import type { PickedFile, FormatDetector } from 'importer-fundamentals'
import { acceptLocalFile, type ReadableFile, type RejectedFile } from './local-file.ts'
import { ServerSourceFileList } from './server-source-file-list.tsx'
import styles from './source-picker.module.css'

/**
 * The one control that turns any of four sources into named bytes: a file
 * dropped on the zone, files chosen through the OS dialog, a whole folder, or
 * uploaded source files on the device's own FHIR server.
 *
 * @remarks
 * Drop is an enhancement, not the only path: the zone is itself a button that
 * opens the file picker, so the whole surface is reachable by keyboard and
 * named for a screen reader. The picker also offers a **folder**: a DICOM
 * study arrives as a directory of hundreds of `.dcm` files, and selecting
 * them by hand is the kind of thing a folder pick exists for. It is the same
 * path — the files a folder yields go through the same detectors, and
 * the ones no format claims are reported by name exactly as a file pick's
 * are. A local file — dropped or chosen — is
 * identified against the registered formats' detectors at the
 * picker, so a file no format claims is rejected *here*, next to the control
 * the user just used, rather than surfacing downstream. The server picks come
 * from {@link ServerSourceFileList}, which lists every registered format's
 * uploaded source files — HAR, LifeLabs PDF, and any future format — and fetches
 * the chosen ones back through that format's source-file codec; each resulting
 * pick carries the source file's own reference so a later step links provenance
 * without re-uploading the bytes.
 *
 * Presentation and interaction only. Nothing here parses HAR or opens a PDF —
 * both are the responsibility of the format's `decode` one step downstream.
 *
 * @packageDocumentation
 */

/**
 * Turn a file input into a directory input.
 *
 * @remarks
 * Through a ref rather than as JSX: `webkitdirectory` is a non-standard
 * attribute React's `InputHTMLAttributes` does not declare, and writing it as
 * a prop would need a cast around the whole element. Setting the attribute
 * imperatively needs none — and the input is a directory input from its first
 * paint, before any click can reach it.
 */
const useDirectoryInput = (): RefObject<HTMLInputElement | null> => {
  const ref = useRef<HTMLInputElement>(null)
  useEffect(() => {
    ref.current?.setAttribute('webkitdirectory', '')
  }, [])
  return ref
}

/** Props for {@link SourcePicker}. */
interface SourcePickerProps {
  /**
   * The registered formats' detectors, in registry priority order.
   * Each dropped or chosen file is identified against them at the picker;
   * the first detector that claims the file wins. Detection is all the picker
   * needs — it never reaches a format's `decode`, which is why this is a
   * `FormatDetector.Type` rather than a whole `FileImporter`.
   */
  readonly detectors: readonly FormatDetector.Type[]
  /**
   * Called with the chosen files once a source resolves to at least one.
   *
   * @remarks
   * Picking is always a batch — the OS dialog allows several files, a drop can
   * carry many, a folder carries a whole study, and the server list hands on
   * every row that was selected — so this takes a list, previewed and
   * confirmed together, and a local pick is never trimmed. Fires only when at
   * least one file was accepted; a re-pick replaces the previous batch. The
   * picker holds no selection of its own; the caller owns what happens next.
   */
  readonly onPick: (picks: readonly PickedFile.NamedBytes[]) => void
}

/**
 * The notice for files a batch pick rejected, naming them.
 *
 * @param names - The rejected files' names
 * @returns A one-line summary listing the rejected files
 *
 * @remarks
 * Names rather than parser detail: in a batch, *which* files were not
 * recognized is the actionable fact.
 */
const rejectedNotice = (names: readonly string[]): string =>
  `${names.length} ${names.length === 1 ? 'file was not recognized' : 'files were not recognized'}: ${names.join(', ')}`

/**
 * The picker error to show after a batch validates, or `null` for a clean
 * batch.
 *
 * @remarks
 * A single rejected file with nothing accepted keeps its rejection message —
 * the case a user is debugging one file; a mix reports the rejected names.
 */
const pickerError = (rejected: readonly RejectedFile[], acceptedCount: number): string | null => {
  if (rejected.length === 0) return null
  if (acceptedCount === 0 && rejected.length === 1) return rejected[0]?.message ?? null
  return rejectedNotice(rejected.map((one) => one.name))
}

/**
 * The picker: a drop-and-pick zone, the file input it opens, a rejection
 * notice, and the server source file list.
 */
const SourcePicker = ({ detectors, onPick }: SourcePickerProps): JSX.Element => {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const folderInputRef = useDirectoryInput()
  const [error, setError] = useState<string | null>(null)
  const [dragActive, setDragActive] = useState(false)

  // Identify every picked file against the registered detectors
  // concurrently, then split the outcomes with `Array.separate`: accepted
  // picks are handed on as a batch, rejected ones reported. A lone rejected
  // file keeps its rejection message (the case worth debugging); a mix
  // reports names. Nothing is trimmed: every accepted file reaches the caller.
  const acceptFiles = (files: readonly ReadableFile[]): Promise<void> =>
    Effect.runPromise(
      Effect.forEach(
        files,
        (file) =>
          acceptLocalFile(detectors, file).pipe(
            Effect.mapError((message): RejectedFile => ({ name: file.name, message })),
            Effect.either
          ),
        { concurrency: 'unbounded' }
      ).pipe(
        Effect.map((results) => {
          const [rejected, accepted] = Arr.separate(results)
          setError(pickerError(rejected, accepted.length))
          if (accepted.length === 0) return
          onPick(accepted)
        })
      )
    )

  const openPicker = (): void => fileInputRef.current?.click()
  const openFolderPicker = (): void => folderInputRef.current?.click()

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
    <section aria-label="File source" className={styles.picker}>
      <button
        type="button"
        className={dragActive ? `${styles.zone} ${styles.zoneActive}` : styles.zone}
        onClick={openPicker}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragActive(false)}
      >
        Choose files, or drop them here
      </button>
      <input
        ref={fileInputRef}
        type="file"
        aria-label="Import file"
        multiple
        className={styles.fileInput}
        onChange={onFileInputChange}
      />
      <button type="button" className={styles.folderButton} onClick={openPicker}>
        Choose files
      </button>
      <button type="button" className={styles.folderButton} onClick={openFolderPicker}>
        Choose a folder
      </button>
      <input
        ref={folderInputRef}
        type="file"
        aria-label="Import folder"
        multiple
        className={styles.fileInput}
        onChange={onFileInputChange}
      />
      {error !== null && (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      )}
      <ServerSourceFileList
        onPick={(picked) => {
          setError(null)
          onPick(picked)
        }}
      />
    </section>
  )
}

export { SourcePicker, type SourcePickerProps }

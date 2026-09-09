import { useRef, useState, type ChangeEvent, type DragEvent, type JSX } from 'react'

import type { PickedFile } from 'anonymizer-fundamentals'

import styles from './local-file-picker.module.css'

/**
 * The shell's local picker: a drop-and-pick zone and the hidden file input it
 * opens. Format-blind — it reads the file's bytes and hands them on; which
 * format claims them is the shell's routing decision, made against the
 * registry, so a rejection surfaces next to the picker without the picker
 * validating anything itself.
 *
 * @remarks
 * Drop is an enhancement, not the only path: the zone is itself a button that
 * opens the file picker, so the whole surface is reachable by keyboard and
 * named for a screen reader. Single-file: a drop that carried several files is
 * trimmed to the first, since everything downstream reviews one document at a
 * time.
 *
 * @packageDocumentation
 */

/** Props for {@link LocalFilePicker}. */
interface LocalFilePickerProps {
  /** The `accept` attribute for the OS dialog — a hint, never the decision. */
  readonly accept: string
  /** Called with the picked file's name and bytes once a pick resolves. */
  readonly onPick: (file: PickedFile) => void
}

/** The drop-zone-as-button picker over one local file. */
const LocalFilePicker = ({ accept, onPick }: LocalFilePickerProps): JSX.Element => {
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [dragActive, setDragActive] = useState(false)

  const acceptFile = async (file: File): Promise<void> => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    onPick({ fileName: file.name, bytes })
  }

  const openPicker = (): void => fileInputRef.current?.click()

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    const first = event.target.files?.[0]
    // Reset the input so choosing the same file twice in a row still fires a
    // change — the browser suppresses it otherwise.
    event.target.value = ''
    if (first !== undefined) void acceptFile(first)
  }

  const onDrop = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    setDragActive(false)
    const first = event.dataTransfer.files[0]
    if (first !== undefined) void acceptFile(first)
  }

  const onDragOver = (event: DragEvent<HTMLButtonElement>): void => {
    event.preventDefault()
    setDragActive(true)
  }

  return (
    <>
      <button
        type="button"
        className={dragActive ? `${styles.zone} ${styles.zoneActive}` : styles.zone}
        onClick={openPicker}
        onDrop={onDrop}
        onDragOver={onDragOver}
        onDragLeave={() => setDragActive(false)}
      >
        Choose a file, or drop it here
      </button>
      <input
        ref={fileInputRef}
        type="file"
        accept={accept}
        aria-label="File to anonymize"
        className={styles.fileInput}
        onChange={onFileInputChange}
      />
    </>
  )
}

export { LocalFilePicker, type LocalFilePickerProps }

/**
 * DICOM file preview: identifying patient and study tags from the parsed
 * header, plus how the instance is encoded, under a cornerstone-rendered
 * image pane.
 *
 * @packageDocumentation
 */

import { DicomHeader } from 'dicom'
import { Either } from 'effect'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'

import { encodingRows } from './encoding-rows.ts'
import { observeViewportResize, renderInstance, type RenderOutcome } from './render-instance.ts'
import styles from './file-preview.module.css'

const ABSENT = '—'

/**
 * Props for {@link DicomFilePreview}: the bytes alone, since the shell's
 * preview dialog renders the file's name in its own header. A subset of the
 * `NamedBytes` that slot passes, so filling it costs no dependency on the
 * importer slice.
 */
interface DicomFilePreviewProps {
  readonly bytes: Uint8Array
  readonly fileName: string
  readonly renderDicomInstance?: typeof renderInstance
  readonly observeDicomViewportResize?: typeof observeViewportResize
}

/**
 * Parse the DICOM file and render its identifying tags, and how the instance
 * is encoded, under the image. A parse failure renders an inline error; a
 * non-image instance (or a codec failure) shows a "No renderable image"
 * placeholder, which the Encoding block is there to explain.
 */
const DicomFilePreview = ({
  bytes,
  renderDicomInstance = renderInstance,
  observeDicomViewportResize = observeViewportResize,
}: DicomFilePreviewProps): JSX.Element => {
  const parsed = useMemo(() => DicomHeader.tryFromDicomFile(bytes), [bytes])
  return Either.match(parsed, {
    onLeft: (error) => <ParseError reason={error.reason} />,
    onRight: (header) => (
      <ImageAndTags
        header={header}
        bytes={bytes}
        renderDicomInstance={renderDicomInstance}
        observeDicomViewportResize={observeDicomViewportResize}
      />
    ),
  })
}

const ParseError = ({ reason }: { readonly reason: string }): JSX.Element => (
  <p role="alert" className={styles['dicom-preview__error']}>
    Could not parse this file as DICOM: {reason}
  </p>
)

const ImageAndTags = ({
  header,
  bytes,
  renderDicomInstance,
  observeDicomViewportResize,
}: {
  readonly header: DicomHeader.Type
  readonly bytes: Uint8Array
  readonly renderDicomInstance: typeof renderInstance
  readonly observeDicomViewportResize: typeof observeViewportResize
}): JSX.Element => (
  <div className={styles['dicom-preview']}>
    <ImagePane
      bytes={bytes}
      renderDicomInstance={renderDicomInstance}
      observeDicomViewportResize={observeDicomViewportResize}
    />
    <div className={styles['dicom-preview__tags']}>
      <TagBlock title="Patient">
        <TagRow label="Patient Name" value={header.patientName?.text} />
        <TagRow label="Patient ID" value={header.patientId} />
        <TagRow label="Birth Date" value={header.patientBirthDate} />
        <TagRow label="Sex" value={header.patientSex} />
      </TagBlock>
      <TagBlock title="Study">
        <TagRow label="Study Date" value={header.studyDate} />
        <TagRow label="Description" value={header.studyDescription} />
        <TagRow label="Accession #" value={header.accessionNumber} />
        <TagRow label="Study Instance UID" value={header.studyInstanceUid} />
        <TagRow label="Modality" value={header.modality} />
      </TagBlock>
      <TagBlock title="Encoding">
        {encodingRows(header).map((row) => (
          <TagRow key={row.label} label={row.label} value={row.value} detail={row.detail} />
        ))}
      </TagBlock>
    </div>
  </div>
)

const TagBlock = ({
  title,
  children,
}: {
  readonly title: string
  readonly children: JSX.Element | JSX.Element[]
}): JSX.Element => (
  <div>
    <h4 className={styles['dicom-preview__tag-block-title']}>{title}</h4>
    <dl className={styles['dicom-preview__tag-list']}>{children}</dl>
  </div>
)

const TagRow = ({
  label,
  value,
  detail,
}: {
  readonly label: string
  readonly value: string | undefined
  readonly detail?: string | undefined
}): JSX.Element => (
  <>
    <dt className={styles['dicom-preview__tag-label']}>{label}</dt>
    <dd className={styles['dicom-preview__tag-value']}>
      {value ?? ABSENT}
      {detail !== undefined && (
        <span className={styles['dicom-preview__tag-detail']}>{detail}</span>
      )}
    </dd>
  </>
)

const ImagePane = ({
  bytes,
  renderDicomInstance,
  observeDicomViewportResize,
}: {
  readonly bytes: Uint8Array
  readonly renderDicomInstance: typeof renderInstance
  readonly observeDicomViewportResize: typeof observeViewportResize
}): JSX.Element => {
  const elementRef = useRef<HTMLDivElement>(null)
  const [outcome, setOutcome] = useState<RenderOutcome | null>(null)

  useEffect(() => {
    const element = elementRef.current
    if (element === null) return undefined
    let cancelled = false
    void renderDicomInstance(bytes, element).then((result) => {
      if (!cancelled) setOutcome(result)
    })
    // Started alongside the render rather than after it: the observer's first
    // callback is what corrects a canvas sized before the pane had a box, and
    // waiting for a multi-megabyte decode to finish would leave that first
    // frame stretched until the next resize.
    const stopObservingResize = observeDicomViewportResize(element)
    return (): void => {
      cancelled = true
      stopObservingResize()
    }
  }, [bytes, renderDicomInstance, observeDicomViewportResize])

  return (
    <div className={styles['dicom-preview__image']}>
      <div
        ref={elementRef}
        className={styles['dicom-preview__viewport']}
        data-testid="dicom-viewport"
      />
      {outcome?._tag === 'unrenderable' && (
        <p className={styles['dicom-preview__placeholder']} data-testid="dicom-unrenderable">
          No renderable image: {outcome.reason}
        </p>
      )}
    </div>
  )
}

export { DicomFilePreview }
export type { DicomFilePreviewProps }

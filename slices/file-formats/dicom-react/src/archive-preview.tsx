/**
 * DICOM archive preview: identifying patient and study tags from the parsed
 * header beside a cornerstone-rendered image pane.
 *
 * @packageDocumentation
 */

import { type DicomHeader, parseDicomFile } from 'dicom'
import { Either } from 'effect'
import { useEffect, useMemo, useRef, useState, type JSX } from 'react'

import { renderInstance, type RenderOutcome } from './render-instance.ts'

const ABSENT = '—'

/** Props for {@link DicomArchivePreview}. */
interface DicomArchivePreviewProps {
  readonly fileName: string
  readonly bytes: Uint8Array
  readonly renderDicomInstance?: typeof renderInstance
}

/**
 * Parse the DICOM file and render its identifying tags alongside the image.
 * A parse failure renders an inline error; a non-image instance (or a codec
 * failure) shows a "No renderable image" placeholder.
 */
const DicomArchivePreview = ({
  bytes,
  renderDicomInstance = renderInstance,
}: DicomArchivePreviewProps): JSX.Element => {
  const parsed = useMemo(() => parseDicomFile(bytes), [bytes])
  return Either.match(parsed, {
    onLeft: (error) => <ParseError reason={error.reason} />,
    onRight: (header) => (
      <TagsAndImage header={header} bytes={bytes} renderDicomInstance={renderDicomInstance} />
    ),
  })
}

const ParseError = ({ reason }: { readonly reason: string }): JSX.Element => (
  <p role="alert" style={inlineStyles.error}>
    Could not parse this file as DICOM: {reason}
  </p>
)

const TagsAndImage = ({
  header,
  bytes,
  renderDicomInstance,
}: {
  readonly header: DicomHeader
  readonly bytes: Uint8Array
  readonly renderDicomInstance: typeof renderInstance
}): JSX.Element => (
  <div style={inlineStyles.container}>
    <div style={inlineStyles.tags}>
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
    </div>
    <ImagePane bytes={bytes} renderDicomInstance={renderDicomInstance} />
  </div>
)

const TagBlock = ({
  title,
  children,
}: {
  readonly title: string
  readonly children: JSX.Element | JSX.Element[]
}): JSX.Element => (
  <div style={inlineStyles.tagBlock}>
    <h4 style={inlineStyles.tagBlockTitle}>{title}</h4>
    <dl style={inlineStyles.dl}>{children}</dl>
  </div>
)

const TagRow = ({
  label,
  value,
}: {
  readonly label: string
  readonly value: string | undefined
}): JSX.Element => (
  <>
    <dt style={inlineStyles.dt}>{label}</dt>
    <dd style={inlineStyles.dd}>{value ?? ABSENT}</dd>
  </>
)

const ImagePane = ({
  bytes,
  renderDicomInstance,
}: {
  readonly bytes: Uint8Array
  readonly renderDicomInstance: typeof renderInstance
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
    return (): void => {
      cancelled = true
    }
  }, [bytes, renderDicomInstance])

  return (
    <div style={inlineStyles.imagePane}>
      <div ref={elementRef} style={inlineStyles.viewport} data-testid="dicom-viewport" />
      {outcome?._tag === 'unrenderable' && (
        <p style={inlineStyles.placeholder} data-testid="dicom-unrenderable">
          No renderable image: {outcome.reason}
        </p>
      )}
    </div>
  )
}

const inlineStyles = {
  container: {
    display: 'flex',
    gap: '1rem',
    minHeight: '300px',
  } satisfies React.CSSProperties,
  tags: {
    flex: '0 0 auto',
    minWidth: '220px',
    maxWidth: '320px',
    overflow: 'auto',
  } satisfies React.CSSProperties,
  tagBlock: {
    marginBottom: '0.75rem',
  } satisfies React.CSSProperties,
  tagBlockTitle: {
    margin: '0 0 0.25rem 0',
    fontSize: '0.875rem',
    fontWeight: 600,
  } satisfies React.CSSProperties,
  dl: {
    margin: 0,
    display: 'grid',
    gridTemplateColumns: 'auto 1fr',
    gap: '0.125rem 0.5rem',
    fontSize: '0.8125rem',
  } satisfies React.CSSProperties,
  dt: {
    fontWeight: 500,
    color: 'var(--color-neutral-4, #888)',
    whiteSpace: 'nowrap' as const,
  } satisfies React.CSSProperties,
  dd: {
    margin: 0,
    wordBreak: 'break-all' as const,
  } satisfies React.CSSProperties,
  imagePane: {
    flex: '1 1 0',
    position: 'relative' as const,
    minHeight: '300px',
    background: '#000',
    borderRadius: '4px',
    overflow: 'hidden',
  } satisfies React.CSSProperties,
  viewport: {
    width: '100%',
    height: '100%',
    minHeight: '300px',
  } satisfies React.CSSProperties,
  placeholder: {
    position: 'absolute' as const,
    inset: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#999',
    fontSize: '0.875rem',
    margin: 0,
    padding: '1rem',
    textAlign: 'center' as const,
  } satisfies React.CSSProperties,
  error: {
    color: 'var(--color-neutral-2, #c00)',
    fontSize: '0.875rem',
    margin: '0.5rem 0',
  } satisfies React.CSSProperties,
} as const

export { DicomArchivePreview }
export type { DicomArchivePreviewProps }

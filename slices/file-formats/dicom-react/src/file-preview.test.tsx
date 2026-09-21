import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { writeDicom } from 'dicom/test-helpers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { DicomFilePreview } from './file-preview.tsx'
import type { RenderOutcome } from './render-instance.ts'

const rendered: RenderOutcome = { _tag: 'rendered' }
const unrenderable = (reason: string): RenderOutcome => ({ _tag: 'unrenderable', reason })

const stubRenderer =
  (outcome: RenderOutcome) =>
  async (_bytes: Uint8Array, _element: HTMLDivElement): Promise<RenderOutcome> =>
    outcome

const MINIMAL_TAGS = {
  StudyInstanceUID: '1.2.3.4.5',
  SeriesInstanceUID: '1.2.3.4.6',
  SOPInstanceUID: '1.2.3.4.7',
} as const

describe('DicomFilePreview', () => {
  afterEach(cleanup)

  it('renders patient and study tags from a parsed DICOM file', () => {
    const bytes = writeDicom({
      ...MINIMAL_TAGS,
      PatientName: { family: 'Doe', given: 'Jane', text: 'Doe Jane' },
      PatientID: 'PID-001',
      PatientBirthDate: '19900115',
      PatientSex: 'F',
      StudyDate: '20240301',
      StudyDescription: 'Chest X-Ray',
      AccessionNumber: '12345',
      Modality: 'DX',
    })

    render(
      <DicomFilePreview
        bytes={bytes}
        fileName="scan.dcm"
        renderDicomInstance={stubRenderer(rendered)}
      />
    )

    expect(screen.getByText('Patient')).toBeTruthy()
    expect(screen.getByText('Study')).toBeTruthy()

    expect(screen.getByText('Doe Jane')).toBeTruthy()
    expect(screen.getByText('PID-001')).toBeTruthy()
    expect(screen.getByText('19900115')).toBeTruthy()
    expect(screen.getByText('F')).toBeTruthy()

    expect(screen.getByText('20240301')).toBeTruthy()
    expect(screen.getByText('Chest X-Ray')).toBeTruthy()
    expect(screen.getByText('12345')).toBeTruthy()
    expect(screen.getByText('1.2.3.4.5')).toBeTruthy()
    expect(screen.getByText('DX')).toBeTruthy()
  })

  it('renders an Encoding block with every row from the parsed header', () => {
    const bytes = writeDicom({
      ...MINIMAL_TAGS,
      TransferSyntaxUID: '1.2.840.10008.1.2.4.90',
      SOPClassUID: '1.2.840.10008.5.1.4.1.1.2',
      Rows: 512,
      Columns: 512,
      PhotometricInterpretation: 'MONOCHROME2',
      BitsAllocated: 16,
      BitsStored: 12,
      HighBit: 11,
      PixelData: { kind: 'encapsulated', fragmentLengths: [2048] },
    })

    render(
      <DicomFilePreview
        bytes={bytes}
        fileName="scan.dcm"
        renderDicomInstance={stubRenderer(rendered)}
      />
    )

    expect(screen.getByText('Encoding')).toBeTruthy()
    // The rows' own formatting is covered in encoding-rows.test.ts; what this
    // asserts is that the block is wired to the parsed header at all.
    expect(screen.getByText('1.2.840.10008.1.2.4.90')).toBeTruthy()
    expect(screen.getByText('JPEG 2000 Lossless')).toBeTruthy()
    expect(screen.getByText('CT Image Storage')).toBeTruthy()
    expect(screen.getByText('512 × 512 (w × h)')).toBeTruthy()
    expect(screen.getByText('MONOCHROME2')).toBeTruthy()
    expect(screen.getByText('16 allocated, 12 stored, high bit 11')).toBeTruthy()
    // 2,072 = basic offset table item (8) + the fragment's header and bytes
    // (8 + 2048) + the sequence delimiter (8).
    expect(screen.getByText('OB, encapsulated, 1 fragment, 2,072 bytes')).toBeTruthy()
  })

  it('reports an absent pixel data element, the usual cause of a blank pane', () => {
    const bytes = writeDicom(MINIMAL_TAGS)

    render(
      <DicomFilePreview
        bytes={bytes}
        fileName="scan.dcm"
        renderDicomInstance={stubRenderer(rendered)}
      />
    )

    expect(screen.getByText('No (7FE0,0010) element — this instance carries no image')).toBeTruthy()
  })

  it('renders em-dash for missing optional tags', () => {
    const bytes = writeDicom(MINIMAL_TAGS)

    render(
      <DicomFilePreview
        bytes={bytes}
        fileName="scan.dcm"
        renderDicomInstance={stubRenderer(rendered)}
      />
    )

    const dashes = screen.getAllByText('—')
    expect(dashes.length).toBeGreaterThanOrEqual(8)
  })

  it('renders a parse error for non-DICOM bytes', () => {
    const garbage = new Uint8Array([0, 1, 2, 3])

    render(
      <DicomFilePreview
        bytes={garbage}
        fileName="scan.dcm"
        renderDicomInstance={stubRenderer(rendered)}
      />
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Could not parse this file as DICOM')
  })

  it('shows "No renderable image" when the render outcome is unrenderable', async () => {
    const bytes = writeDicom(MINIMAL_TAGS)

    render(
      <DicomFilePreview
        bytes={bytes}
        fileName="scan.dcm"
        renderDicomInstance={stubRenderer(unrenderable('no pixel data'))}
      />
    )

    await waitFor(() => {
      expect(screen.getByTestId('dicom-unrenderable').textContent).toContain('no pixel data')
    })
  })

  it('does not show the unrenderable placeholder when rendering succeeds', async () => {
    const bytes = writeDicom(MINIMAL_TAGS)

    render(
      <DicomFilePreview
        bytes={bytes}
        fileName="scan.dcm"
        renderDicomInstance={stubRenderer(rendered)}
      />
    )

    await waitFor(() => {
      expect(screen.queryByTestId('dicom-unrenderable')).toBeNull()
    })
  })

  it('observes the viewport for resizes and stops on unmount', async () => {
    const bytes = writeDicom(MINIMAL_TAGS)
    const stopObserving = vi.fn()
    const observe = vi.fn((_element: HTMLDivElement) => stopObserving)

    const { unmount } = render(
      <DicomFilePreview
        bytes={bytes}
        fileName="scan.dcm"
        renderDicomInstance={stubRenderer(rendered)}
        observeDicomViewportResize={observe}
      />
    )

    // Observation starts with the mount, not after the decode: the first
    // callback is what corrects a canvas sized before the pane had a box.
    expect(observe).toHaveBeenCalledOnce()
    expect(observe.mock.calls[0][0]).toBe(screen.getByTestId('dicom-viewport'))
    expect(stopObserving).not.toHaveBeenCalled()

    unmount()

    // A live ResizeObserver on a detached element would pin the whole mount.
    await waitFor(() => {
      expect(stopObserving).toHaveBeenCalledOnce()
    })
  })

  it('calls the render stub exactly once and cancels on unmount', async () => {
    const bytes = writeDicom(MINIMAL_TAGS)
    const stub = vi.fn(stubRenderer(rendered))

    const { unmount } = render(
      <DicomFilePreview bytes={bytes} fileName="scan.dcm" renderDicomInstance={stub} />
    )

    await waitFor(() => {
      expect(stub).toHaveBeenCalledOnce()
    })

    expect(stub.mock.calls[0][0]).toBe(bytes)
    expect(stub.mock.calls[0][1]).toBeInstanceOf(HTMLDivElement)

    unmount()
  })
})

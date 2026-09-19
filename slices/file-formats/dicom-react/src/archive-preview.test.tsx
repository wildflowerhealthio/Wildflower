import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { writeDicom } from 'dicom/test-helpers'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { DicomArchivePreview } from './archive-preview.tsx'
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

describe('DicomArchivePreview', () => {
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
      <DicomArchivePreview
        fileName="test.dcm"
        bytes={bytes}
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

  it('renders em-dash for missing optional tags', () => {
    const bytes = writeDicom(MINIMAL_TAGS)

    render(
      <DicomArchivePreview
        fileName="minimal.dcm"
        bytes={bytes}
        renderDicomInstance={stubRenderer(rendered)}
      />
    )

    const dashes = screen.getAllByText('—')
    expect(dashes.length).toBeGreaterThanOrEqual(8)
  })

  it('renders a parse error for non-DICOM bytes', () => {
    const garbage = new Uint8Array([0, 1, 2, 3])

    render(
      <DicomArchivePreview
        fileName="bad.dcm"
        bytes={garbage}
        renderDicomInstance={stubRenderer(rendered)}
      />
    )

    const alert = screen.getByRole('alert')
    expect(alert.textContent).toContain('Could not parse this file as DICOM')
  })

  it('shows "No renderable image" when the render outcome is unrenderable', async () => {
    const bytes = writeDicom(MINIMAL_TAGS)

    render(
      <DicomArchivePreview
        fileName="test.dcm"
        bytes={bytes}
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
      <DicomArchivePreview
        fileName="test.dcm"
        bytes={bytes}
        renderDicomInstance={stubRenderer(rendered)}
      />
    )

    await waitFor(() => {
      expect(screen.queryByTestId('dicom-unrenderable')).toBeNull()
    })
  })

  it('calls the render stub exactly once and cancels on unmount', async () => {
    const bytes = writeDicom(MINIMAL_TAGS)
    const stub = vi.fn(stubRenderer(rendered))

    const { unmount } = render(
      <DicomArchivePreview fileName="test.dcm" bytes={bytes} renderDicomInstance={stub} />
    )

    await waitFor(() => {
      expect(stub).toHaveBeenCalledOnce()
    })

    expect(stub.mock.calls[0][0]).toBe(bytes)
    expect(stub.mock.calls[0][1]).toBeInstanceOf(HTMLDivElement)

    unmount()
  })
})

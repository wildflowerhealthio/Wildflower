import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import type { JSX } from 'react'
import { afterEach, describe, expect, it } from 'vite-plus/test'

import type { PickedFile } from 'anonymizer-fundamentals'

import { HAR_PARSE_ERROR } from 'har-anonymizer-core'
import { AnonymizerScreen, UNIDENTIFIED_ERROR } from './anonymizer-screen.tsx'
import { RECOGNIZED_HAR } from './test-helpers.ts'

/**
 * The unified anonymize surface, end to end over the real screen → picker →
 * registry identification → format decode → panel path. Everything is local:
 * no router, no query client, no server — the `serverSource` slot is the one
 * seam a host adds those through, and it is tested as a seam.
 */

afterEach(cleanup)

describe('AnonymizerScreen', () => {
  it('should route a locally picked HAR to the anonymize panel', async () => {
    // Arrange
    render(<AnonymizerScreen />)

    // Act — pick a HAR through the OS picker
    await userEvent.upload(screen.getByLabelText('File to anonymize'), harFile('portal.har'))

    // Assert — identified as HAR, decoded, and the panel offers the download
    expect(await screen.findByRole('region', { name: 'Anonymize' })).toBeDefined()
    expect(await screen.findByRole('button', { name: 'Download anonymized HAR' })).toBeDefined()
  })

  it('should show the generic alert for a file no format claims', async () => {
    // Arrange
    render(<AnonymizerScreen />)

    // Act — a PDF: no registered format claims it yet (accept filtering is
    // bypassed; the OS dialog's accept is a hint, not the decision)
    const pdf = new File(['%PDF-1.7 …'], 'report.pdf', { type: 'application/pdf' })
    await userEvent.upload(screen.getByLabelText('File to anonymize'), pdf, {
      applyAccept: false,
    })

    // Assert
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', UNIDENTIFIED_ERROR)
    expect(screen.queryByRole('region', { name: 'Anonymize' })).toBeNull()
  })

  it("should show the format's own error when identification succeeds but decoding fails", async () => {
    // Arrange
    render(<AnonymizerScreen />)

    // Act — JSON-shaped (so HAR claims it) but not a HAR
    const notAHar = new File(['{"not":"a har"}'], 'notes.json', { type: 'application/json' })
    await userEvent.upload(screen.getByLabelText('File to anonymize'), notAHar)

    // Assert
    expect(await screen.findByRole('alert')).toHaveProperty('textContent', HAR_PARSE_ERROR)
    expect(screen.queryByRole('region', { name: 'Anonymize' })).toBeNull()
  })

  it('should route a pick handed in through the serverSource slot like a local one', async () => {
    // Arrange — a host-provided source that hands back a PickedFile
    const serverPick: PickedFile = {
      fileName: 'server-session.har',
      bytes: new TextEncoder().encode(RECOGNIZED_HAR),
    }
    const TestServerSource = ({
      onPick,
    }: {
      readonly onPick: (file: PickedFile) => void
    }): JSX.Element => (
      <button type="button" onClick={() => onPick(serverPick)}>
        Use server-session.har
      </button>
    )
    render(<AnonymizerScreen serverSource={TestServerSource} />)

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Use server-session.har' }))

    // Assert
    expect(await screen.findByRole('region', { name: 'Anonymize' })).toBeDefined()
  })

  it('should return to the picker on `Pick another`, discarding the previous pick', async () => {
    // Arrange
    render(<AnonymizerScreen />)
    await userEvent.upload(screen.getByLabelText('File to anonymize'), harFile('portal.har'))
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Anonymize' })).toBeDefined()
    })

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Pick another' }))

    // Assert — back at the sources, the panel is gone
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'File source' })).toBeDefined()
    })
    expect(screen.queryByRole('region', { name: 'Anonymize' })).toBeNull()
  })
})

// Helpers

/** A HAR `File`, for the OS-picker (`upload`) path. */
const harFile = (name: string): File =>
  new File([RECOGNIZED_HAR], name, { type: 'application/json' })

import { cleanup, render, screen } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Schema } from 'effect'
import { afterEach, describe, expect, it, vi } from 'vite-plus/test'

import { AttachmentViewer, PREVIEW_CHARACTER_CAP } from './attachment-viewer.tsx'
import type { ViewableAttachment } from './viewable-attachment.ts'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('AttachmentViewer', () => {
  it('should render a JSON body re-indented', () => {
    // Act
    render(<AttachmentViewer attachment={stored('application/json', '{"patientId":"9f3"}')} />)

    // Assert
    expect(screen.getByText('{\n  "patientId": "9f3"\n}', EXACT_TEXT)).toBeDefined()
  })

  it('should render JSON leaf values exactly as captured, unredacted', () => {
    // Arrange — these are the values the export flow pseudonymizes. The viewer
    // runs on the user's own device against their own data and shows them as-is.
    const body = '{"mrn":"884213760","name":"Ada Lovelace","token":"eyJhbGciOiJIUzI1NiJ9"}'

    // Act
    render(<AttachmentViewer attachment={stored('application/json', body)} />)

    // Assert
    const rendered = screen.getByText(/"mrn"/).textContent ?? ''
    expect(rendered).toContain('884213760')
    expect(rendered).toContain('Ada Lovelace')
    expect(rendered).toContain('eyJhbGciOiJIUzI1NiJ9')
  })

  it('should render a text body decoded', () => {
    // Act
    render(<AttachmentViewer attachment={stored('text/html; charset=utf-8', '<p>hello</p>')} />)

    // Assert
    expect(screen.getByText('<p>hello</p>')).toBeDefined()
  })

  it('should render an SVG as its markup rather than as an image', () => {
    // Arrange — an SVG can carry script and remote references; rendering one
    // would execute whatever the recorded page served.
    const markup = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'

    // Act
    render(<AttachmentViewer attachment={stored('image/svg+xml', markup)} />)

    // Assert
    expect(screen.getByText(markup)).toBeDefined()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('should render a raster image from a data URI, never a network fetch', () => {
    // Act
    render(<AttachmentViewer attachment={stored('image/png', 'pretend-png-bytes')} />)

    // Assert — no network egress at any point is the premise of the app
    const image = screen.getByRole('img')
    expect(image.getAttribute('src')).toMatch(/^data:image\/png;base64,/)
  })

  it('should show a body labelled JSON that is not JSON as itself', () => {
    // Act
    render(<AttachmentViewer attachment={stored('application/json', '<html>nope</html>')} />)

    // Assert — hiding the mismatch would hide what a collector author needs
    expect(screen.getByText('<html>nope</html>')).toBeDefined()
  })

  it('should say an unrecognised type has no preview instead of rendering bytes as text', () => {
    // Act
    render(<AttachmentViewer attachment={stored('application/octet-stream', '\u0000\u0001')} />)

    // Assert
    expect(screen.getByText('Stored, but this content type has no inline preview.')).toBeDefined()
  })

  it('should report a body whose base64 does not decode', () => {
    // Arrange
    const attachment: ViewableAttachment = {
      contentType: 'application/json',
      data: 'not base64 !!!',
      size: 14,
      hash: HASH,
      title: null,
      absence: null,
    }

    // Act
    render(<AttachmentViewer attachment={attachment} />)

    // Assert — blank would read as an empty body
    expect(screen.getByText('Body is not decodable base64')).toBeDefined()
  })

  it('should render a skipped body as skipped, with its size and hash', () => {
    // Arrange
    const attachment: ViewableAttachment = {
      contentType: 'video/mp4',
      data: null,
      size: 84_213_760,
      hash: HASH,
      title: null,
      absence: { _tag: 'SkippedAtCapture', reason: 'over the size cap' },
    }

    // Act
    render(<AttachmentViewer attachment={attachment} />)

    // Assert — the size reads in the app's one byte format (`kitchen-sink`'s
    // `formatBytes`), not as a raw count this component spells out itself
    expect(screen.getByText('Body not stored at capture: over the size cap.')).toBeDefined()
    expect(screen.getByText('80 MB')).toBeDefined()
    expect(screen.getByText(`sha256 ${HASH}`)).toBeDefined()
  })

  it('should name where by-reference content lives without fetching it', () => {
    // Arrange
    const attachment: ViewableAttachment = {
      contentType: 'application/pdf',
      data: null,
      size: null,
      hash: null,
      title: null,
      absence: { _tag: 'ByReference', url: 'https://files.example.org/report.pdf' },
    }

    // Act
    render(<AttachmentViewer attachment={attachment} />)

    // Assert
    expect(
      screen.getByText(
        'Content is held at https://files.example.org/report.pdf, not in this record. The viewer does not fetch it.'
      )
    ).toBeDefined()
  })

  it('should distinguish an empty record from a skipped body', () => {
    // Arrange
    const attachment: ViewableAttachment = {
      contentType: 'application/pdf',
      data: null,
      size: null,
      hash: null,
      title: null,
      absence: { _tag: 'Empty' },
    }

    // Act
    render(<AttachmentViewer attachment={attachment} />)

    // Assert
    expect(screen.getByText('This record carries no content.')).toBeDefined()
  })

  it('should hold a very large body behind a control rather than rendering it on open', async () => {
    // Arrange — the verbatim capture policy stores bodies whole, so a recorded
    // download can be large enough to hang the tab if pretty-printed on open.
    const huge = 'x'.repeat(PREVIEW_CHARACTER_CAP + 1)

    // Act
    render(<AttachmentViewer attachment={stored('text/plain', huge)} />)

    // Assert
    expect(screen.queryByText(huge)).toBeNull()
    const reveal = screen.getByRole('button', {
      name: `Show ${huge.length.toLocaleString()} characters`,
    })

    // Act — the content is still reachable, just not by accident
    await userEvent.click(reveal)

    // Assert
    expect(screen.getByText(huge)).toBeDefined()
  })

  it('should not carry a revealed large body over to the next attachment', async () => {
    // Arrange — this viewer is shared, so a list hands the same mounted instance
    // a different attachment in place and React keeps the state across the swap.
    const first = 'a'.repeat(PREVIEW_CHARACTER_CAP + 1)
    const second = 'b'.repeat(PREVIEW_CHARACTER_CAP + 1)
    const { rerender } = render(<AttachmentViewer attachment={stored('text/plain', first)} />)
    await userEvent.click(
      screen.getByRole('button', { name: `Show ${first.length.toLocaleString()} characters` })
    )
    expect(screen.queryByRole('button', { name: /^Show / })).toBeNull()

    // Act
    rerender(<AttachmentViewer attachment={stored('text/plain', second)} />)

    // Assert — consent was given for one body, not for every body after it
    expect(
      screen.getByRole('button', { name: `Show ${second.length.toLocaleString()} characters` })
    ).toBeDefined()
  })

  it('should render a body at the cap without asking', () => {
    // Arrange
    const atCap = 'x'.repeat(PREVIEW_CHARACTER_CAP)

    // Act
    render(<AttachmentViewer attachment={stored('text/plain', atCap)} />)

    // Assert
    expect(screen.getByText(atCap)).toBeDefined()
  })

  it('should name an unrecorded content type rather than showing an empty chip', () => {
    // Act
    render(<AttachmentViewer attachment={stored('', 'anything')} />)

    // Assert
    expect(screen.getByText('unknown type')).toBeDefined()
  })
})

// Helpers

const HASH = 'RBNvo1WzZ4oRRq0W9+hknpT7T8If536DEMBg9hyq/4o='

const encodeBase64 = Schema.encodeSync(Schema.StringFromBase64)

/**
 * Queries text without whitespace normalisation. Testing Library collapses runs
 * of whitespace by default, which would erase the indentation the JSON
 * assertions exist to check.
 */
const EXACT_TEXT = { normalizer: (text: string): string => text }

/** A stored attachment carrying `text` as its bytes. */
const stored = (contentType: string, text: string): ViewableAttachment => ({
  contentType,
  data: encodeBase64(text),
  size: text.length,
  hash: HASH,
  title: null,
  absence: null,
})

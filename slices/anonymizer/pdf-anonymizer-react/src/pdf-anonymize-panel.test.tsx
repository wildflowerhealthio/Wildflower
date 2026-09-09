import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Schema } from 'effect'
import { PositionedTextFromJson, type PositionedTextDocument } from 'pdf-anonymizer-core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { PdfAnonymizePanel } from './pdf-anonymize-panel.tsx'

let downloaded: Blob[] = []

beforeEach(() => {
  downloaded = []
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    value: (blob: Blob): string => {
      downloaded.push(blob)
      return 'blob:test/1'
    },
  })
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    value: (): void => undefined,
  })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
  vi.restoreAllMocks()
})

const decode = Schema.decodeSync(PositionedTextFromJson)

const downloadedDoc = async (): Promise<PositionedTextDocument> => {
  const blob = downloaded.at(-1)
  if (blob === undefined) throw new Error('nothing was downloaded')
  return decode(await blob.text())
}

describe('PdfAnonymizePanel', () => {
  it('should display page and run counts', async () => {
    // Arrange & Act
    render(<PdfAnonymizePanel value={twoPageDoc()} fileName="report.pdf" />)

    // Assert
    expect(screen.getByText(/2 pages/)).toBeDefined()
    expect(screen.getByText(/3 positioned text runs/)).toBeDefined()
  })

  it('should download positioned-text JSON with no masking when no rules are entered', async () => {
    // Arrange
    const doc = singleRunDoc('John Smith, DOB: 1990-05-12')
    render(<PdfAnonymizePanel value={doc} fileName="report.pdf" />)

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Download anonymized JSON' }))

    // Assert
    const result = await downloadedDoc()
    expect(result.pages[0].runs[0].text).toBe('John Smith, DOB: 1990-05-12')
  })

  it('should mask entered substrings in the downloaded JSON', async () => {
    // Arrange
    const doc = singleRunDoc('John Smith, DOB: 1990-05-12')
    render(<PdfAnonymizePanel value={doc} fileName="report.pdf" />)

    // Act
    const input = screen.getByLabelText('Text to mask')
    await userEvent.type(input, 'John Smith')
    await userEvent.click(screen.getByRole('button', { name: 'Download anonymized JSON' }))

    // Assert
    const result = await downloadedDoc()
    expect(result.pages[0].runs[0].text).toBe('Xxxx Xxxxx, DOB: 1990-05-12')
    expect(result.pages[0].runs[0].text).not.toContain('John Smith')
  })

  it('should show live match counts for entered rules', async () => {
    // Arrange
    const doc = singleRunDoc('AB CD AB EF AB')
    render(<PdfAnonymizePanel value={doc} fileName="report.pdf" />)

    // Act
    const input = screen.getByLabelText('Text to mask')
    await userEvent.type(input, 'AB')

    // Assert
    await waitFor(() => {
      expect(screen.getByText('3 matches')).toBeDefined()
    })
  })

  it('should warn when a rule has zero matches', async () => {
    // Arrange
    const doc = singleRunDoc('hello world')
    render(<PdfAnonymizePanel value={doc} fileName="report.pdf" />)

    // Act
    const input = screen.getByLabelText('Text to mask')
    await userEvent.type(input, 'missing')

    // Assert
    await waitFor(() => {
      expect(screen.getByText('0 matches')).toBeDefined()
    })
  })

  it('should add and remove substitution rules', async () => {
    // Arrange
    render(<PdfAnonymizePanel value={singleRunDoc('test')} fileName="report.pdf" />)

    // Act — add a second rule
    await userEvent.click(screen.getByRole('button', { name: 'Add rule' }))

    // Assert
    expect(screen.getAllByLabelText('Text to mask')).toHaveLength(2)

    // Act — remove the first rule
    const removeButtons = screen.getAllByRole('button', { name: /Remove rule/ })
    await userEvent.click(removeButtons[0])

    // Assert
    expect(screen.getAllByLabelText('Text to mask')).toHaveLength(1)
  })

  it('should toggle between original and anonymized preview', async () => {
    // Arrange
    const doc = singleRunDoc('Jane Doe')
    render(<PdfAnonymizePanel value={doc} fileName="report.pdf" />)
    const input = screen.getByLabelText('Text to mask')
    await userEvent.type(input, 'Jane Doe')

    // Act — shows original by default
    const page = screen.getByLabelText('Page 1')
    expect(within(page).getByText('Jane Doe')).toBeDefined()

    // Act — toggle to anonymized
    await userEvent.click(screen.getByRole('switch', { name: 'Show anonymized preview' }))

    // Assert — shows masked text
    await waitFor(() => {
      expect(within(page).getByText('Xxxx Xxx')).toBeDefined()
    })
  })

  it('should produce a valid PositionedTextDocument in the download', async () => {
    // Arrange
    const doc = twoPageDoc()
    render(<PdfAnonymizePanel value={doc} fileName="lab-results.pdf" />)
    const input = screen.getByLabelText('Text to mask')
    await userEvent.type(input, 'LifeLabs')

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Download anonymized JSON' }))

    // Assert
    const result = await downloadedDoc()
    expect(result.format).toBe('wildflower-positioned-text')
    expect(result.version).toBe(1)
    expect(result.pages).toHaveLength(2)
    for (const page of result.pages) {
      for (const run of page.runs) {
        expect(run.text.toLowerCase()).not.toContain('lifelabs')
      }
    }
  })
})

// Helpers

const singleRunDoc = (text: string): PositionedTextDocument => ({
  format: 'wildflower-positioned-text',
  version: 1,
  pages: [
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      runs: [{ text, x: 72, y: 50, width: 200, fontSize: 12 }],
    },
  ],
})

const twoPageDoc = (): PositionedTextDocument => ({
  format: 'wildflower-positioned-text',
  version: 1,
  fileName: 'lab-results.pdf',
  pages: [
    {
      pageNumber: 1,
      width: 612,
      height: 792,
      runs: [
        { text: 'LifeLabs Report', x: 72, y: 50, width: 120, fontSize: 16 },
        { text: 'Patient: Jane Doe', x: 72, y: 100, width: 140, fontSize: 12 },
      ],
    },
    {
      pageNumber: 2,
      width: 612,
      height: 792,
      runs: [{ text: 'Result: 5.4 mmol/L', x: 72, y: 50, width: 130, fontSize: 12 }],
    },
  ],
})

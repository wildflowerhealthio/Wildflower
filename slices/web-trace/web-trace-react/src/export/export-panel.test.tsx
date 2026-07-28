import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { Schema } from 'effect'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'
import type { TraceExchange } from 'web-trace-core'
import { jsonBody, traceExchange } from 'web-trace-core/test-helpers'

import { ExportPanel } from './export-panel.tsx'

/**
 * The ticket's export acceptance, driven through the real UI: the panel says
 * what the archive contains, the preview separates what leaves as captured from
 * what does not, an override changes what leaves, and the download carries no
 * original identifier value.
 *
 * The point of asserting on the *downloaded bytes* rather than on the hook's
 * state is that it is the only assertion that catches the UI routing around the
 * pseudonymizer — a panel that emitted raw exchanges would still render a
 * perfectly convincing preview.
 *
 * `URL.createObjectURL` is jsdom's one gap here: it is unimplemented, so the
 * test supplies it and keeps the blob it was handed. That is the seam, not the
 * subject — the archive inside the blob is what is under test.
 */

const MRN_PREFIX = '883-11-'
const SESSION_ID = 'morning'

let downloaded: Blob[] = []

beforeEach(() => {
  downloaded = []
  // Defined *onto* the real `URL`, never over it: the pseudonymizer parses
  // captured URLs with `new URL(...)`, so replacing the global with a plain
  // object breaks the subject rather than the seam.
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
  // jsdom refuses to navigate, and an anchor click is how a blob is saved.
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(URL, 'createObjectURL')
  Reflect.deleteProperty(URL, 'revokeObjectURL')
  vi.restoreAllMocks()
})

const decodeBase64 = Schema.decodeSync(Schema.StringFromBase64)

/**
 * The part of the archive these tests read back, **decoded** rather than cast.
 * A `JSON.parse(...) as Har` would claim a shape the downloaded bytes might not
 * have, which is precisely what a test over those bytes exists to check.
 */
const ArchiveShape = Schema.Struct({
  log: Schema.Struct({
    entries: Schema.Array(
      Schema.Struct({
        response: Schema.Struct({
          content: Schema.Struct({
            text: Schema.optional(Schema.String),
            encoding: Schema.optional(Schema.String),
          }),
        }),
      })
    ),
  }),
})
const parseArchive = Schema.decodeUnknownSync(Schema.parseJson(ArchiveShape))

/** The archive inside the most recently downloaded blob. */
const downloadedArchive = async (): Promise<typeof ArchiveShape.Type> => {
  const blob = downloaded.at(-1)
  if (blob === undefined) throw new Error('nothing was downloaded')
  return parseArchive(await blob.text())
}

/**
 * Everything the archive actually says, with its bodies decoded.
 *
 * @remarks
 * HAR carries a body as base64 in `content.text`, so searching the raw file for
 * a captured value finds nothing **whether or not the value was redacted**.
 * A "no original value survives" assertion over the undecoded bytes is exactly
 * the test that cannot fail. Every body is decoded back to text first.
 */
const downloadedText = async (): Promise<string> => {
  const archive = await downloadedArchive()
  const bodies = archive.log.entries.map((entry) => {
    const { text, encoding } = entry.response.content
    if (text === undefined) return ''
    return encoding === 'base64' ? decodeBase64(text) : text
  })
  return [JSON.stringify(archive), ...bodies].join('\n')
}

/** `count` exchanges each carrying a distinct `mrn` and a shared `status`. */
const manyMrns = (count: number): readonly TraceExchange[] =>
  Array.from({ length: count }, (_unused, index) =>
    traceExchange({
      sessionId: SESSION_ID,
      requestId: `req-${index}`,
      url: `https://portal.example.org/api/v2/patients/${1000 + index}`,
      body: {
        _tag: 'StoredBody',
        contentType: 'application/json',
        size: 40,
        hash: 'aGFzaA==',
        data: jsonBody({ mrn: `${MRN_PREFIX}${String(index).padStart(4, '0')}`, status: 'active' }),
      },
    })
  )

/** One exchange holding the fields a single-patient session actually leaks. */
const onePatient = (): readonly TraceExchange[] => [
  traceExchange({
    sessionId: SESSION_ID,
    requestId: 'req-0',
    body: {
      _tag: 'StoredBody',
      contentType: 'application/json',
      size: 160,
      hash: 'aGFzaA==',
      data: jsonBody({
        email: 'ada@example.com',
        birthDate: '1990-05-12',
        zipPostalCode: '02139',
        status: 'active',
      }),
    },
  }),
]

/** Mounts the panel and waits for its first preview. */
const mountAndSettle = async (
  exchanges: readonly TraceExchange[],
  sessionExchangeCount = exchanges.length
): Promise<void> => {
  render(
    <ExportPanel
      exchanges={exchanges}
      sessionExchangeCount={sessionExchangeCount}
      sessionId={SESSION_ID}
    />
  )
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Fields exported as captured' })).toBeDefined()
  })
}

/** Turns on the code carve-out, which is off when the panel opens. */
const showCodes = async (): Promise<void> => {
  await userEvent.click(screen.getByRole('switch'))
  await waitFor(() => {
    expect(screen.queryByText('No fields are exported as captured')).toBeNull()
  })
}

/** The row whose field cell ends with `suffix`, anywhere in the preview. */
const rowFor = (suffix: string): HTMLElement => {
  const row = screen
    .getAllByRole('row')
    .find((candidate) => within(candidate).queryByText(new RegExp(`${suffix}$`)) !== null)
  if (row === undefined) throw new Error(`no preview row for ${suffix}`)
  return row
}

/** The data rows inside the "exported as captured" section, header excluded. */
const visibleRows = (): readonly HTMLElement[] => {
  const section = screen.getByRole('region', { name: 'Fields exported as captured' })
  return within(section).queryAllByRole('row').slice(1)
}

describe('ExportPanel', () => {
  it('should export nothing as captured until the reviewer asks for it', async () => {
    // Arrange & Act — the default. Clicking Download without touching a control
    // must produce the safest archive, not the most convenient one.
    await mountAndSettle(onePatient())

    // Assert
    expect(screen.getByText('No fields are exported as captured')).toBeDefined()
    expect(screen.getByRole('switch')).toHaveProperty('checked', false)

    await userEvent.click(screen.getByRole('button', { name: 'Download redacted HAR' }))
    const text = await downloadedText()
    for (const value of ['ada@example.com', '1990-05-12', '02139', 'active']) {
      expect(text).not.toContain(value)
    }
  })

  it('should keep one patient’s email, birth date, and postal code out even with codes on', async () => {
    // Arrange — the reported leak. Each of these takes exactly one distinct
    // value at its path, so a count-only carve-out exported all three.
    await mountAndSettle(onePatient())

    // Act
    await showCodes()
    await userEvent.click(screen.getByRole('button', { name: 'Download redacted HAR' }))

    // Assert — hidden as "not a code", and absent from the archive
    for (const field of ['email', 'birthDate', 'zipPostalCode']) {
      expect(within(rowFor(field)).getByText(/not a code/)).toBeDefined()
    }
    const text = await downloadedText()
    for (const value of ['ada@example.com', '1990-05-12', '02139']) {
      expect(text).not.toContain(value)
    }
    // The carve-out still earns its keep at the same cardinality.
    expect(text).toContain('active')
  })

  it('should separate what leaves as captured from what does not', async () => {
    // Arrange
    await mountAndSettle(manyMrns(20))

    // Act
    await showCodes()

    // Assert — only `status` is exported as captured; the long tail of
    // pseudonymized fields sits behind a disclosure so it cannot bury it.
    await waitFor(() => {
      expect(visibleRows()).toHaveLength(1)
    })
    expect(within(visibleRows()[0] ?? document.body).getByText(/status$/)).toBeDefined()
    expect(screen.getByText(/^Replaced with pseudonyms \(\d+\)$/)).toBeDefined()
  })

  it('should say what the Auto setting resolves to, and why', async () => {
    // Arrange — a bare "Auto" makes the reviewer infer the outcome from another
    // column, and the reason matters because the two hidden cases have
    // different fixes.
    await mountAndSettle(manyMrns(20))

    // Assert
    expect(within(rowFor('status')).getByText('Auto — hidden (codes off)')).toBeDefined()

    // Act
    await showCodes()

    // Assert
    await waitFor(() => {
      expect(within(rowFor('status')).getByText('Auto — visible (1 value)')).toBeDefined()
    })
    expect(within(rowFor('mrn')).getByText('Auto — hidden (not a code)')).toBeDefined()
  })

  it('should download a HAR carrying no original identifier value', async () => {
    // Arrange
    const exchanges = manyMrns(20)
    await mountAndSettle(exchanges)
    await showCodes()

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Download redacted HAR' }))

    // Assert — the acceptance itself. Every captured `mrn` is absent from the
    // archive's *decoded* content, which is only true if the download went
    // through `redactSession` rather than around it.
    const text = await downloadedText()
    for (let index = 0; index < exchanges.length; index += 1) {
      expect(text).not.toContain(`${MRN_PREFIX}${String(index).padStart(4, '0')}`)
    }
    expect((await downloadedArchive()).log.entries).toHaveLength(exchanges.length)
  })

  it('should download the exchanges the preview showed, pseudonym for pseudonym', async () => {
    // Arrange
    await mountAndSettle(manyMrns(20))

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Download redacted HAR' }))

    // Assert — the exported value a reviewer read is the value in the file. A
    // panel that re-redacted at download time could hand over something else.
    const exported = within(rowFor('mrn')).getAllByRole('cell')[2]?.textContent
    expect(exported).toBeTruthy()
    expect(await downloadedText()).toContain(exported)
  })

  it('should let a per-path override put an original value back into the archive', async () => {
    // Arrange
    await mountAndSettle(manyMrns(20))

    // Act
    await userEvent.selectOptions(within(rowFor('mrn')).getByRole('combobox'), 'verbatim')
    await waitFor(() => {
      expect(visibleRows().length).toBeGreaterThan(0)
    })
    await userEvent.click(screen.getByRole('button', { name: 'Download redacted HAR' }))

    // Assert — the override is honoured all the way to the file, which is what
    // makes it a decision the reviewer actually owns.
    expect(await downloadedText()).toContain(`${MRN_PREFIX}0000`)
  })

  it('should state what the archive contains and what it never could', async () => {
    // Arrange & Act — three of ten, the shape "a filtered subset" takes
    await mountAndSettle(manyMrns(3), 10)

    // Assert
    expect(screen.getByText(/3 of 10 exchanges/)).toBeDefined()
    expect(screen.getByText(/3 JSON response bodies/)).toBeDefined()
    expect(screen.getByText(/No request method, request headers, or request body/)).toBeDefined()
  })

  it('should say how many non-JSON bodies the export drops rather than dropping them silently', async () => {
    // Arrange
    const html = traceExchange({
      sessionId: SESSION_ID,
      requestId: 'html',
      body: {
        _tag: 'StoredBody',
        contentType: 'text/html; charset=utf-8',
        size: 120,
        hash: 'aA==',
        data: jsonBody('<p>hello</p>'),
      },
    })

    // Act
    await mountAndSettle([...manyMrns(2), html])

    // Assert — the export is JSON-only by design, and an export that quietly
    // dropped a body would misrepresent what the session did.
    expect(screen.getByText(/1 non-JSON body/)).toBeDefined()
    expect(screen.getByText(/2 JSON response bodies/)).toBeDefined()
  })

  it('should say there is nothing to drop when every body is JSON', async () => {
    // Arrange & Act
    await mountAndSettle(manyMrns(2))

    // Assert
    expect(screen.getByText(/No non-JSON bodies to drop/)).toBeDefined()
  })
})

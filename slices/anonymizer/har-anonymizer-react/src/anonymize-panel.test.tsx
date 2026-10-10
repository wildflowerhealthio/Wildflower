import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import { userEvent } from '@testing-library/user-event'
import { DateTime, Schema } from 'effect'
import { HttpArchive } from 'http-archive'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vite-plus/test'

import { AnonymizePanel } from './anonymize-panel.tsx'

/**
 * The ticket's acceptance, driven through the real UI: the panel says what the
 * archive contains, the preview separates what leaves as captured from what
 * does not, an override changes what leaves, and the download carries no
 * original identifier value.
 *
 * The point of asserting on the *downloaded bytes* rather than on the hook's
 * state is that it is the only assertion that catches the UI routing around
 * the pseudonymizer — a panel that emitted the raw archive would still render
 * a perfectly convincing preview.
 *
 * `URL.createObjectURL` is jsdom's one gap here: it is unimplemented, so the
 * test supplies it and keeps the blob it was handed. That is the seam, not
 * the subject — the archive inside the blob is what is under test.
 */

const MRN_PREFIX = '883-11-'
const FILE_NAME = 'morning-capture.har'

const utf8 = new TextEncoder()

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
        request: Schema.Struct({
          method: Schema.String,
          headers: Schema.Array(Schema.Struct({ name: Schema.String, value: Schema.String })),
        }),
        response: Schema.Struct({
          content: Schema.Struct({
            text: Schema.optional(Schema.String),
            encoding: Schema.optional(Schema.String),
          }),
        }),
      })
    ),
    comment: Schema.optional(Schema.String),
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
 * HAR carries a body as base64 in `content.text`, so searching the raw file
 * for a captured value finds nothing **whether or not the value was redacted**.
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

const jsonEntry = (
  overrides: {
    readonly id?: string
    readonly url?: string
    readonly body?: unknown
    readonly bodyAbsent?: boolean
    readonly contentType?: string
  } = {}
): HttpArchive.Entry => {
  const contentType = overrides.contentType ?? 'application/json'
  const bytes =
    overrides.body === undefined
      ? new Uint8Array(0)
      : utf8.encode(
          typeof overrides.body === 'string' ? overrides.body : JSON.stringify(overrides.body)
        )
  return {
    id: overrides.id ?? 'har-entry-0',
    url: overrides.url ?? 'https://portal.example.org/api/v2/patients/10432',
    method: 'GET',
    status: 200,
    statusText: 'OK',
    headers: [['content-type', contentType]],
    startedAt: DateTime.unsafeMake('2026-09-04T00:00:00Z'),
    body: bytes,
    bodyAbsent: overrides.bodyAbsent ?? bytes.length === 0,
  }
}

const logOf = (entries: readonly HttpArchive.Entry[]): HttpArchive.Log => ({
  version: '1.2',
  entries,
})

/** `count` entries each carrying a distinct `mrn` and a shared `status`. */
const manyMrns = (count: number): HttpArchive.Log =>
  logOf(
    Array.from({ length: count }, (_unused, index) =>
      jsonEntry({
        id: `har-entry-${index}`,
        url: `https://portal.example.org/api/v2/patients/${1000 + index}`,
        body: { mrn: `${MRN_PREFIX}${String(index).padStart(4, '0')}`, status: 'active' },
      })
    )
  )

/** One entry holding the fields a single-patient session actually leaks. */
const onePatient = (): HttpArchive.Log =>
  logOf([
    jsonEntry({
      body: {
        email: 'ada@example.com',
        birthDate: '1990-05-12',
        zipPostalCode: '02139',
        status: 'active',
      },
    }),
  ])

/**
 * A searchset bundle shaped like the real capture this rule came from: private
 * `system` and `extension.url` keys, a coded value, and a `link.url` that
 * addresses one patient.
 */
const fhirBundle = (): HttpArchive.Log =>
  logOf([
    jsonEntry({
      contentType: 'application/fhir+json',
      body: {
        resourceType: 'Bundle',
        type: 'searchset',
        link: [
          {
            relation: 'self',
            url: 'https://portal.example.org/fhir/MedicationRequest?_id=faa2ea21-545d-45b1-aed8-b76b6f894bb6',
          },
        ],
        entry: [
          {
            resource: {
              resourceType: 'MedicationRequest',
              identifier: [
                {
                  system:
                    'http://schema.carebook.com/v1/fhir/identifier/medicationrequest-external-id',
                  value: '7565407',
                },
              ],
              medicationCodeableConcept: {
                coding: [
                  {
                    system: 'http://schema.carebook.com/v1/fhir/coding/medication-din-code',
                    code: '85785208',
                  },
                ],
              },
              extension: [
                {
                  url: 'http://schemas.carebook.com/v1/fhir/medicationrequest/extension/number-of-repeats-available',
                  valuePositiveInt: 3,
                },
              ],
            },
          },
        ],
      },
    }),
  ])

/** Mounts the panel and waits for its first preview. */
const mountAndSettle = async (
  log: HttpArchive.Log,
  fileName: string = FILE_NAME
): Promise<void> => {
  render(<AnonymizePanel log={log} fileName={fileName} />)
  await waitFor(() => {
    expect(screen.getByRole('region', { name: 'Fields exported as captured' })).toBeDefined()
  })
}

/** The panel's two verbatim switches, both off when it opens. */
const codesSwitch = (): HTMLElement =>
  screen.getByRole('switch', { name: /Show short codes as captured/ })

const schemaUrlsSwitch = (): HTMLElement =>
  screen.getByRole('switch', { name: /Show schema URLs as captured/ })

/** Turns on the code carve-out, which is off when the panel opens. */
const showCodes = async (): Promise<void> => {
  await userEvent.click(codesSwitch())
  await waitFor(() => {
    expect(screen.queryByText('No fields are exported as captured')).toBeNull()
  })
}

/** Turns on the namespace-URI rule, which is off when the panel opens. */
const showSchemaUrls = async (): Promise<void> => {
  await userEvent.click(schemaUrlsSwitch())
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

describe('AnonymizePanel', () => {
  it('should export nothing as captured until the reviewer asks for it', async () => {
    // Arrange & Act — the default. Clicking Download without touching a
    // control must produce the safest archive, not the most convenient one.
    await mountAndSettle(onePatient())

    // Assert
    expect(screen.getByText('No fields are exported as captured')).toBeDefined()
    expect(codesSwitch()).toHaveProperty('checked', false)
    expect(schemaUrlsSwitch()).toHaveProperty('checked', false)

    await userEvent.click(screen.getByRole('button', { name: 'Download anonymized HAR' }))
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
    await userEvent.click(screen.getByRole('button', { name: 'Download anonymized HAR' }))

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
    // Arrange — a bare "Auto" makes the reviewer infer the outcome from
    // another column, and the reason matters because the two hidden cases
    // have different fixes.
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
    const log = manyMrns(20)
    await mountAndSettle(log)
    await showCodes()

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Download anonymized HAR' }))

    // Assert — the acceptance itself. Every captured `mrn` is absent from the
    // archive's *decoded* content, which is only true if the download went
    // through `redactLog` rather than around it.
    const text = await downloadedText()
    for (let index = 0; index < log.entries.length; index += 1) {
      expect(text).not.toContain(`${MRN_PREFIX}${String(index).padStart(4, '0')}`)
    }
    expect((await downloadedArchive()).log.entries).toHaveLength(log.entries.length)
  })

  it('should download the entries the preview showed, pseudonym for pseudonym', async () => {
    // Arrange
    await mountAndSettle(manyMrns(20))

    // Act
    await userEvent.click(screen.getByRole('button', { name: 'Download anonymized HAR' }))

    // Assert — the exported value a reviewer read is the value in the file.
    // A panel that re-redacted at download time could hand over something
    // else.
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
    await userEvent.click(screen.getByRole('button', { name: 'Download anonymized HAR' }))

    // Assert — the override is honoured all the way to the file, which is
    // what makes it a decision the reviewer actually owns.
    expect(await downloadedText()).toContain(`${MRN_PREFIX}0000`)
  })

  it('should keep FHIR schema URLs readable once the reviewer asks, and the record URL beside them hidden', async () => {
    // Arrange — a MedicationRequest bundle shaped like the real one.
    await mountAndSettle(fhirBundle())

    // Act
    await showSchemaUrls()
    await userEvent.click(screen.getByRole('button', { name: 'Download anonymized HAR' }))

    // Assert — the keys survive
    const text = await downloadedText()
    for (const system of [
      'http://schema.carebook.com/v1/fhir/identifier/medicationrequest-external-id',
      'http://schema.carebook.com/v1/fhir/coding/medication-din-code',
      'http://schemas.carebook.com/v1/fhir/medicationrequest/extension/number-of-repeats-available',
    ]) {
      expect(text).toContain(system)
    }
    // …and the record URL, the patient id inside it, and the code values do
    // not
    expect(text).not.toContain('_id=faa2ea21-545d-45b1-aed8-b76b6f894bb6')
    expect(text).not.toContain('faa2ea21-545d-45b1-aed8-b76b6f894bb6')
    expect(text).not.toContain('85785208')
  })

  it('should name the schema-URL rule in the preview rather than the value count', async () => {
    // Arrange — the count is not what decided these rows, so reporting it
    // would send the reviewer to a threshold that had no say.
    await mountAndSettle(fhirBundle())

    // Assert
    expect(within(rowFor('system')).getByText('Auto — hidden (schema URLs off)')).toBeDefined()

    // Act
    await showSchemaUrls()

    // Assert
    await waitFor(() => {
      expect(within(rowFor('system')).getByText('Auto — visible (schema URL)')).toBeDefined()
    })
  })

  it('should state what the archive contains and what it never could', async () => {
    // Arrange & Act
    await mountAndSettle(manyMrns(3))

    // Assert
    expect(screen.getByText(/3 archived responses/)).toBeDefined()
    expect(screen.getByText(/3 JSON response bodies/)).toBeDefined()
    expect(
      screen.getByText(/Request method, request headers and request body were dropped/)
    ).toBeDefined()
  })

  it('should say how many non-JSON bodies the anonymize drops rather than dropping them silently', async () => {
    // Arrange
    const html = jsonEntry({
      id: 'html',
      contentType: 'text/html; charset=utf-8',
      body: '<p>hello</p>',
    })

    // Act
    await mountAndSettle(logOf([...manyMrns(2).entries, html]))

    // Assert — the anonymize is JSON-only by design, and one that quietly
    // dropped a body would misrepresent what the source held.
    expect(screen.getByText(/1 non-JSON body/)).toBeDefined()
    expect(screen.getByText(/2 JSON response bodies/)).toBeDefined()
  })

  it('should say there is nothing to drop when every body is JSON', async () => {
    // Arrange & Act
    await mountAndSettle(manyMrns(2))

    // Assert
    expect(screen.getByText(/No non-JSON bodies to drop/)).toBeDefined()
  })

  it('should carry a DevTools-shaped archive through the panel with no request side and no original leaf', async () => {
    // Arrange — the shape a real Chrome DevTools export takes: request method,
    // request headers, and request body live on the wire, and `LogFromHarJson`
    // drops them at import so the panel never sees them. This test drives the
    // decoded projection through the panel and asserts the archive downloaded
    // states no request side.
    const devToolsHar = JSON.stringify({
      log: {
        version: '1.2',
        creator: { name: 'DevTools', version: '1.0' },
        entries: [
          {
            startedDateTime: '2026-09-04T00:00:00Z',
            time: 42,
            request: {
              method: 'POST',
              url: 'https://portal.example.org/api/v2/patients/10432',
              httpVersion: 'HTTP/2',
              cookies: [],
              headers: [{ name: 'Authorization', value: 'Bearer super-secret-token' }],
              queryString: [],
              headersSize: -1,
              bodySize: 12,
              postData: { mimeType: 'application/json', text: '{"q":"ada"}' },
            },
            response: {
              status: 200,
              statusText: 'OK',
              httpVersion: 'HTTP/2',
              cookies: [],
              headers: [{ name: 'content-type', value: 'application/json' }],
              content: {
                size: 40,
                mimeType: 'application/json',
                text: btoa(
                  JSON.stringify({ mrn: '883-11-9999', email: 'ada@example.com', status: 'active' })
                ),
                encoding: 'base64',
              },
              redirectURL: '',
              headersSize: -1,
              bodySize: 40,
            },
            cache: {},
            timings: { send: -1, wait: 12, receive: 30 },
          },
        ],
      },
    })
    const log = Schema.decodeUnknownSync(HttpArchive.LogFromHarJson)(devToolsHar)

    // Act
    await mountAndSettle(log)
    await userEvent.click(screen.getByRole('button', { name: 'Download anonymized HAR' }))

    // Assert — the archive downloaded carries no request side at all, and no
    // captured leaf value survives the anonymize.
    const archive = await downloadedArchive()
    expect(archive.log.entries.length).toBe(1)
    for (const entry of archive.log.entries) {
      expect(entry.request.method).toBe('UNKNOWN')
      expect(entry.request.headers).toHaveLength(0)
    }
    const text = await downloadedText()
    expect(text).not.toContain('super-secret-token')
    expect(text).not.toContain('ada@example.com')
    expect(text).not.toContain('883-11-9999')
    expect(text).not.toContain('{"q":"ada"}')
  })
})

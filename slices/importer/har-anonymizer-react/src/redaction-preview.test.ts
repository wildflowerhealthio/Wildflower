import { DateTime, Effect } from 'effect'
import type { HttpArchive } from 'har-importer-core/har'
import { describe, expect, it } from 'vite-plus/test'

import {
  buildAnonymizePreview,
  droppedBodyCount,
  jsonBodyCount,
  sampleLeaves,
} from './redaction-preview.ts'

/**
 * The preview is the pseudonymizer's own output, not a second implementation.
 * That is the property these tests exist to hold: the `after` a reviewer reads
 * is sampled from what `redactLog` produced, and the very same log is what the
 * download emits.
 */

const SALT = 'test-salt-not-minted'

const utf8 = new TextEncoder()

/** One archive entry with a JSON body. */
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

/** `count` entries sharing one `status` and each carrying a distinct `mrn`. */
const manyMrns = (count: number): HttpArchive.Log =>
  logOf(
    Array.from({ length: count }, (_unused, index) =>
      jsonEntry({
        id: `har-entry-${index}`,
        url: `https://portal.example.org/api/v2/patients/${1000 + index}`,
        body: { mrn: `883-11-${String(index).padStart(4, '0')}`, status: 'active' },
      })
    )
  )

describe('buildAnonymizePreview', () => {
  it('should show a before and an after for every path the policy decided on', async () => {
    // Arrange
    const log = logOf([jsonEntry({ body: { mrn: '883-11-4520', status: 'active' } })])

    // Act
    const preview = await Effect.runPromise(buildAnonymizePreview(log, { salt: SALT }))

    // Assert — every row is reviewable: a path with no `before` would be a row
    // a reader cannot act on.
    expect(preview.rows.length).toBeGreaterThan(0)
    expect(preview.rows.every((row) => row.before !== null)).toBe(true)
    expect(preview.rows.every((row) => row.after !== null)).toBe(true)
  })

  it('should show a pseudonymized path changing and a verbatim path unchanged', async () => {
    // Arrange — the carve-out counts *distinct values across the archive*, not
    // what a field is called: `status` holds one value across twenty entries
    // and carves out, `mrn` holds twenty and does not.
    const log = manyMrns(20)

    // Act
    const preview = await Effect.runPromise(buildAnonymizePreview(log, { salt: SALT }))

    // Assert — this is the before → after the ticket asks the preview to show
    const mrn = preview.rows.find((row) => row.path.endsWith('mrn'))
    const status = preview.rows.find((row) => row.path.endsWith('status'))
    expect(mrn?.distinctValues).toBe(20)
    expect(mrn?.before).toBe('883-11-0000')
    expect(mrn?.verbatim).toBe(false)
    expect(mrn?.after).not.toBe('883-11-0000')
    expect(status?.distinctValues).toBe(1)
    expect(status?.before).toBe('active')
    expect(status?.verbatim).toBe(true)
    expect(status?.after).toBe('active')
  })

  it('should reveal a path a per-path override asks for, and say the override decided it', async () => {
    // Arrange — twenty distinct values, so the threshold hides this path and
    // the override has something to beat.
    const log = manyMrns(20)
    const hidden = await Effect.runPromise(buildAnonymizePreview(log, { salt: SALT }))
    const mrnPath = hidden.rows.find((row) => row.path.endsWith('mrn'))?.path
    if (mrnPath === undefined) throw new Error('expected an mrn path')

    // Act
    const revealed = await Effect.runPromise(
      buildAnonymizePreview(log, { salt: SALT, overrides: { [mrnPath]: 'verbatim' } })
    )

    // Assert — the override wins over the threshold, and the row says which
    // decided it, so a reviewer can tell their own choice from the policy's.
    expect(hidden.rows.find((one) => one.path === mrnPath)?.verbatim).toBe(false)
    const row = revealed.rows.find((one) => one.path === mrnPath)
    expect(row?.verbatim).toBe(true)
    expect(row?.decidedBy).toBe('override')
    expect(row?.after).toBe('883-11-0000')
  })

  it('should hide a path an override pseudonymizes even when it is under the threshold', async () => {
    // Arrange — `status` carves out by default; the override must beat that.
    const log = logOf([jsonEntry({ body: { status: 'active' } })])
    const auto = await Effect.runPromise(buildAnonymizePreview(log, { salt: SALT }))
    const statusPath = auto.rows.find((row) => row.path.endsWith('status'))?.path
    if (statusPath === undefined) throw new Error('expected a status path')

    // Act
    const overridden = await Effect.runPromise(
      buildAnonymizePreview(log, { salt: SALT, overrides: { [statusPath]: 'pseudonymize' } })
    )

    // Assert
    const row = overridden.rows.find((one) => one.path === statusPath)
    expect(row?.verbatim).toBe(false)
    expect(row?.decidedBy).toBe('override')
    expect(row?.after).not.toBe('active')
  })

  it('should stop carving out at all when the carve-out is turned off', async () => {
    // Arrange
    const log = logOf([jsonEntry({ body: { status: 'active' } })])

    // Act — both verbatim rules off. There are two, and "carving out at all"
    // means neither, so leaving the namespace-URI rule at its default would
    // let a `system` field through a test that claims nothing survives.
    const preview = await Effect.runPromise(
      buildAnonymizePreview(log, { salt: SALT, enumCarveOut: false, namespaceUris: false })
    )

    // Assert — nothing is verbatim, and every row says the carve-out is what
    // is off rather than that the threshold rejected it.
    expect(preview.rows.every((row) => !row.verbatim)).toBe(true)
    expect(preview.rows.every((row) => row.decidedBy === 'disabled')).toBe(true)
  })

  it('should show a structural leaf passing through unchanged, since the core never rewrites one', async () => {
    // Arrange — `null`, booleans, and the empty string are *structure*, not
    // data: `redactEntry` passes them through whatever the policy says,
    // because they carry no identity.
    const log = logOf([jsonEntry({ body: { id: null, deceased: false, note: '' } })])

    // Act
    const preview = await Effect.runPromise(
      buildAnonymizePreview(log, { salt: SALT, enumCarveOut: false })
    )

    // Assert — the row says the path is pseudonymized (it is, for any value
    // that carries identity) and shows this value surviving, which is exactly
    // what the archive will contain.
    const id = preview.rows.find((row) => row.path.endsWith('id'))
    expect(id?.verbatim).toBe(false)
    expect(id?.before).toBe('null')
    expect(id?.after).toBe('null')
    expect(preview.rows.find((row) => row.path.endsWith('deceased'))?.after).toBe('false')
  })

  it('should hand back the log it previewed, so the archive cannot differ from the review', async () => {
    // Arrange
    const log = manyMrns(5)

    // Act
    const preview = await Effect.runPromise(buildAnonymizePreview(log, { salt: SALT }))

    // Assert — same count, same order, same ids. This is what lets the panel
    // emit `preview.redacted` rather than re-redacting at download time and
    // hoping the two agree.
    expect(preview.redacted.entries).toHaveLength(log.entries.length)
    expect(preview.redacted.entries.map((one) => one.id)).toEqual(log.entries.map((one) => one.id))
  })

  it('should sample the after values from the redacted log itself', async () => {
    // Arrange — the anti-second-implementation test. Whatever the preview
    // shows as `after` must be findable in what the redactor produced; a row
    // computed some other way would drift from the archive without anything
    // catching it.
    const log = logOf([jsonEntry({ body: { mrn: '883-11-4520', name: 'Ada Lovelace' } })])

    // Act
    const preview = await Effect.runPromise(buildAnonymizePreview(log, { salt: SALT }))
    const fromRedacted = await Effect.runPromise(sampleLeaves(preview.redacted))

    // Assert
    for (const row of preview.rows) {
      if (row.after !== null) expect(fromRedacted.get(row.path)).toBe(row.after)
    }
  })
})

describe('droppedBodyCount / jsonBodyCount', () => {
  it('should count present non-JSON bodies as dropped and JSON as kept', () => {
    // Arrange
    const html = jsonEntry({
      id: 'html',
      contentType: 'text/html; charset=utf-8',
      body: '<p>hello</p>',
    })
    const json = jsonEntry({
      id: 'json',
      contentType: 'application/fhir+json',
      body: { ok: true },
    })
    const absent = jsonEntry({ id: 'absent', bodyAbsent: true })

    // Act / Assert — a `+json` type is JSON and survives; a body the archive
    // did not carry is not something the anonymize drops.
    const log = logOf([html, json, absent])
    expect(droppedBodyCount(log)).toBe(1)
    expect(jsonBodyCount(log)).toBe(1)
  })
})

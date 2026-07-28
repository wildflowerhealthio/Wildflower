import { Effect } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'
import { arbitraries, jsonBody, traceExchange } from 'web-trace-core/test-helpers'

import { buildExportPreview, droppedBodyCount, sampleLeaves } from './redaction-preview.ts'

/**
 * The preview is the pseudonymizer's own output, not a second implementation.
 * That is the property these tests exist to hold: the `after` a reviewer reads
 * is sampled from what `redactSession` produced, and the very same exchanges
 * are what the download emits.
 */

const SALT = 'test-salt-not-minted'

const fc$ = arbitraries(fc)

/**
 * `count` exchanges sharing one `status` and each carrying a distinct `mrn`.
 *
 * @remarks
 * The corpus the enum carve-out is actually about. A single exchange makes
 * every path one-distinct-valued, so it carves *everything* out — which is
 * correct behaviour and useless for testing the split.
 */
const manyMrns = (count: number): readonly ReturnType<typeof traceExchange>[] =>
  Array.from({ length: count }, (_unused, index) =>
    traceExchange({
      sessionId: 'morning',
      requestId: `req-${index}`,
      body: {
        _tag: 'StoredBody',
        contentType: 'application/json',
        size: 40,
        hash: 'aGFzaA==',
        data: jsonBody({
          mrn: `883-11-${String(index).padStart(4, '0')}`,
          status: 'active',
        }),
      },
    })
  )

describe('buildExportPreview', () => {
  it('should show a before and an after for every path the policy decided on', async () => {
    // Arrange
    const exchanges = [
      traceExchange({
        sessionId: 'morning',
        requestId: 'a',
        url: 'https://portal.example.org/api/v2/patients/10432',
        body: {
          _tag: 'StoredBody',
          contentType: 'application/json',
          size: 40,
          hash: 'aGFzaA==',
          data: jsonBody({ mrn: '883-11-4520', status: 'active' }),
        },
      }),
    ]

    // Act
    const preview = await Effect.runPromise(buildExportPreview(exchanges, { salt: SALT }))

    // Assert — every row is reviewable: a path with no `before` would be a row
    // a reader cannot act on.
    expect(preview.rows.length).toBeGreaterThan(0)
    expect(preview.rows.every((row) => row.before !== null)).toBe(true)
    expect(preview.rows.every((row) => row.after !== null)).toBe(true)
  })

  it('should show a pseudonymized path changing and a verbatim path unchanged', async () => {
    // Arrange — the carve-out counts *distinct values across the session*, not
    // what a field is called: `status` holds one value across twenty exchanges
    // and carves out, `mrn` holds twenty and does not.
    const exchanges = manyMrns(20)

    // Act
    const preview = await Effect.runPromise(buildExportPreview(exchanges, { salt: SALT }))

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
    const exchanges = manyMrns(20)
    const hidden = await Effect.runPromise(buildExportPreview(exchanges, { salt: SALT }))
    const mrnPath = hidden.rows.find((row) => row.path.endsWith('mrn'))?.path
    if (mrnPath === undefined) throw new Error('expected an mrn path')

    // Act
    const revealed = await Effect.runPromise(
      buildExportPreview(exchanges, { salt: SALT, overrides: { [mrnPath]: 'verbatim' } })
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
    const exchanges = [
      traceExchange({
        sessionId: 'morning',
        requestId: 'a',
        body: {
          _tag: 'StoredBody',
          contentType: 'application/json',
          size: 20,
          hash: 'aGFzaA==',
          data: jsonBody({ status: 'active' }),
        },
      }),
    ]
    const auto = await Effect.runPromise(buildExportPreview(exchanges, { salt: SALT }))
    const statusPath = auto.rows.find((row) => row.path.endsWith('status'))?.path
    if (statusPath === undefined) throw new Error('expected a status path')

    // Act
    const overridden = await Effect.runPromise(
      buildExportPreview(exchanges, { salt: SALT, overrides: { [statusPath]: 'pseudonymize' } })
    )

    // Assert
    const row = overridden.rows.find((one) => one.path === statusPath)
    expect(row?.verbatim).toBe(false)
    expect(row?.decidedBy).toBe('override')
    expect(row?.after).not.toBe('active')
  })

  it('should stop carving out at all when the carve-out is turned off', async () => {
    // Arrange
    const exchanges = [
      traceExchange({
        sessionId: 'morning',
        requestId: 'a',
        body: {
          _tag: 'StoredBody',
          contentType: 'application/json',
          size: 20,
          hash: 'aGFzaA==',
          data: jsonBody({ status: 'active' }),
        },
      }),
    ]

    // Act
    const preview = await Effect.runPromise(
      buildExportPreview(exchanges, { salt: SALT, enumCarveOut: false })
    )

    // Assert — nothing is verbatim, and every row says the carve-out is what
    // is off rather than that the threshold rejected it.
    expect(preview.rows.every((row) => !row.verbatim)).toBe(true)
    expect(preview.rows.every((row) => row.decidedBy === 'disabled')).toBe(true)
  })

  it('should show a structural leaf passing through unchanged, since the core never rewrites one', async () => {
    // Arrange — `null`, booleans, and the empty string are *structure*, not
    // data: `redactExchange` passes them through whatever the policy says,
    // because they carry no identity. Stated here rather than merely excluded
    // from the property below, so the behaviour is documented instead of a gap.
    const exchanges = [
      traceExchange({
        sessionId: 'morning',
        requestId: 'a',
        body: {
          _tag: 'StoredBody',
          contentType: 'application/json',
          size: 40,
          hash: 'aGFzaA==',
          data: jsonBody({ id: null, deceased: false, note: '' }),
        },
      }),
    ]

    // Act
    const preview = await Effect.runPromise(
      buildExportPreview(exchanges, { salt: SALT, enumCarveOut: false })
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

  it('should never show an after equal to the before for a value that carries identity', async () => {
    // Arrange — the guarantee the whole preview rests on. A row that claims a
    // value is hidden while showing it unchanged would mislead exactly the
    // reviewer the preview exists for.
    //
    // `null`, `true`/`false`, and `''` are excluded because the core preserves
    // them by design (see the test above). The exclusion is by sampled text, so
    // a *string* leaf whose value is literally `"null"` is skipped too — a
    // false negative worth the simplicity, since it cannot mask a real one:
    // every other value on the path is still checked on other runs.
    const structural: ReadonlySet<string> = new Set(['null', 'true', 'false', ''])
    await fc.assert(
      fc.asyncProperty(fc$.session, async (exchanges) => {
        // Act
        const preview = await Effect.runPromise(
          buildExportPreview(exchanges, { salt: SALT, enumCarveOut: false })
        )

        // Assert — with the carve-out off, every row is pseudonymized, and the
        // core re-derives each candidate until it differs from its original,
        // so this holds at every value length rather than only long ones.
        for (const row of preview.rows) {
          if (row.before !== null && row.after !== null && !structural.has(row.before)) {
            expect(row.after).not.toBe(row.before)
          }
        }
      }),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })

  it('should hand back the exchanges it previewed, so the archive cannot differ from the review', async () => {
    // Arrange
    await fc.assert(
      fc.asyncProperty(fc$.session, async (exchanges) => {
        // Act
        const preview = await Effect.runPromise(buildExportPreview(exchanges, { salt: SALT }))

        // Assert — same count, same order, same identities. This is what lets
        // the panel emit `preview.redacted` rather than re-redacting at
        // download time and hoping the two agree.
        expect(preview.redacted).toHaveLength(exchanges.length)
        expect(preview.redacted.map((one) => one.requestId)).toEqual(
          exchanges.map((one) => one.requestId)
        )
      }),
      { numRuns: numRunsFor({ base: 25 }) }
    )
  })

  it('should sample the after values from the redacted exchanges themselves', async () => {
    // Arrange — the anti-second-implementation test. Whatever the preview shows
    // as `after` must be findable in what the redactor produced; a row computed
    // some other way would drift from the archive without anything catching it.
    const exchanges = [
      traceExchange({
        sessionId: 'morning',
        requestId: 'a',
        url: 'https://portal.example.org/api/v2/patients/10432',
        body: {
          _tag: 'StoredBody',
          contentType: 'application/json',
          size: 60,
          hash: 'aGFzaA==',
          data: jsonBody({ mrn: '883-11-4520', name: 'Ada Lovelace' }),
        },
      }),
    ]

    // Act
    const preview = await Effect.runPromise(buildExportPreview(exchanges, { salt: SALT }))
    const fromRedacted = await Effect.runPromise(sampleLeaves(preview.redacted))

    // Assert
    for (const row of preview.rows) {
      if (row.after !== null) expect(fromRedacted.get(row.path)).toBe(row.after)
    }
  })
})

describe('droppedBodyCount', () => {
  it('should count stored non-JSON bodies and nothing else', () => {
    // Arrange
    const html = traceExchange({
      requestId: 'html',
      body: {
        _tag: 'StoredBody',
        contentType: 'text/html; charset=utf-8',
        size: 10,
        hash: 'aA==',
        data: jsonBody('<p/>'),
      },
    })
    const json = traceExchange({
      requestId: 'json',
      body: {
        _tag: 'StoredBody',
        contentType: 'application/fhir+json',
        size: 10,
        hash: 'aA==',
        data: jsonBody({}),
      },
    })
    const skipped = traceExchange({
      requestId: 'skipped',
      body: {
        _tag: 'SkippedBody',
        contentType: 'video/mp4',
        size: 900,
        hash: 'aA==',
        reason: 'over the size cap',
      },
    })

    // Act / Assert — a `+json` type is JSON and survives; a body the capture
    // already declined to store is not something the export drops.
    expect(droppedBodyCount([html, json, skipped])).toBe(1)
  })
})

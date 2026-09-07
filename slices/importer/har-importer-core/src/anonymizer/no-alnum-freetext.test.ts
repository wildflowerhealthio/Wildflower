import { readFileSync } from 'node:fs'

import { DateTime, Effect, Exit, Schema } from 'effect'
import { describe, expect, it } from 'vite-plus/test'

import { HttpArchive } from '../har/index.ts'
import { mintExportSalt } from './hmac.ts'
import { mapEntryLeaves, type LeafVisitor } from './leaves.ts'
import { buildPolicyForLog, redactLog } from './redact.ts'

// Regression coverage for a `freeText` value with no digits or letters —
// the Accept-header wildcard, three colons, three dashes. Every candidate
// the derivation loop produces is byte-identical to the original
// (mapCharClasses only rewrites [A-Za-z0-9]), so before the passthrough
// branch, the loop ran out of attempts and failed the whole anonymize with
// a PseudonymSpaceExhausted on a value that carries nothing to redact.
//
// The user-supplied HAR (../../test-fixtures/readme-httpbin.har.json) is
// the on-the-wire reproduction: a ReadMe-emitted archive of a POST to
// httpbin.org whose response headers carry the Accept wildcard. The
// synthetic fixture pins the exact HAR shape and lets the tests describe
// the failure without a file.
const readmeHarFixture = readFileSync(
  new URL('../../test-fixtures/readme-httpbin.har.json', import.meta.url),
  'utf8'
)

const DEFAULT_OPTIONS = {
  enumCarveOut: false,
  enumThreshold: 12,
  namespaceUris: false,
  overrides: {} as Readonly<Record<string, never>>,
}

/** Build a policy over `log`, redact it, and return the exit. */
const runRedact = (log: HttpArchive.Log): Promise<Exit.Exit<HttpArchive.Log, unknown>> =>
  Effect.runPromiseExit(
    Effect.gen(function* () {
      const salt = yield* mintExportSalt
      const policy = yield* buildPolicyForLog(log, { salt, ...DEFAULT_OPTIONS })
      return yield* redactLog(policy, log)
    })
  )

/** Every leaf value in `log`, keyed by the redactor's own path scheme. */
const collectLeaves = async (log: HttpArchive.Log): Promise<Map<string, string>> => {
  const values = new Map<string, string>()
  const visitor: LeafVisitor<never> = {
    visitString: (path, value) =>
      Effect.sync(() => {
        values.set(path, value)
        return value
      }),
    visitJsonLeaf: (path, value) =>
      Effect.sync(() => {
        values.set(path, typeof value === 'string' ? value : JSON.stringify(value))
        return value
      }),
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      for (const entry of log.entries) yield* mapEntryLeaves(entry, visitor)
    })
  )
  return values
}

/**
 * A minimal HAR log with one JSON response body whose sole leaf is
 * `headerValue`. A body leaf — unlike an `Accept` header, which the
 * redactor passes through as structural — goes through pseudonymization,
 * which is the path the exhaustion arises on.
 */
const oneEntryLogWithBodyLeaf = (headerValue: string): HttpArchive.Log => {
  const bodyText = JSON.stringify({ v: headerValue })
  return {
    version: '1.2',
    entries: [
      {
        id: 'har-entry-0',
        url: 'https://example.com/',
        method: 'GET',
        status: 200,
        statusText: 'OK',
        headers: [['content-type', 'application/json']],
        startedAt: DateTime.unsafeMake('2026-09-05T00:00:00.000Z'),
        body: new TextEncoder().encode(bodyText),
        bodyAbsent: false,
      },
    ],
  }
}

describe('freeText with no digits or letters', () => {
  it('passes an "*/*" header value through the redactor without exhausting', async () => {
    const log = oneEntryLogWithBodyLeaf('*/*')
    const exit = await runRedact(log)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const leaves = await collectLeaves(exit.value)
      expect([...leaves.values()]).toContain('*/*')
    }
  })

  it('passes structural-only values through unchanged (":::", "---", "  ")', async () => {
    const values = [':::', '---', '  ', '.', '*/*']
    const outcomes = await Promise.all(
      values.map(async (value) => {
        const exit = await runRedact(oneEntryLogWithBodyLeaf(value))
        const leaves = Exit.isSuccess(exit) ? await collectLeaves(exit.value) : null
        return { value, exit, leaves }
      })
    )
    for (const { value, exit, leaves } of outcomes) {
      expect(Exit.isSuccess(exit), `redactor exhausted on ${JSON.stringify(value)}`).toBe(true)
      expect(
        leaves === null ? [] : [...leaves.values()],
        `${JSON.stringify(value)} did not survive`
      ).toContain(value)
    }
  })

  it('still redacts a freeText value that mixes structure with any alnum', async () => {
    // A single letter is enough substitutable content, so the redactor must
    // not passthrough — the fake will differ from the original.
    const log = oneEntryLogWithBodyLeaf('*/a')
    const exit = await runRedact(log)
    expect(Exit.isSuccess(exit)).toBe(true)
    if (Exit.isSuccess(exit)) {
      const leaves = await collectLeaves(exit.value)
      expect([...leaves.values()]).not.toContain('*/a')
    }
  })

  it("succeeds end-to-end on the user's ReadMe/httpbin HAR archive", async () => {
    const log = Schema.decodeUnknownSync(HttpArchive.LogFromHarJson)(readmeHarFixture)
    const exit = await runRedact(log)
    expect(Exit.isSuccess(exit)).toBe(true)
  })
})

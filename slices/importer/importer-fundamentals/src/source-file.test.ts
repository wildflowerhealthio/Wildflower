import { Effect, Encoding, TestContext } from 'effect'
import * as fc from 'fast-check'
import { numRunsFor } from 'kitchen-sink/test'
import { describe, expect, it } from 'vite-plus/test'

import * as SourceFile from './source-file.ts'

describe('SourceFile reference', () => {
  it('property: the id round-trips through makeReference/idFromReference', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (id) => {
        expect(SourceFile.idFromReference(SourceFile.makeReference(id))).toBe(id)
      }),
      { numRuns: numRunsFor({ base: 100 }) }
    )
  })
})

// ---------------------------------------------------------------------------
// The codec, under a format context of its own
// ---------------------------------------------------------------------------

const SYSTEM = 'https://example.test/fhir/CodeSystem/source-file'

const exampleFormat: SourceFile.FormatContext['Type'] = {
  coding: { system: SYSTEM, code: 'example-source-file' },
  contentType: 'application/json',
  securityLabel: [{ system: 'https://example.test/fhir/CodeSystem/redaction', code: 'raw' }],
  descriptionPrefix: 'Example source file: ',
}

/** The same codec bound to a second format — what "another format's document" means below. */
const otherFormat: SourceFile.FormatContext['Type'] = {
  ...exampleFormat,
  coding: { system: 'https://other.test/fhir/CodeSystem/source-file', code: 'other-source-file' },
}

const runAs = <A, E>(
  format: SourceFile.FormatContext['Type'],
  effect: Effect.Effect<A, E, SourceFile.FormatContext>
): Promise<A> =>
  Effect.runPromise(
    effect.pipe(
      Effect.provideService(SourceFile.FormatContext, format),
      Effect.provide(TestContext.TestContext)
    )
  )

const run = <A, E>(effect: Effect.Effect<A, E, SourceFile.FormatContext>): Promise<A> =>
  runAs(exampleFormat, effect)

const mint = (fileName: string, bytes: Uint8Array): Promise<SourceFile.Type> =>
  run(SourceFile.tryFromNamedBytes({ fileName, bytes }))

const nameArbitrary = fc.stringMatching(/^[a-z0-9]{1,8}\.bin$/u)

describe('tryFromNamedBytes — the deterministic mint', () => {
  it('property: the id is decided by the bytes and the name together, and by nothing else', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.uint8Array({ maxLength: 64 }),
        nameArbitrary,
        fc.uint8Array({ maxLength: 64 }),
        nameArbitrary,
        async (bytesHere, nameHere, bytesThere, nameThere) => {
          const here = await mint(nameHere, bytesHere)
          const there = await mint(nameThere, bytesThere)
          const sameFile =
            nameHere === nameThere &&
            Encoding.encodeBase64(bytesHere) === Encoding.encodeBase64(bytesThere)
          expect(here.id === there.id).toBe(sameFile)
        }
      ),
      { numRuns: numRunsFor({ base: 40 }) }
    )
  })

  it('namespaces the id by the coding system, so two formats never collide', async () => {
    const picked = { fileName: 'report.bin', bytes: new TextEncoder().encode('shared') }
    const here = await runAs(exampleFormat, SourceFile.tryFromNamedBytes(picked))
    const there = await runAs(otherFormat, SourceFile.tryFromNamedBytes(picked))
    expect(here.id).not.toBe(there.id)
  })

  it('keeps the name and the bytes verbatim', async () => {
    const bytes = new Uint8Array([0, 255, 128])
    const sourceFile = await mint('binary.bin', bytes)
    expect(sourceFile.fileName).toBe('binary.bin')
    expect(sourceFile.bytes).toEqual(bytes)
  })
})
